import {
  connect,
  createRpcServiceToken,
  RpcPeer,
  RpcServerRuntime,
  serve,
  serveConnection,
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
    await handle.close();
  } finally {
    (RpcServerRuntime as unknown as {
      createWithRoot: typeof RpcServerRuntime.createWithRoot;
    }).createWithRoot = originalCreateWithRoot;
  }

  assert(events.includes("runtime.close"));
  assert(events.includes("transport.close"));
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
