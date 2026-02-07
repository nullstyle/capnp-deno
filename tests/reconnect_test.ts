import {
  connectWithReconnect,
  createExponentialBackoffReconnectPolicy,
  TransportError,
} from "../mod.ts";
import { assert, assertEquals } from "./test_utils.ts";

Deno.test("createExponentialBackoffReconnectPolicy enforces retry budget and delays", () => {
  const policy = createExponentialBackoffReconnectPolicy({
    maxAttempts: 3,
    initialDelayMs: 10,
    maxDelayMs: 25,
    factor: 2,
    jitterRatio: 0,
  });

  const context = (attempt: number) => ({
    attempt,
    elapsedMs: 100,
    error: new TransportError("down"),
  });

  assertEquals(policy.shouldRetry(context(1)), true);
  assertEquals(policy.shouldRetry(context(3)), true);
  assertEquals(policy.shouldRetry(context(4)), false);

  assertEquals(policy.nextDelayMs(context(1)), 10);
  assertEquals(policy.nextDelayMs(context(2)), 20);
  assertEquals(policy.nextDelayMs(context(3)), 25);
});

Deno.test("connectWithReconnect retries until success", async () => {
  let calls = 0;
  const delays: number[] = [];

  const result = await connectWithReconnect(() => {
    calls += 1;
    if (calls < 3) {
      return Promise.reject(new TransportError(`down-${calls}`));
    }
    return Promise.resolve("ok");
  }, {
    policy: createExponentialBackoffReconnectPolicy({
      maxAttempts: 4,
      initialDelayMs: 5,
      maxDelayMs: 10,
      factor: 2,
      jitterRatio: 0,
    }),
    onRetry: (info) => {
      delays.push(info.delayMs);
    },
    sleep: async (_delayMs) => {
      // no-op for deterministic tests
    },
    now: (() => {
      let tick = 0;
      return () => tick++;
    })(),
  });

  assertEquals(result, "ok");
  assertEquals(calls, 3);
  assertEquals(JSON.stringify(delays), JSON.stringify([5, 10]));
});

Deno.test("connectWithReconnect stops when policy retries are exhausted", async () => {
  let calls = 0;
  let thrown: unknown;

  try {
    await connectWithReconnect(() => {
      calls += 1;
      return Promise.reject(new TransportError(`down-${calls}`));
    }, {
      policy: createExponentialBackoffReconnectPolicy({
        maxAttempts: 2,
        initialDelayMs: 1,
        maxDelayMs: 1,
        factor: 2,
        jitterRatio: 0,
      }),
      sleep: async (_delayMs) => {
        // no-op for deterministic tests
      },
    });
  } catch (error) {
    thrown = error;
  }

  assertEquals(calls, 3);
  assert(
    thrown instanceof TransportError && /down-3/.test(thrown.message),
    `expected final TransportError from last attempt, got: ${String(thrown)}`,
  );
});

Deno.test("connectWithReconnect can be aborted between retries", async () => {
  const controller = new AbortController();
  let retryCalls = 0;
  let sleepCalls = 0;
  let thrown: unknown;

  try {
    await connectWithReconnect(() => {
      return Promise.reject(new TransportError("still down"));
    }, {
      policy: createExponentialBackoffReconnectPolicy({
        maxAttempts: 5,
        initialDelayMs: 5,
        maxDelayMs: 5,
        factor: 2,
        jitterRatio: 0,
      }),
      signal: controller.signal,
      onRetry: () => {
        retryCalls += 1;
        controller.abort();
      },
      sleep: (_delayMs, signal) => {
        sleepCalls += 1;
        if (signal?.aborted) {
          return Promise.reject(new TransportError("reconnect aborted"));
        }
        return Promise.resolve();
      },
    });
  } catch (error) {
    thrown = error;
  }

  assertEquals(retryCalls, 1);
  assertEquals(sleepCalls, 1);
  assert(
    thrown instanceof TransportError &&
      /reconnect aborted/i.test(thrown.message),
    `expected reconnect aborted error, got: ${String(thrown)}`,
  );
});
