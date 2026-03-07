import {
  createRpcServiceToken,
  RpcPeer,
  RpcServerRuntime,
  WebTransportTransport,
  WT,
} from "../../src/mod.ts";
import { assert, assertEquals, deferred, withTimeout } from "../test_utils.ts";

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
  const originalAccept = WebTransportTransport.accept;
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
  (WebTransportTransport as unknown as {
    accept: typeof WebTransportTransport.accept;
  }).accept = () =>
    Promise.resolve(
      ({
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
      }) as unknown as WebTransportTransport,
    );
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
    (WebTransportTransport as unknown as {
      accept: typeof WebTransportTransport.accept;
    }).accept = originalAccept;
    (RpcServerRuntime as unknown as {
      createWithRoot: typeof RpcServerRuntime.createWithRoot;
    }).createWithRoot = originalCreateWithRoot;
  }
}

Deno.test("WT.serve closes active runtimes before endpoint teardown and labels peers as webtransport", async () => {
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

      const handle = WT.serve(service, "127.0.0.1", 4443, ProbeServer, {
        path: "/rpc",
        cert: "fake-cert",
        key: "fake-key",
      });

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
