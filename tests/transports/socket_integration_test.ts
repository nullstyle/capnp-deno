import {
  createRpcServiceToken,
  EMPTY_STRUCT_MESSAGE,
  ReconnectingRpcClientTransport,
  type RpcPeer,
  RpcSession,
  type RpcTransport,
  TCP,
  TcpRpcClientTransport,
  TcpTransport,
  TransportError,
  WasmPeer,
  WebSocketTransport,
  WS,
} from "../../src/advanced.ts";
import { FakeCapnpWasm } from "../fake_wasm.ts";
import {
  assert,
  assertBytes,
  assertEquals,
  deferred,
  withTimeout,
} from "../test_utils.ts";

const EMPTY_RPC_PARAMS = EMPTY_STRUCT_MESSAGE;

function buildSingleSegmentFrame(firstByte: number): Uint8Array {
  const frame = new Uint8Array(16);
  const view = new DataView(frame.buffer);
  view.setUint32(0, 0, true); // segmentCountMinusOne
  view.setUint32(4, 1, true); // one word
  frame[8] = firstByte & 0xff;
  return frame;
}

function makeServerPeer(responseFrame: Uint8Array): WasmPeer {
  const fake = new FakeCapnpWasm({
    onPushFrame: (_incoming) => [responseFrame],
  });
  return WasmPeer.fromExports(fake.exports);
}

function makeClientPeer(onFrame: (frame: Uint8Array) => void): WasmPeer {
  const fake = new FakeCapnpWasm({
    onPushFrame: (incoming) => {
      onFrame(new Uint8Array(incoming));
      return [];
    },
  });
  return WasmPeer.fromExports(fake.exports);
}

async function closeAll(
  transports: RpcTransport[],
  sessions: RpcSession[],
): Promise<void> {
  for (const session of sessions) {
    try {
      await session.close();
    } catch (_err) {
      // ignore teardown errors
    }
  }
  for (const transport of transports) {
    try {
      await transport.close();
    } catch (_err) {
      // ignore teardown errors
    }
  }
}

Deno.test("WebSocketTransport loopback e2e with RpcSession", async () => {
  const expectedResponse = buildSingleSegmentFrame(0x7b);
  const inboundSeen = deferred<Uint8Array>();
  const serverSessionReady = deferred<void>();
  const serverSessionError = deferred<unknown>();
  const sessions: RpcSession[] = [];
  const transports: RpcTransport[] = [];

  const ac = new AbortController();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: ac.signal,
    onListen: () => {},
  }, (req) => {
    const { socket, response } = Deno.upgradeWebSocket(req);
    const transport = new WebSocketTransport(socket, {
      onError: (err) => serverSessionError.resolve(err),
    });
    const peer = makeServerPeer(expectedResponse);
    const session = new RpcSession(peer, transport, {
      onError: (err) => serverSessionError.resolve(err),
    });
    sessions.push(session);
    transports.push(transport);
    void session.start().then(
      () => serverSessionReady.resolve(),
      (err) => serverSessionError.resolve(err),
    );
    return response;
  });

  try {
    const addr = server.addr as Deno.NetAddr;
    const clientTransport = await WebSocketTransport.connect(
      `ws://${addr.hostname}:${addr.port}`,
    );
    transports.push(clientTransport);

    const clientPeer = makeClientPeer((frame) => inboundSeen.resolve(frame));
    const clientSession = new RpcSession(clientPeer, clientTransport);
    sessions.push(clientSession);
    await clientSession.start();

    await withTimeout(
      serverSessionReady.promise,
      2000,
      "server websocket session start",
    );
    await clientTransport.send(buildSingleSegmentFrame(0x44));

    const got = await withTimeout(
      inboundSeen.promise,
      2000,
      "websocket inbound response",
    );
    assertBytes(got, Array.from(expectedResponse));

    const maybeErr = await Promise.race([
      serverSessionError.promise.then((err) => err),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20)),
    ]);
    assertEquals(maybeErr, null, "server websocket session should not error");
  } finally {
    await closeAll(transports, sessions);
    ac.abort();
    await server.finished.catch(() => {});
  }
});

Deno.test("TcpTransport loopback e2e with RpcSession", async () => {
  const expectedResponse = buildSingleSegmentFrame(0x5a);
  const inboundSeen = deferred<Uint8Array>();
  const sessions: RpcSession[] = [];
  const transports: RpcTransport[] = [];
  const serverSessionError = deferred<unknown>();

  const listener = Deno.listen({
    hostname: "127.0.0.1",
    port: 0,
    transport: "tcp",
  });

  const serverAccept = (async () => {
    const conn = await listener.accept();
    const transport = new TcpTransport(conn, {
      onError: (err) => serverSessionError.resolve(err),
    });
    transports.push(transport);

    const peer = makeServerPeer(expectedResponse);
    const session = new RpcSession(peer, transport, {
      onError: (err) => serverSessionError.resolve(err),
    });
    sessions.push(session);
    await session.start();
  })();

  try {
    const addr = listener.addr as Deno.NetAddr;
    const clientTransport = await TcpTransport.connect(
      addr.hostname,
      addr.port,
    );
    transports.push(clientTransport);

    const clientPeer = makeClientPeer((frame) => inboundSeen.resolve(frame));
    const clientSession = new RpcSession(clientPeer, clientTransport);
    sessions.push(clientSession);
    await clientSession.start();

    await serverAccept;
    await clientTransport.send(buildSingleSegmentFrame(0x12));

    const got = await withTimeout(
      inboundSeen.promise,
      2000,
      "tcp inbound response",
    );
    assertBytes(got, Array.from(expectedResponse));

    const maybeErr = await Promise.race([
      serverSessionError.promise.then((err) => err),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20)),
    ]);
    assertEquals(maybeErr, null, "server tcp session should not error");
  } finally {
    listener.close();
    await closeAll(transports, sessions);
  }
});

function reserveTcpPort(): number {
  const listener = Deno.listen({
    transport: "tcp",
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    return (listener.addr as Deno.NetAddr).port;
  } finally {
    listener.close();
  }
}

function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("websocket failed to open"));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("websocket closed before open"));
    };
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };

    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onClose, { once: true });
  });
}

async function waitForPromiseOrTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

function immediateReconnectOptions() {
  return {
    policy: {
      shouldRetry: (_ctx: unknown) => true,
      nextDelayMs: (_ctx: unknown) => 0,
    },
    sleep: async (_delayMs: number) => {
      // no-op for deterministic tests
    },
  };
}

Deno.test("TCP.serve disposes constructor instances on peer disconnect", async () => {
  const connected = deferred<RpcPeer>();
  const disposed = deferred<RpcPeer>();

  class DisposableServer {
    readonly peer: RpcPeer;

    constructor(peer: RpcPeer) {
      this.peer = peer;
      connected.resolve(peer);
    }

    [Symbol.dispose](): void {
      disposed.resolve(this.peer);
    }
  }

  const service = createRpcServiceToken<
    Record<string, never>,
    DisposableServer
  >({
    interfaceId: 0x77n,
    interfaceName: "DisposeProbe",
    bootstrapClient: () => Promise.resolve({}),
    registerServer: () => ({ capabilityIndex: 0 }),
  });

  const port = reserveTcpPort();
  const handle = TCP.serve(service, "127.0.0.1", port, DisposableServer);

  let conn: Deno.Conn | null = null;
  try {
    conn = await Deno.connect({
      transport: "tcp",
      hostname: "127.0.0.1",
      port,
    });

    await withTimeout(connected.promise, 2000, "server connect callback");

    conn.close();
    conn = null;

    await withTimeout(disposed.promise, 2000, "server dispose callback");
  } finally {
    try {
      conn?.close();
    } catch {
      // no-op
    }
    await handle.close();
  }
});

Deno.test("WS.serve disposes constructor instances on peer disconnect", async () => {
  const connected = deferred<RpcPeer>();
  const disposed = deferred<RpcPeer>();

  class DisposableServer {
    readonly peer: RpcPeer;

    constructor(peer: RpcPeer) {
      this.peer = peer;
      connected.resolve(peer);
    }

    [Symbol.dispose](): void {
      disposed.resolve(this.peer);
    }
  }

  const service = createRpcServiceToken<
    Record<string, never>,
    DisposableServer
  >({
    interfaceId: 0x88n,
    interfaceName: "WsDisposeProbe",
    bootstrapClient: () => Promise.resolve({}),
    registerServer: () => ({ capabilityIndex: 0 }),
  });

  const port = reserveTcpPort();
  const handle = WS.serve(service, "127.0.0.1", port, DisposableServer, {
    path: "/rpc",
    protocols: ["capnp-rpc"],
  });

  let socket: WebSocket | null = null;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, "capnp-rpc");
    await withTimeout(waitForWebSocketOpen(socket), 2000, "ws connect");
    await withTimeout(connected.promise, 2000, "ws server connect callback");

    socket.close();
    socket = null;

    await withTimeout(disposed.promise, 2000, "ws server dispose callback");
  } finally {
    try {
      socket?.close();
    } catch {
      // no-op
    }
    await handle.close();
  }
});

Deno.test("WS.connect forwards sub-protocols for handshake", async () => {
  class NoopServer {
    constructor(_peer: RpcPeer) {}
  }

  const service = createRpcServiceToken<
    Record<string, never>,
    NoopServer
  >({
    interfaceId: 0x99n,
    interfaceName: "WsConnectProbe",
    bootstrapClient: () => Promise.resolve({}),
    registerServer: () => ({ capabilityIndex: 0 }),
  });

  const port = reserveTcpPort();
  const handle = WS.serve(service, "127.0.0.1", port, NoopServer, {
    path: "/rpc",
    protocols: ["capnp-rpc"],
  });

  let client: { close(): Promise<void> } | null = null;
  try {
    client = await WS.connect(service, `ws://127.0.0.1:${port}/rpc`, {
      protocols: ["other-rpc", "capnp-rpc"],
    });
    await client.close();
    client = null;

    let handshakeRejected = false;
    try {
      const unexpectedClient = await WS.connect(
        service,
        `ws://127.0.0.1:${port}/rpc`,
        {
          protocols: ["other-rpc"],
        },
      );
      await unexpectedClient.close();
    } catch {
      handshakeRejected = true;
    }
    assertEquals(
      handshakeRejected,
      true,
      "expected websocket handshake rejection for unsupported protocol",
    );
  } finally {
    await client?.close().catch(() => {});
    await handle.close();
  }
});

Deno.test("WS.connect bootstraps through WS.serve runtime root wiring", async () => {
  const service = createRpcServiceToken<
    { rootCapabilityIndex: number },
    Record<string, never>
  >({
    interfaceId: 0x120n,
    interfaceName: "WsBootstrapProbe",
    bootstrapClient: async (transport) => {
      const capability = await transport.bootstrap();
      return {
        rootCapabilityIndex: capability.capabilityIndex,
      };
    },
    registerServer: (registry, _server, options) =>
      registry.exportCapability({
        interfaceId: 0x120n,
        dispatch: () => new Uint8Array(),
      }, options),
  });

  const port = reserveTcpPort();
  const handle = WS.serve(service, "127.0.0.1", port, {}, {
    path: "/rpc",
  });

  const client = await withTimeout(
    WS.connect(service, `ws://127.0.0.1:${port}/rpc`),
    2000,
    "ws connect with bootstrap",
  );
  try {
    assertEquals(client.rootCapabilityIndex, 0);
  } finally {
    await client.close();
    await handle.close();
  }
});

Deno.test("WS.handler composes with sibling HTTP routes", async () => {
  const service = createRpcServiceToken<
    { rootCapabilityIndex: number },
    Record<string, never>
  >({
    interfaceId: 0x123n,
    interfaceName: "WsHandlerComposeProbe",
    bootstrapClient: async (transport) => {
      const capability = await transport.bootstrap();
      return {
        rootCapabilityIndex: capability.capabilityIndex,
      };
    },
    registerServer: (registry, _server, options) =>
      registry.exportCapability({
        interfaceId: 0x123n,
        dispatch: () => new Uint8Array(),
      }, options),
  });

  const port = reserveTcpPort();
  const wsHandler = WS.handler(service, {}, {
    protocols: ["capnp-rpc"],
  });
  const abortController = new AbortController();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port,
    signal: abortController.signal,
    onListen: () => {},
  }, (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/rpc") {
      return wsHandler.handle(request);
    }
    if (url.pathname === "/api") {
      return new Response("capnweb-route-placeholder");
    }
    return new Response("not found", { status: 404 });
  });

  let client: { rootCapabilityIndex: number; close(): Promise<void> } | null =
    null;
  try {
    const apiResponse = await fetch(`http://127.0.0.1:${port}/api`);
    assertEquals(apiResponse.status, 200);
    assertEquals(await apiResponse.text(), "capnweb-route-placeholder");

    client = await withTimeout(
      WS.connect(service, `ws://127.0.0.1:${port}/rpc`, {
        protocols: ["capnp-rpc"],
      }),
      2000,
      "ws handler connect with bootstrap",
    );
    assertEquals(client.rootCapabilityIndex, 0);
  } finally {
    await client?.close().catch(() => {});
    abortController.abort();
    await server.finished.catch(() => {});
    await wsHandler.close();
  }
});

Deno.test("WS.handler enforces handshake and path checks", async () => {
  const service = createRpcServiceToken<
    Record<string, never>,
    Record<string, never>
  >({
    interfaceId: 0x124n,
    interfaceName: "WsHandlerValidationProbe",
    bootstrapClient: () => Promise.resolve({}),
    registerServer: () => ({ capabilityIndex: 0 }),
  });

  const wsHandler = WS.handler(service, {}, {
    path: "/rpc",
    protocols: ["capnp-rpc"],
  });

  try {
    const notUpgrade = await wsHandler.handle(
      new Request("http://127.0.0.1/rpc"),
    );
    assertEquals(notUpgrade.status, 426);

    const pathMismatch = await wsHandler.handle(
      new Request("http://127.0.0.1/other", {
        headers: {
          upgrade: "websocket",
          "sec-websocket-protocol": "capnp-rpc",
        },
      }),
    );
    assertEquals(pathMismatch.status, 404);
  } finally {
    await wsHandler.close();
  }
});

Deno.test("WS.serve reports websocket upgrade failures via onConnectionError", async () => {
  const connectionError = deferred<unknown>();
  const service = createRpcServiceToken<
    Record<string, never>,
    Record<string, never>
  >({
    interfaceId: 0x121n,
    interfaceName: "WsInitFailureProbe",
    bootstrapClient: () => Promise.resolve({}),
    registerServer: () => {
      throw new Error("register server failure");
    },
  });

  const port = reserveTcpPort();
  const handle = WS.serve(service, "127.0.0.1", port, {}, {
    path: "/rpc",
    onConnectionError: (error) => {
      connectionError.resolve(error);
    },
  });

  let conn: Deno.Conn | null = null;
  try {
    conn = await Deno.connect({
      transport: "tcp",
      hostname: "127.0.0.1",
      port,
    });
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const request = [
      "GET /rpc HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "",
      "",
    ].join("\r\n");
    await conn.write(encoder.encode(request));

    const responseBytes = new Uint8Array(1024);
    const count = await conn.read(responseBytes);
    assert(count !== null && count > 0, "expected HTTP response bytes");
    const response = decoder.decode(responseBytes.subarray(0, count));
    assert(
      / 400 /.test(response),
      `expected 400 response for invalid websocket upgrade, got: ${response}`,
    );

    const error = await withTimeout(
      connectionError.promise,
      2000,
      "ws upgrade error callback",
    );
    assert(
      error instanceof Error,
      `expected websocket upgrade error object, got: ${String(error)}`,
    );
  } finally {
    try {
      conn?.close();
    } catch {
      // no-op
    }
    await handle.close();
  }
});

Deno.test("WS.serve forwards transport frame-limit failures to transport.onError", async () => {
  const transportError = deferred<unknown>();
  const service = createRpcServiceToken<
    Record<string, never>,
    Record<string, never>
  >({
    interfaceId: 0x122n,
    interfaceName: "WsFrameLimitProbe",
    bootstrapClient: () => Promise.resolve({}),
    registerServer: (registry, _server, options) =>
      registry.exportCapability({
        interfaceId: 0x122n,
        dispatch: () => new Uint8Array(),
      }, options),
  });

  const port = reserveTcpPort();
  const handle = WS.serve(service, "127.0.0.1", port, {}, {
    path: "/rpc",
    transport: {
      frameLimits: {
        maxFrameBytes: 8,
      },
      onError: (error) => {
        transportError.resolve(error);
      },
    },
  });

  let socket: WebSocket | null = null;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
    await withTimeout(waitForWebSocketOpen(socket), 2000, "ws connect");

    for (let attempt = 0; attempt < 20; attempt += 1) {
      socket.send(buildSingleSegmentFrame(0x66));
      const observed = await waitForPromiseOrTimeout(
        transportError.promise.then(() => true),
        50,
      );
      if (observed) {
        break;
      }
    }

    const error = await withTimeout(
      transportError.promise,
      2000,
      "ws frame-limit transport error callback",
    );
    assert(
      error instanceof Error && /frame size/i.test(error.message),
      `expected frame size error, got: ${String(error)}`,
    );
  } finally {
    try {
      socket?.close();
    } catch {
      // no-op
    }
    await handle.close();
  }
});

Deno.test("ReconnectingRpcClientTransport retries bootstrap-cap calls over live WebSocket reconnect", async () => {
  let acceptedConnections = 0;

  class ReconnectRootServer {
    readonly connectionId: number;

    constructor(_peer: RpcPeer) {
      acceptedConnections += 1;
      this.connectionId = acceptedConnections;
    }
  }

  const service = createRpcServiceToken<
    Record<string, never>,
    ReconnectRootServer
  >({
    interfaceId: 0x130n,
    interfaceName: "WsReconnectBootstrapProbe",
    bootstrapClient: () => Promise.resolve({}),
    registerServer: (registry, _server, options) =>
      registry.exportCapability({
        interfaceId: 0x130n,
        dispatch: () => EMPTY_STRUCT_MESSAGE,
      }, options),
  });

  const port = reserveTcpPort();
  const handle = WS.serve(service, "127.0.0.1", port, ReconnectRootServer, {
    path: "/rpc",
  });

  let connectCount = 0;
  const outboundCapabilityIndexes: number[] = [];
  const reconnecting = new ReconnectingRpcClientTransport({
    connect: async () => {
      connectCount += 1;
      const ws = await WebSocketTransport.connect(`ws://127.0.0.1:${port}/rpc`);
      const inner = new TcpRpcClientTransport(ws, {
        interfaceId: 0x130n,
        defaultTimeoutMs: 250,
      });
      if (connectCount === 1) {
        return {
          bootstrap: (options) => inner.bootstrap(options),
          call: async () => {
            await inner.close();
            throw new TransportError("forced websocket reconnect");
          },
          close: () => inner.close(),
        };
      }
      return {
        bootstrap: (options) => inner.bootstrap(options),
        call: (capability, methodId, params, options) => {
          outboundCapabilityIndexes.push(capability.capabilityIndex);
          return inner.call(capability, methodId, params, options);
        },
        close: () => inner.close(),
      };
    },
    reconnect: immediateReconnectOptions(),
    bootstrapOptions: { timeoutMs: 250 },
  });

  try {
    const bootstrap = await withTimeout(
      reconnecting.bootstrap(),
      2000,
      "bootstrap capability",
    );
    const response = await reconnecting.call(
      bootstrap,
      0,
      EMPTY_RPC_PARAMS,
      { timeoutMs: 500 },
    );
    assertBytes(response, [...EMPTY_STRUCT_MESSAGE]);
    assertEquals(connectCount, 2);
    assertEquals(acceptedConnections, 2);
    assertEquals(outboundCapabilityIndexes.length, 1);
    assertEquals(outboundCapabilityIndexes[0], bootstrap.capabilityIndex);
  } finally {
    await reconnecting.close();
    await handle.close();
  }
});

Deno.test("ReconnectingRpcClientTransport remaps non-bootstrap capabilities over live WebSocket reconnect", async () => {
  let acceptedConnections = 0;

  class ReconnectRemapServer {
    constructor(_peer: RpcPeer) {
      acceptedConnections += 1;
    }
  }

  const service = createRpcServiceToken<
    Record<string, never>,
    ReconnectRemapServer
  >({
    interfaceId: 0x131n,
    interfaceName: "WsReconnectRemapProbe",
    bootstrapClient: () => Promise.resolve({}),
    registerServer: (registry, _server, options) =>
      registry.exportCapability({
        interfaceId: 0x131n,
        dispatch: () => EMPTY_STRUCT_MESSAGE,
      }, options),
  });

  const port = reserveTcpPort();
  const handle = WS.serve(service, "127.0.0.1", port, ReconnectRemapServer, {
    path: "/rpc",
  });

  let connectCount = 0;
  const outboundCapabilityIndexes: number[] = [];
  const remapContextHistory: Array<{
    capabilityIndex: number;
    previousBootstrapCapabilityIndex: number | null;
    currentBootstrapCapabilityIndex: number | null;
  }> = [];

  const reconnecting = new ReconnectingRpcClientTransport({
    connect: async () => {
      connectCount += 1;
      const ws = await WebSocketTransport.connect(`ws://127.0.0.1:${port}/rpc`);
      const inner = new TcpRpcClientTransport(ws, {
        interfaceId: 0x131n,
        defaultTimeoutMs: 250,
      });
      if (connectCount === 1) {
        return {
          bootstrap: (options) => inner.bootstrap(options),
          call: async (capability: { capabilityIndex: number }) => {
            if (capability.capabilityIndex === 5) {
              await inner.close();
              throw new TransportError("forced websocket reconnect");
            }
            return await inner.call(
              capability,
              0,
              EMPTY_RPC_PARAMS,
              { timeoutMs: 500 },
            );
          },
          close: () => inner.close(),
        };
      }
      return {
        bootstrap: (options) => inner.bootstrap(options),
        call: (capability, methodId, params, options) => {
          outboundCapabilityIndexes.push(capability.capabilityIndex);
          // The remap assertion target is the capability index selected for
          // retry; bootstrap/connect still run over live WebSockets.
          void methodId;
          void params;
          void options;
          return Promise.resolve(new Uint8Array(EMPTY_STRUCT_MESSAGE));
        },
        close: () => inner.close(),
      };
    },
    reconnect: immediateReconnectOptions(),
    bootstrapOptions: { timeoutMs: 250 },
    remapCapabilityOnReconnect: (context) => {
      remapContextHistory.push({
        capabilityIndex: context.capability.capabilityIndex,
        previousBootstrapCapabilityIndex:
          context.previousBootstrapCapability?.capabilityIndex ?? null,
        currentBootstrapCapabilityIndex:
          context.currentBootstrapCapability?.capabilityIndex ?? null,
      });
      return { capabilityIndex: 6 };
    },
  });

  try {
    await withTimeout(
      reconnecting.bootstrap(),
      2000,
      "bootstrap capability",
    );

    const response = await reconnecting.call(
      { capabilityIndex: 5 },
      0,
      EMPTY_RPC_PARAMS,
      { timeoutMs: 500 },
    );
    assertBytes(response, [...EMPTY_STRUCT_MESSAGE]);
    assertEquals(connectCount, 2);
    assertEquals(acceptedConnections, 2);
    assertEquals(outboundCapabilityIndexes.length, 1);
    assertEquals(outboundCapabilityIndexes[0], 6);
    assertEquals(remapContextHistory.length, 1);
    assertEquals(remapContextHistory[0].capabilityIndex, 5);
    assert(
      remapContextHistory[0].previousBootstrapCapabilityIndex !== null,
      "expected previous bootstrap capability in remap context",
    );
    assert(
      remapContextHistory[0].currentBootstrapCapabilityIndex !== null,
      "expected current bootstrap capability in remap context",
    );
  } finally {
    await reconnecting.close();
    await handle.close();
  }
});
