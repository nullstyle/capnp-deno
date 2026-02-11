import {
  createExponentialBackoffReconnectPolicy,
  createRpcSessionWithReconnect,
  type RpcTransport,
  SessionError,
} from "../../advanced.ts";
import { assert, assertEquals } from "../test_utils.ts";

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

  close(): void {
    this.closeCalls += 1;
    if (this.throwOnClose !== null) {
      throw this.throwOnClose;
    }
  }
}

Deno.test("createRpcSessionWithReconnect closes transport when runtime module setup fails", async () => {
  const transport = new TrackingTransport();
  let thrown: unknown;

  try {
    await createRpcSessionWithReconnect({
      connectTransport: () => Promise.resolve(transport),
      runtimeModule: {
        expectedVersion: -1,
      },
      reconnect: reconnectOptions(),
    });
  } catch (error) {
    thrown = error;
  }

  assertEquals(transport.closeCalls, 1);
  assert(
    thrown instanceof Error &&
      /version/i.test(thrown.message),
    `expected runtime-module setup failure, got: ${String(thrown)}`,
  );
});

Deno.test("createRpcSessionWithReconnect closes transport when auto-start fails", async () => {
  const transport = new TrackingTransport();
  transport.throwOnStart = "transport start failed";

  let thrown: unknown;

  try {
    await createRpcSessionWithReconnect({
      connectTransport: () => Promise.resolve(transport),
      reconnect: reconnectOptions(),
      autoStart: true,
    });
  } catch (error) {
    thrown = error;
  }

  assertEquals(transport.startCalls, 1);
  assertEquals(transport.closeCalls, 1);
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

  let thrown: unknown;
  try {
    await createRpcSessionWithReconnect({
      connectTransport: () => Promise.resolve(transport),
      reconnect: reconnectOptions(),
    });
  } catch (error) {
    thrown = error;
  }

  assertEquals(transport.closeCalls, 1);
  assert(
    thrown instanceof SessionError &&
      /startup exploded/i.test(thrown.message) &&
      !/transport close exploded/i.test(thrown.message),
    `expected startup error to survive unwind, got: ${
      thrown instanceof Error ? thrown.message : String(thrown)
    }`,
  );
});

Deno.test("createRpcSessionWithReconnect can skip auto-start", async () => {
  const transport = new TrackingTransport();

  const result = await createRpcSessionWithReconnect({
    connectTransport: () => Promise.resolve(transport),
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
