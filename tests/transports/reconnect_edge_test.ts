import {
  connectWithReconnect,
  createExponentialBackoffReconnectPolicy,
  TransportError,
} from "../../src/advanced.ts";
import { assert, assertEquals } from "../test_utils.ts";

function expectError(
  fn: () => void,
  messagePattern: RegExp,
): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof Error && messagePattern.test(thrown.message),
    `expected Error ${messagePattern}, got: ${String(thrown)}`,
  );
}

function expectTransportError(
  fn: () => void,
  messagePattern: RegExp,
): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof TransportError && messagePattern.test(thrown.message),
    `expected TransportError ${messagePattern}, got: ${String(thrown)}`,
  );
}

Deno.test("createExponentialBackoffReconnectPolicy validates option ranges", () => {
  expectError(
    () => createExponentialBackoffReconnectPolicy({ maxAttempts: -1 }),
    /maxAttempts must be a non-negative integer/i,
  );
  expectError(
    () => createExponentialBackoffReconnectPolicy({ initialDelayMs: -1 }),
    /initialDelayMs must be a non-negative finite number/i,
  );
  expectError(
    () => createExponentialBackoffReconnectPolicy({ maxDelayMs: 0 }),
    /maxDelayMs must be a positive finite number/i,
  );
  expectTransportError(
    () =>
      createExponentialBackoffReconnectPolicy({
        factor: 0.5,
      }),
    /factor must be >= 1/i,
  );
  expectTransportError(
    () =>
      createExponentialBackoffReconnectPolicy({
        jitterRatio: 1.5,
      }),
    /jitterRatio must be <= 1/i,
  );
  expectTransportError(
    () =>
      createExponentialBackoffReconnectPolicy({
        initialDelayMs: 500,
        maxDelayMs: 100,
      }),
    /initialDelayMs 500 exceeds maxDelayMs 100/i,
  );
  expectError(
    () => createExponentialBackoffReconnectPolicy({ maxElapsedMs: 1.25 }),
    /maxElapsedMs must be a non-negative integer/i,
  );
});

Deno.test("createExponentialBackoffReconnectPolicy validates policy context and random source", () => {
  const policy = createExponentialBackoffReconnectPolicy({
    jitterRatio: 0.3,
    random: () => 1,
  });

  expectError(
    () => policy.shouldRetry({ attempt: -1, elapsedMs: 0, error: null }),
    /context\.attempt must be a non-negative integer/i,
  );
  expectError(
    () => policy.shouldRetry({ attempt: 1, elapsedMs: -1, error: null }),
    /context\.elapsedMs must be a non-negative integer/i,
  );
  expectTransportError(
    () => policy.nextDelayMs({ attempt: 1, elapsedMs: 0, error: null }),
    /random\(\) must return a value in \[0, 1\)/i,
  );
});

Deno.test("connectWithReconnect requires a reconnect policy", async () => {
  let thrown: unknown;
  try {
    await connectWithReconnect(
      () => Promise.resolve("ok"),
      {} as unknown as {
        policy: {
          shouldRetry: () => boolean;
          nextDelayMs: () => number;
        };
      },
    );
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof TransportError &&
      /requires a reconnect policy/i.test(thrown.message),
    `expected missing-policy TransportError, got: ${String(thrown)}`,
  );
});

Deno.test("connectWithReconnect normalizes shouldRetry and nextDelayMs hook failures", async () => {
  let thrownShouldRetry: unknown;
  try {
    await connectWithReconnect(
      () => Promise.reject(new Error("dial failed")),
      {
        policy: {
          shouldRetry: () => {
            throw "broken-should-retry";
          },
          nextDelayMs: () => 0,
        },
      },
    );
  } catch (error) {
    thrownShouldRetry = error;
  }
  assert(
    thrownShouldRetry instanceof TransportError &&
      /reconnect policy shouldRetry failed/i.test(thrownShouldRetry.message),
    `expected shouldRetry normalization, got: ${String(thrownShouldRetry)}`,
  );

  let thrownNextDelay: unknown;
  try {
    await connectWithReconnect(
      () => Promise.reject(new Error("dial failed")),
      {
        policy: {
          shouldRetry: () => true,
          nextDelayMs: () => {
            throw "broken-delay";
          },
        },
      },
    );
  } catch (error) {
    thrownNextDelay = error;
  }
  assert(
    thrownNextDelay instanceof TransportError &&
      /reconnect policy nextDelayMs failed/i.test(thrownNextDelay.message),
    `expected nextDelay normalization, got: ${String(thrownNextDelay)}`,
  );
});

Deno.test("connectWithReconnect normalizes onRetry and sleep failures", async () => {
  let thrownOnRetry: unknown;
  try {
    await connectWithReconnect(
      () => Promise.reject(new Error("dial failed")),
      {
        policy: {
          shouldRetry: () => true,
          nextDelayMs: () => 1,
        },
        onRetry: () => {
          throw "retry-hook-failed";
        },
      },
    );
  } catch (error) {
    thrownOnRetry = error;
  }
  assert(
    thrownOnRetry instanceof TransportError &&
      /reconnect onRetry hook failed/i.test(thrownOnRetry.message),
    `expected onRetry normalization, got: ${String(thrownOnRetry)}`,
  );

  let thrownSleep: unknown;
  try {
    await connectWithReconnect(
      () => Promise.reject(new Error("dial failed")),
      {
        policy: {
          shouldRetry: (ctx) => ctx.attempt < 2,
          nextDelayMs: () => 1,
        },
        sleep: () => Promise.reject("sleep-hook-failed"),
      },
    );
  } catch (error) {
    thrownSleep = error;
  }
  assert(
    thrownSleep instanceof TransportError &&
      /reconnect sleep failed/i.test(thrownSleep.message),
    `expected sleep normalization, got: ${String(thrownSleep)}`,
  );
});

Deno.test("connectWithReconnect aborts before first connect when signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();

  let attempts = 0;
  let thrown: unknown;
  try {
    await connectWithReconnect(
      () => {
        attempts += 1;
        return Promise.resolve("ok");
      },
      {
        policy: createExponentialBackoffReconnectPolicy({
          maxAttempts: 1,
          initialDelayMs: 1,
          maxDelayMs: 1,
          jitterRatio: 0,
        }),
        signal: controller.signal,
      },
    );
  } catch (error) {
    thrown = error;
  }

  assertEquals(attempts, 0);
  assert(
    thrown instanceof TransportError &&
      /reconnect aborted/i.test(thrown.message),
    `expected abort TransportError, got: ${String(thrown)}`,
  );
});

Deno.test("connectWithReconnect default sleep respects abort during backoff", async () => {
  const controller = new AbortController();
  let thrown: unknown;

  try {
    await connectWithReconnect(
      () => Promise.reject(new Error("dial failed")),
      {
        policy: createExponentialBackoffReconnectPolicy({
          maxAttempts: 3,
          initialDelayMs: 50,
          maxDelayMs: 50,
          jitterRatio: 0,
        }),
        signal: controller.signal,
        onRetry: () => {
          setTimeout(() => controller.abort(), 0);
        },
      },
    );
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof TransportError &&
      /aborted/i.test(thrown.message),
    `expected default-sleep abort path, got: ${String(thrown)}`,
  );
});
