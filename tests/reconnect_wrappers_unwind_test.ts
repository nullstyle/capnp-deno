import {
  createExponentialBackoffReconnectPolicy,
  createRpcSessionWithReconnect,
  type RpcTransport,
  SessionError,
  WasmPeer,
} from "../mod.ts";
import { FakeCapnpWasm } from "./fake_wasm.ts";
import { assert, assertEquals } from "./test_utils.ts";

function reconnectOptions() {
  return {
    policy: createExponentialBackoffReconnectPolicy({
      maxAttempts: 1,
      initialDelayMs: 1,
      maxDelayMs: 1,
      jitterRatio: 0,
    }),
    sleep: async (_delayMs: number) => {
      // no-op for deterministic tests
    },
  };
}

class TrackingTransport implements RpcTransport {
  startCalls = 0;
  closeCalls = 0;
  throwOnStart: unknown = null;
  throwOnClose: unknown = null;

  start(_onFrame: (frame: Uint8Array) => void | Promise<void>): void {
    this.startCalls += 1;
    if (this.throwOnStart !== null) {
      throw this.throwOnStart;
    }
  }

  send(_frame: Uint8Array): void {
    // no-op
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.throwOnClose !== null) {
      throw this.throwOnClose;
    }
  }
}

class TrackingPeer {
  closeCalls = 0;
  throwOnClose: unknown = null;

  close(): void {
    this.closeCalls += 1;
    if (this.throwOnClose !== null) {
      throw this.throwOnClose;
    }
  }
}

Deno.test("createRpcSessionWithReconnect closes transport when createPeer fails", async () => {
  const transport = new TrackingTransport();
  let thrown: unknown;

  try {
    await createRpcSessionWithReconnect({
      connectTransport: () => Promise.resolve(transport),
      createPeer: () => {
        throw new Error("peer init failed");
      },
      reconnect: reconnectOptions(),
    });
  } catch (error) {
    thrown = error;
  }

  assertEquals(transport.closeCalls, 1);
  assert(
    thrown instanceof SessionError &&
      /failed to create rpc session/i.test(thrown.message) &&
      /peer init failed/i.test(thrown.message),
    `expected normalized createPeer SessionError, got: ${String(thrown)}`,
  );
});

Deno.test("createRpcSessionWithReconnect closes transport and peer when auto-start fails", async () => {
  const transport = new TrackingTransport();
  transport.throwOnStart = "transport start failed";

  const peer = new TrackingPeer();
  let thrown: unknown;

  try {
    await createRpcSessionWithReconnect({
      connectTransport: () => Promise.resolve(transport),
      createPeer: () => peer as unknown as WasmPeer,
      reconnect: reconnectOptions(),
      autoStart: true,
    });
  } catch (error) {
    thrown = error;
  }

  assertEquals(transport.startCalls, 1);
  assertEquals(transport.closeCalls, 1);
  assertEquals(peer.closeCalls, 1);
  assert(
    thrown instanceof SessionError &&
      /rpc session start failed/i.test(thrown.message) &&
      /transport start failed/i.test(thrown.message),
    `expected start-failure SessionError, got: ${String(thrown)}`,
  );
});

Deno.test("createRpcSessionWithReconnect ignores close failures while unwinding", async () => {
  const transport = new TrackingTransport();
  transport.throwOnStart = "startup exploded";
  transport.throwOnClose = "transport close exploded";

  const peer = new TrackingPeer();
  peer.throwOnClose = "peer close exploded";

  let thrown: unknown;
  try {
    await createRpcSessionWithReconnect({
      connectTransport: () => Promise.resolve(transport),
      createPeer: () => peer as unknown as WasmPeer,
      reconnect: reconnectOptions(),
    });
  } catch (error) {
    thrown = error;
  }

  assertEquals(transport.closeCalls, 1);
  assertEquals(peer.closeCalls, 1);
  assert(
    thrown instanceof SessionError &&
      /startup exploded/i.test(thrown.message) &&
      !/transport close exploded/i.test(thrown.message) &&
      !/peer close exploded/i.test(thrown.message),
    `expected startup error to survive unwind, got: ${
      thrown instanceof Error ? thrown.message : String(thrown)
    }`,
  );
});

Deno.test("createRpcSessionWithReconnect can skip auto-start", async () => {
  const transport = new TrackingTransport();
  const fake = new FakeCapnpWasm();
  const peer = WasmPeer.fromExports(fake.exports);

  const result = await createRpcSessionWithReconnect({
    connectTransport: () => Promise.resolve(transport),
    createPeer: () => peer,
    reconnect: reconnectOptions(),
    autoStart: false,
  });

  try {
    assertEquals(result.session.started, false);
    assertEquals(transport.startCalls, 0);
  } finally {
    await result.session.close();
  }
});
