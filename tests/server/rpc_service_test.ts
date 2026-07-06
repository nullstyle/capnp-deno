import {
  connect,
  createRpcServiceToken,
  type RpcObservabilityEvent,
  RpcPeer,
  RpcServerRuntime,
  serve,
  serveConnection,
  SessionError,
  WebTransportTransport,
} from "../../src/mod.ts";
import { AcceptedWebSocketTransport } from "../../src/rpc/transports/websocket.ts";
import { AcceptedWebTransportTransport } from "../../src/rpc/transports/webtransport.ts";
import { assert, assertEquals, deferred, withTimeout } from "../test_utils.ts";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  binaryType: BinaryType = "arraybuffer";
  bufferedAmount = 0;

  send(_data: BufferSource): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("socket not open");
    }
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(
      new CloseEvent("close", { code: 1000, reason: "closed" }),
    );
  }
}

Deno.test("createRpcServiceToken returns a frozen token", () => {
  const token = createRpcServiceToken({
    interfaceId: 0x1234n,
    interfaceName: "Ping",
    bootstrapClient: () => Promise.resolve({ ping: () => Promise.resolve() }),
    registerServer: () => ({ capabilityIndex: 0 }),
  });

  assertEquals(token.interfaceId, 0x1234n);
  assertEquals(token.interfaceName, "Ping");
  assert(Object.isFrozen(token));
});

Deno.test("RpcPeer.close delegates to transport close", async () => {
  let closeCount = 0;
  const peer = new RpcPeer({
    role: "server",
    transport: {
      start() {},
      send() {},
      close() {
        closeCount += 1;
      },
    },
    remoteAddress: { hostname: "127.0.0.1", port: 4000, transport: "tcp" },
  });

  await peer.close();
  assertEquals(closeCount, 1);
  assertEquals(peer.toString(), "[RpcPeer server:127.0.0.1:4000]");
});

Deno.test("connect bootstraps over a started transport and adds stub lifecycle", async () => {
  let startCount = 0;
  let closeCount = 0;
  const transport = {
    start(): void {
      startCount += 1;
    },
    send(): Promise<void> {
      return Promise.resolve();
    },
    close(): Promise<void> {
      closeCount += 1;
      return Promise.resolve();
    },
  };

  const service = createRpcServiceToken({
    interfaceId: 0x2222n,
    interfaceName: "ConnectProbe",
    bootstrapClient: () =>
      Promise.resolve({
        ping(): Promise<void> {
          return Promise.resolve();
        },
      }),
    registerServer: () => ({ capabilityIndex: 0 }),
  });

  using client = await connect(service, transport);
  await client.ping();
  await client.close();

  assertEquals(startCount, 1);
  assertEquals(closeCount, 1);
});

Deno.test("serveConnection builds peer metadata for accepted transports", async () => {
  const originalCreateWithRoot = RpcServerRuntime.createWithRoot;
  const connectedPeer = deferred<RpcPeer>();
  const events: string[] = [];

  class ProbeServer {
    constructor(peer: RpcPeer) {
      connectedPeer.resolve(peer);
    }
  }

  (RpcServerRuntime as unknown as {
    createWithRoot: typeof RpcServerRuntime.createWithRoot;
  }).createWithRoot = (transport) =>
    Promise.resolve({
      close: async (): Promise<void> => {
        events.push("runtime.close");
        await transport.close();
      },
    } as RpcServerRuntime);

  const service = createRpcServiceToken<Record<string, never>, ProbeServer>({
    interfaceId: 0x166n,
    interfaceName: "ServeConnectionProbe",
    bootstrapClient: () => Promise.resolve({}),
    registerServer: () => ({ capabilityIndex: 0 }),
  });

  const accepted = {
    transport: {
      start(): void {
        // no-op
      },
      send(): Promise<void> {
        return Promise.resolve();
      },
      close(): Promise<void> {
        events.push("transport.close");
        return Promise.resolve();
      },
    },
    localAddress: {
      transport: "tcp",
      hostname: "127.0.0.1",
      port: 4000,
    },
    remoteAddress: {
      transport: "tcp",
      hostname: "127.0.0.1",
      port: 41234,
    },
    id: "server:127.0.0.1:41234",
  };

  try {
    using handle = await serveConnection(service, accepted, ProbeServer);
    const peer = await withTimeout(
      connectedPeer.promise,
      1000,
      "serveConnection connected peer",
    );
    assertEquals(handle.peer, peer);
    assertEquals(peer.localAddress?.transport, "tcp");
    assertEquals(peer.localAddress?.port, 4000);
    assertEquals(peer.remoteAddress?.transport, "tcp");
    assertEquals(peer.remoteAddress?.port, 41234);
    await handle.close();
  } finally {
    (RpcServerRuntime as unknown as {
      createWithRoot: typeof RpcServerRuntime.createWithRoot;
    }).createWithRoot = originalCreateWithRoot;
  }

  assert(events.includes("runtime.close"));
  assert(events.includes("transport.close"));
});

Deno.test("serveConnection closes accepted transport when an async factory rejects", async () => {
  let closeCount = 0;

  const service = createRpcServiceToken<Record<string, never>, object>({
    interfaceId: 0x188n,
    interfaceName: "ServeConnectionFactoryReject",
    bootstrapClient: () => Promise.resolve({}),
    registerServer: () => ({ capabilityIndex: 0 }),
  });

  const accepted = {
    transport: {
      start(): void {
        // no-op
      },
      send(): Promise<void> {
        return Promise.resolve();
      },
      close(): Promise<void> {
        closeCount += 1;
        return Promise.resolve();
      },
    },
    remoteAddress: {
      transport: "tcp",
      hostname: "127.0.0.1",
      port: 41236,
    },
  };

  let thrown: unknown;
  try {
    await serveConnection(
      service,
      accepted,
      () => Promise.reject(new Error("factory exploded")),
    );
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof Error && /factory exploded/i.test(thrown.message),
    `expected async factory rejection, got: ${String(thrown)}`,
  );
  assertEquals(closeCount, 1);
});

Deno.test("serveConnection disposes async-factory instances when a websocket closes before activation", async () => {
  const originalCreateWithRoot = RpcServerRuntime.createWithRoot;
  const pendingServer = deferred<AsyncDisposable & object>();
  let runtimeCreateCount = 0;
  let disposeCount = 0;

  class ProbeServer implements AsyncDisposable {
    [Symbol.asyncDispose](): Promise<void> {
      disposeCount += 1;
      return Promise.resolve();
    }
  }

  (RpcServerRuntime as unknown as {
    createWithRoot: typeof RpcServerRuntime.createWithRoot;
  }).createWithRoot = () => {
    runtimeCreateCount += 1;
    return Promise.resolve({
      close(): Promise<void> {
        return Promise.resolve();
      },
    } as RpcServerRuntime);
  };

  const service = createRpcServiceToken<Record<string, never>, ProbeServer>({
    interfaceId: 0x189n,
    interfaceName: "ServeConnectionWsCloseDuringFactory",
    bootstrapClient: () => Promise.resolve({}),
    registerServer: () => ({ capabilityIndex: 0 }),
  });

  const socket = new FakeWebSocket();
  const accepted = new AcceptedWebSocketTransport(
    socket as unknown as WebSocket,
    {
      localAddress: {
        transport: "websocket",
        hostname: "127.0.0.1",
        port: 8080,
        path: "/rpc",
      },
      remoteAddress: {
        transport: "websocket",
      },
      id: "test-key",
    },
  );

  try {
    const pendingHandle = serveConnection(service, accepted, async () => {
      return await pendingServer.promise as ProbeServer;
    });

    socket.close();
    pendingServer.resolve(new ProbeServer());

    let thrown: unknown;
    try {
      await pendingHandle;
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof Error &&
        /closed during initialization/i.test(thrown.message),
      `expected early websocket close to abort activation, got: ${
        String(thrown)
      }`,
    );
    assertEquals(runtimeCreateCount, 0);
    assertEquals(disposeCount, 1);
  } finally {
    (RpcServerRuntime as unknown as {
      createWithRoot: typeof RpcServerRuntime.createWithRoot;
    }).createWithRoot = originalCreateWithRoot;
  }
});

Deno.test("serve supervises accepted connections through the generic binder", async () => {
  const originalCreateWithRoot = RpcServerRuntime.createWithRoot;
  const connectedPeer = deferred<RpcPeer>();
  const acceptClosed = deferred<void>();
  const events: string[] = [];

  class ProbeServer {
    constructor(peer: RpcPeer) {
      connectedPeer.resolve(peer);
    }
  }

  (RpcServerRuntime as unknown as {
    createWithRoot: typeof RpcServerRuntime.createWithRoot;
  }).createWithRoot = (transport) =>
    Promise.resolve({
      close: async (): Promise<void> => {
        events.push("runtime.close");
        await transport.close();
      },
    } as RpcServerRuntime);

  const service = createRpcServiceToken<Record<string, never>, ProbeServer>({
    interfaceId: 0x177n,
    interfaceName: "ServeProbe",
    bootstrapClient: () => Promise.resolve({}),
    registerServer: () => ({ capabilityIndex: 0 }),
  });

  const transport = {
    start(): void {
      // no-op
    },
    send(): Promise<void> {
      return Promise.resolve();
    },
    close(): Promise<void> {
      events.push("transport.close");
      return Promise.resolve();
    },
  };

  const acceptor = {
    closed: false,
    async *accept() {
      yield {
        transport,
        localAddress: { transport: "tcp", hostname: "127.0.0.1", port: 4000 },
        remoteAddress: {
          transport: "tcp",
          hostname: "127.0.0.1",
          port: 41235,
        },
      };
      await acceptClosed.promise;
    },
    close(): void {
      acceptClosed.resolve();
    },
  };

  try {
    using handle = serve(
      service,
      acceptor,
      ({ peer }) => new ProbeServer(peer),
    );
    const peer = await withTimeout(connectedPeer.promise, 1000, "serve peer");
    assertEquals(peer.remoteAddress?.port, 41235);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assertEquals(handle.stats.closed, false);
    assertEquals(handle.stats.activeConnections, 1);
    assertEquals(handle.stats.acceptedConnections, 1);
    assertEquals(handle.stats.refusedConnections, 0);
    await handle.close();
    assertEquals(handle.stats.closed, true);
    assertEquals(handle.stats.activeConnections, 0);
  } finally {
    (RpcServerRuntime as unknown as {
      createWithRoot: typeof RpcServerRuntime.createWithRoot;
    }).createWithRoot = originalCreateWithRoot;
  }

  assert(events.includes("runtime.close"));
  assert(events.includes("transport.close"));
});

Deno.test("serve close waits for runtimes that finish initializing during shutdown", async () => {
  const originalCreateWithRoot = RpcServerRuntime.createWithRoot;
  const runtimeCreateStarted = deferred<void>();
  const releaseRuntimeCreate = deferred<void>();
  const acceptClosed = deferred<void>();
  const events: string[] = [];

  (RpcServerRuntime as unknown as {
    createWithRoot: typeof RpcServerRuntime.createWithRoot;
  }).createWithRoot = async (transport) => {
    runtimeCreateStarted.resolve();
    await releaseRuntimeCreate.promise;
    return {
      close: async (): Promise<void> => {
        events.push("runtime.close");
        await transport.close();
      },
    } as RpcServerRuntime;
  };

  const service = createRpcServiceToken<Record<string, never>, object>({
    interfaceId: 0x183n,
    interfaceName: "ServeCloseInitRaceProbe",
    bootstrapClient: () => Promise.resolve({}),
    registerServer: () => ({ capabilityIndex: 0 }),
  });

  const transport = {
    start(): void {
      // no-op
    },
    send(): Promise<void> {
      return Promise.resolve();
    },
    close(): Promise<void> {
      events.push("transport.close");
      return Promise.resolve();
    },
  };

  const acceptor = {
    closed: false,
    async *accept() {
      yield {
        transport,
        remoteAddress: {
          transport: "tcp",
          hostname: "127.0.0.1",
          port: 41239,
        },
        id: "initializing-peer",
      };
      await acceptClosed.promise;
    },
    close(): void {
      acceptClosed.resolve();
    },
  };

  try {
    using handle = serve(service, acceptor, {});

    await withTimeout(
      runtimeCreateStarted.promise,
      1000,
      "runtime creation started",
    );

    let closeResolved = false;
    const closePromise = handle.close().then(() => {
      closeResolved = true;
      events.push("handle.close");
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    assertEquals(closeResolved, false);
    assertEquals(events.includes("runtime.close"), false);

    releaseRuntimeCreate.resolve();
    await withTimeout(closePromise, 1000, "service close");

    assertEquals(events.includes("runtime.close"), true);
    assertEquals(events.includes("transport.close"), true);
    assertEquals(handle.stats.activeConnections, 0);
    assertEquals(handle.stats.forcedClosedConnections, 1);
  } finally {
    acceptClosed.resolve();
    releaseRuntimeCreate.resolve();
    (RpcServerRuntime as unknown as {
      createWithRoot: typeof RpcServerRuntime.createWithRoot;
    }).createWithRoot = originalCreateWithRoot;
  }
});

Deno.test("serve refuses accepted connections above maxActiveConnections", async () => {
  const originalCreateWithRoot = RpcServerRuntime.createWithRoot;
  const acceptClosed = deferred<void>();
  const runtimeCreated = deferred<void>();
  const refusedClosed = deferred<void>();
  const errors: unknown[] = [];
  const observabilityEvents: RpcObservabilityEvent[] = [];
  const transportCloseCounts = new Map<string, number>();
  let runtimeCreateCount = 0;

  function createTransport(name: string) {
    return {
      start(): void {
        // no-op
      },
      send(): Promise<void> {
        return Promise.resolve();
      },
      close(): Promise<void> {
        transportCloseCounts.set(
          name,
          (transportCloseCounts.get(name) ?? 0) + 1,
        );
        if (name === "refused") {
          refusedClosed.resolve();
        }
        return Promise.resolve();
      },
    };
  }

  (RpcServerRuntime as unknown as {
    createWithRoot: typeof RpcServerRuntime.createWithRoot;
  }).createWithRoot = (transport) => {
    runtimeCreateCount += 1;
    runtimeCreated.resolve();
    return Promise.resolve({
      close: async (): Promise<void> => {
        await transport.close();
      },
    } as RpcServerRuntime);
  };

  const service = createRpcServiceToken<Record<string, never>, object>({
    interfaceId: 0x178n,
    interfaceName: "ServeLimitProbe",
    bootstrapClient: () => Promise.resolve({}),
    registerServer: () => ({ capabilityIndex: 0 }),
  });

  const acceptor = {
    closed: false,
    async *accept() {
      yield {
        transport: createTransport("active"),
        remoteAddress: {
          transport: "tcp",
          hostname: "127.0.0.1",
          port: 41236,
        },
        id: "active-peer",
      };
      yield {
        transport: createTransport("refused"),
        remoteAddress: {
          transport: "tcp",
          hostname: "127.0.0.1",
          port: 41237,
        },
        id: "refused-peer",
      };
      await acceptClosed.promise;
    },
    close(): void {
      acceptClosed.resolve();
    },
  };

  try {
    using handle = serve(service, acceptor, {}, {
      maxActiveConnections: 1,
      onConnectionError(error) {
        errors.push(error);
      },
      observability: {
        onEvent(event) {
          observabilityEvents.push(event);
        },
      },
    });

    await withTimeout(runtimeCreated.promise, 1000, "runtime created");
    await withTimeout(refusedClosed.promise, 1000, "refused transport closed");

    assertEquals(runtimeCreateCount, 1);
    assertEquals(transportCloseCounts.get("refused"), 1);
    assertEquals(handle.stats.activeConnections, 1);
    assertEquals(handle.stats.acceptedConnections, 1);
    assertEquals(handle.stats.refusedConnections, 1);
    assertEquals(handle.stats.maxActiveConnections, 1);

    const limitError = errors.find((error) => error instanceof SessionError);
    assert(limitError instanceof SessionError);
    assert(limitError.metadata !== undefined);
    assertEquals(limitError.metadata.serviceName, "ServeLimitProbe");
    assertEquals(limitError.metadata.peerId, "refused-peer");
    assertEquals(limitError.metadata.transport, "tcp");

    const refusedEvent = observabilityEvents.find((event) =>
      event.name === "rpc.service.connection_refused"
    );
    assert(refusedEvent !== undefined);
    assertEquals(
      refusedEvent.attributes?.["rpc.service_name"],
      "ServeLimitProbe",
    );
    assertEquals(refusedEvent.attributes?.["rpc.max_active_connections"], 1);

    await handle.close();
    assertEquals(handle.stats.closed, true);
    assertEquals(handle.stats.activeConnections, 0);
  } finally {
    acceptClosed.resolve();
    (RpcServerRuntime as unknown as {
      createWithRoot: typeof RpcServerRuntime.createWithRoot;
    }).createWithRoot = originalCreateWithRoot;
  }
});

Deno.test("serve rejects invalid maxActiveConnections", () => {
  const service = createRpcServiceToken<Record<string, never>, object>({
    interfaceId: 0x179n,
    interfaceName: "ServeInvalidLimitProbe",
    bootstrapClient: () => Promise.resolve({}),
    registerServer: () => ({ capabilityIndex: 0 }),
  });

  const acceptor = {
    closed: false,
    async *accept() {
      // no accepted transports
    },
    close(): void {
      // no-op
    },
  };

  let thrown: unknown;
  try {
    serve(service, acceptor, {}, { maxActiveConnections: 0 });
  } catch (error) {
    thrown = error;
  }

  assert(thrown instanceof SessionError);
  assert(thrown.metadata !== undefined);
  assertEquals(thrown.metadata.serviceName, "ServeInvalidLimitProbe");
});

Deno.test("serve drain waits for active websocket connections to close naturally", async () => {
  const originalCreateWithRoot = RpcServerRuntime.createWithRoot;
  const acceptClosed = deferred<void>();
  const runtimeCreated = deferred<void>();
  const runtimeClosed = deferred<void>();
  const events: RpcObservabilityEvent[] = [];
  let runtimeCloseCount = 0;

  (RpcServerRuntime as unknown as {
    createWithRoot: typeof RpcServerRuntime.createWithRoot;
  }).createWithRoot = (transport) => {
    runtimeCreated.resolve();
    return Promise.resolve({
      close: async (): Promise<void> => {
        runtimeCloseCount += 1;
        await transport.close();
        runtimeClosed.resolve();
      },
    } as RpcServerRuntime);
  };

  const service = createRpcServiceToken<Record<string, never>, object>({
    interfaceId: 0x180n,
    interfaceName: "ServeDrainProbe",
    bootstrapClient: () => Promise.resolve({}),
    registerServer: () => ({ capabilityIndex: 0 }),
  });

  const socket = new FakeWebSocket();
  const accepted = new AcceptedWebSocketTransport(
    socket as unknown as WebSocket,
    {
      remoteAddress: { transport: "websocket" },
      id: "drain-peer",
    },
  );

  const acceptor = {
    closed: false,
    async *accept() {
      yield accepted;
      await acceptClosed.promise;
    },
    close(): void {
      acceptClosed.resolve();
    },
  };

  try {
    using handle = serve(service, acceptor, {}, {
      observability: {
        onEvent(event) {
          events.push(event);
        },
      },
    });

    await withTimeout(runtimeCreated.promise, 1000, "runtime created");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assertEquals(handle.stats.activeConnections, 1);

    const drained = handle.drain();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assertEquals(handle.stats.closed, true);
    assertEquals(handle.stats.draining, true);
    assertEquals(handle.stats.activeConnections, 1);
    assertEquals(runtimeCloseCount, 0);

    await accepted.close();

    await withTimeout(runtimeClosed.promise, 1000, "runtime closed");
    await withTimeout(drained, 1000, "service drained");

    assertEquals(handle.stats.activeConnections, 0);
    assertEquals(handle.stats.forcedClosedConnections, 0);
    assertEquals(handle.stats.draining, false);
    assert(
      events.some((event) => event.name === "rpc.service.drain_start"),
    );
    assert(
      events.some((event) => event.name === "rpc.service.drain_complete"),
    );
  } finally {
    acceptClosed.resolve();
    (RpcServerRuntime as unknown as {
      createWithRoot: typeof RpcServerRuntime.createWithRoot;
    }).createWithRoot = originalCreateWithRoot;
  }
});

Deno.test("serve drain force-closes active connections after grace window", async () => {
  const originalCreateWithRoot = RpcServerRuntime.createWithRoot;
  const acceptClosed = deferred<void>();
  const runtimeCreated = deferred<void>();
  const events: RpcObservabilityEvent[] = [];
  const transportEvents: string[] = [];
  let runtimeCloseCount = 0;

  (RpcServerRuntime as unknown as {
    createWithRoot: typeof RpcServerRuntime.createWithRoot;
  }).createWithRoot = (transport) => {
    runtimeCreated.resolve();
    return Promise.resolve({
      close: async (): Promise<void> => {
        runtimeCloseCount += 1;
        await transport.close();
      },
    } as RpcServerRuntime);
  };

  const service = createRpcServiceToken<Record<string, never>, object>({
    interfaceId: 0x181n,
    interfaceName: "ServeDrainTimeoutProbe",
    bootstrapClient: () => Promise.resolve({}),
    registerServer: () => ({ capabilityIndex: 0 }),
  });

  const acceptor = {
    closed: false,
    async *accept() {
      yield {
        transport: {
          start(): void {
            // no-op
          },
          send(): Promise<void> {
            return Promise.resolve();
          },
          close(): Promise<void> {
            transportEvents.push("transport.close");
            return Promise.resolve();
          },
        },
        remoteAddress: {
          transport: "tcp",
          hostname: "127.0.0.1",
          port: 41238,
        },
        id: "slow-peer",
      };
      await acceptClosed.promise;
    },
    close(): void {
      acceptClosed.resolve();
    },
  };

  try {
    using handle = serve(service, acceptor, {}, {
      observability: {
        onEvent(event) {
          events.push(event);
        },
      },
    });

    await withTimeout(runtimeCreated.promise, 1000, "runtime created");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await handle.drain({ forceAfterMs: 1 });

    assertEquals(runtimeCloseCount, 1);
    assertEquals(transportEvents.includes("transport.close"), true);
    assertEquals(handle.stats.closed, true);
    assertEquals(handle.stats.activeConnections, 0);
    assertEquals(handle.stats.forcedClosedConnections, 1);
    assert(
      events.some((event) =>
        event.name === "rpc.service.connections_force_close"
      ),
    );
  } finally {
    acceptClosed.resolve();
    (RpcServerRuntime as unknown as {
      createWithRoot: typeof RpcServerRuntime.createWithRoot;
    }).createWithRoot = originalCreateWithRoot;
  }
});

Deno.test("serve drain rejects invalid forceAfterMs", async () => {
  const acceptClosed = deferred<void>();
  const service = createRpcServiceToken<Record<string, never>, object>({
    interfaceId: 0x182n,
    interfaceName: "ServeDrainInvalidProbe",
    bootstrapClient: () => Promise.resolve({}),
    registerServer: () => ({ capabilityIndex: 0 }),
  });
  const handle = serve(service, {
    closed: false,
    async *accept() {
      await acceptClosed.promise;
      if (Date.now() < 0) {
        yield {
          transport: {
            start(): void {
              // no-op
            },
            send(): Promise<void> {
              return Promise.resolve();
            },
            close(): Promise<void> {
              return Promise.resolve();
            },
          },
        };
      }
    },
    close(): void {
      acceptClosed.resolve();
    },
  }, {});

  let thrown: unknown;
  try {
    try {
      await handle.drain({ forceAfterMs: -1 });
    } catch (error) {
      thrown = error;
    }

    assert(thrown instanceof SessionError);
    assert(
      /forceAfterMs must be a non-negative safe integer/i.test(thrown.message),
    );
    await handle.drain({ forceAfterMs: 0 });
    assertEquals(handle.stats.closed, true);
  } finally {
    await handle.close();
  }
});

async function withPatchedWebTransportServePrimitives(
  fn: (
    events: string[],
    runtimeCreated: Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const events: string[] = [];
  const runtimeCreated = deferred<void>();
  const pendingIncoming = deferred<Deno.QuicIncoming>();

  const denoMutable = Deno as unknown as {
    QuicEndpoint?: typeof Deno.QuicEndpoint;
    upgradeWebTransport?: typeof Deno.upgradeWebTransport;
  };
  const originalQuicEndpoint = denoMutable.QuicEndpoint;
  const originalUpgradeWebTransport = denoMutable.upgradeWebTransport;
  const originalAcceptAccepted = AcceptedWebTransportTransport.acceptAccepted;
  const originalCreateWithRoot = RpcServerRuntime.createWithRoot;

  const fakeConn = {
    remoteAddr: {
      transport: "udp",
      hostname: "127.0.0.1",
      port: 7443,
    },
    close(): void {
      events.push("conn.close");
    },
  } as Deno.QuicConn;

  const fakeSession = {
    url: "https://127.0.0.1:4443/rpc",
    closed: new Promise<WebTransportCloseInfo>(() => {}),
    close(): void {
      events.push("session.close");
    },
  } as WebTransport & { url: string };

  const fakeIncoming = {
    accept(): Promise<Deno.QuicConn> {
      return Promise.resolve(fakeConn);
    },
  } as Deno.QuicIncoming;

  class FakeQuicListener {
    #incomingCalls = 0;
    #stopped = false;

    stop(): void {
      events.push("listener.stop");
      if (this.#stopped) return;
      this.#stopped = true;
      if (this.#incomingCalls > 1) {
        pendingIncoming.reject(new Error("listener stopped"));
      }
    }

    incoming(): Promise<Deno.QuicIncoming> {
      this.#incomingCalls += 1;
      if (this.#incomingCalls === 1) {
        return Promise.resolve(fakeIncoming);
      }
      if (this.#stopped) {
        return Promise.reject(new Error("listener stopped"));
      }
      return pendingIncoming.promise;
    }
  }

  const listener = new FakeQuicListener();

  class FakeQuicEndpoint {
    readonly addr = {
      transport: "udp",
      hostname: "127.0.0.1",
      port: 4443,
    } as Deno.NetAddr;

    constructor(_options: Deno.ListenOptions) {}

    listen(_options: Deno.QuicListenOptions): Deno.QuicListener {
      return listener as unknown as Deno.QuicListener;
    }

    close(): void {
      events.push("endpoint.close");
    }
  }

  denoMutable.QuicEndpoint =
    FakeQuicEndpoint as unknown as typeof Deno.QuicEndpoint;
  denoMutable.upgradeWebTransport =
    ((_conn: Deno.QuicConn) =>
      Promise.resolve(fakeSession)) as typeof Deno.upgradeWebTransport;
  (AcceptedWebTransportTransport as unknown as {
    acceptAccepted: typeof AcceptedWebTransportTransport.acceptAccepted;
  }).acceptAccepted = (_session, metadata) => {
    const fakeTransport = {
      transport: null as unknown as WebTransportTransport,
      localAddress: metadata.localAddress ?? null,
      remoteAddress: metadata.remoteAddress ?? null,
      id: metadata.id,
      start(): void {
        // no-op
      },
      send(): Promise<void> {
        return Promise.resolve();
      },
      close(): Promise<void> {
        events.push("transport.close");
        return Promise.resolve();
      },
    };
    fakeTransport.transport = fakeTransport as unknown as WebTransportTransport;
    return Promise.resolve(
      fakeTransport as unknown as AcceptedWebTransportTransport,
    );
  };
  (RpcServerRuntime as unknown as {
    createWithRoot: typeof RpcServerRuntime.createWithRoot;
  }).createWithRoot = (transport) => {
    runtimeCreated.resolve();
    return Promise.resolve({
      close: async (): Promise<void> => {
        events.push("runtime.close");
        await transport.close();
      },
    } as RpcServerRuntime);
  };

  try {
    await fn(events, runtimeCreated.promise);
  } finally {
    denoMutable.QuicEndpoint = originalQuicEndpoint;
    denoMutable.upgradeWebTransport = originalUpgradeWebTransport;
    (AcceptedWebTransportTransport as unknown as {
      acceptAccepted: typeof AcceptedWebTransportTransport.acceptAccepted;
    }).acceptAccepted = originalAcceptAccepted;
    (RpcServerRuntime as unknown as {
      createWithRoot: typeof RpcServerRuntime.createWithRoot;
    }).createWithRoot = originalCreateWithRoot;
  }
}

Deno.test("serve closes active WebTransport runtimes before endpoint teardown and labels peers as webtransport", async () => {
  await withPatchedWebTransportServePrimitives(
    async (events, runtimeCreatedPromise) => {
      const connectedPeer = deferred<RpcPeer>();

      class ProbeServer {
        constructor(peer: RpcPeer) {
          connectedPeer.resolve(peer);
        }
      }

      const service = createRpcServiceToken<Record<string, never>, ProbeServer>(
        {
          interfaceId: 0x144n,
          interfaceName: "WtServeProbe",
          bootstrapClient: () => Promise.resolve({}),
          registerServer: () => ({ capabilityIndex: 0 }),
        },
      );

      const listener = WebTransportTransport.listen({
        hostname: "127.0.0.1",
        port: 4443,
        path: "/rpc",
        cert: "fake-cert",
        key: "fake-key",
      });
      const handle = serve(service, listener, ProbeServer);

      try {
        const peer = await withTimeout(
          connectedPeer.promise,
          1000,
          "wt serve connected peer",
        );
        await withTimeout(
          runtimeCreatedPromise,
          1000,
          "wt serve runtime creation",
        );

        assertEquals(peer.localAddress?.transport, "webtransport");
        assertEquals(peer.localAddress?.hostname, "127.0.0.1");
        assertEquals(peer.localAddress?.port, 4443);
        assertEquals(peer.localAddress?.path, "/rpc");
        assertEquals(peer.remoteAddress?.transport, "webtransport");
        assertEquals(peer.remoteAddress?.hostname, "127.0.0.1");
        assertEquals(peer.remoteAddress?.port, 7443);

        await handle.close();
      } finally {
        await handle.close();
      }

      const runtimeCloseIndex = events.indexOf("runtime.close");
      const endpointCloseIndex = events.indexOf("endpoint.close");
      assert(
        runtimeCloseIndex >= 0,
        `expected runtime.close event, got: ${events.join(", ")}`,
      );
      assert(
        endpointCloseIndex >= 0,
        `expected endpoint.close event, got: ${events.join(", ")}`,
      );
      assert(
        runtimeCloseIndex < endpointCloseIndex,
        `expected runtime.close before endpoint.close, got: ${
          events.join(", ")
        }`,
      );
    },
  );
});
