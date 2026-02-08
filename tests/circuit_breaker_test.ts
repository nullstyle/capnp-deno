import {
  CircuitBreaker,
  type CircuitBreakerState,
  TransportError,
} from "../advanced.ts";
import { assert, assertEquals, assertThrows } from "./test_utils.ts";

// ---------------------------------------------------------------------------
// Helper: deterministic clock
// ---------------------------------------------------------------------------
function makeClock(
  start = 0,
): { now: () => number; advance: (ms: number) => void } {
  let tick = start;
  return {
    now: () => tick,
    advance: (ms: number) => {
      tick += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: factory that succeeds or fails on demand
// ---------------------------------------------------------------------------
function makeFactory(): {
  factory: () => Promise<string>;
  succeedWith: (value: string) => void;
  failWith: (error: Error) => void;
} {
  let result: { ok: true; value: string } | { ok: false; error: Error } = {
    ok: true,
    value: "connected",
  };
  return {
    factory: () => {
      if (result.ok) {
        return Promise.resolve(result.value);
      }
      return Promise.reject(result.error);
    },
    succeedWith: (value: string) => {
      result = { ok: true, value };
    },
    failWith: (error: Error) => {
      result = { ok: false, error };
    },
  };
}

// ---------------------------------------------------------------------------
// Construction validation
// ---------------------------------------------------------------------------

Deno.test("CircuitBreaker rejects invalid maxConsecutiveFailures", () => {
  assertThrows(
    () => new CircuitBreaker({ maxConsecutiveFailures: 0 }),
    /maxConsecutiveFailures/,
  );
  assertThrows(
    () => new CircuitBreaker({ maxConsecutiveFailures: -1 }),
    /maxConsecutiveFailures/,
  );
  assertThrows(
    () => new CircuitBreaker({ maxConsecutiveFailures: 1.5 }),
    /maxConsecutiveFailures/,
  );
});

Deno.test("CircuitBreaker rejects invalid cooldownMs", () => {
  assertThrows(
    () => new CircuitBreaker({ cooldownMs: 0 }),
    /cooldownMs/,
  );
  assertThrows(
    () => new CircuitBreaker({ cooldownMs: -100 }),
    /cooldownMs/,
  );
  assertThrows(
    () => new CircuitBreaker({ cooldownMs: Infinity }),
    /cooldownMs/,
  );
});

// ---------------------------------------------------------------------------
// Normal operation -- circuit stays CLOSED
// ---------------------------------------------------------------------------

Deno.test("CircuitBreaker stays CLOSED on successful calls", async () => {
  const breaker = new CircuitBreaker<string>();
  const { factory } = makeFactory();

  const result = await breaker.call(factory);
  assertEquals(result, "connected");
  assertEquals(breaker.state, "CLOSED");
  assertEquals(breaker.consecutiveFailures, 0);
});

Deno.test("CircuitBreaker stays CLOSED when failures are below threshold", async () => {
  const clock = makeClock();
  const breaker = new CircuitBreaker<string>({
    maxConsecutiveFailures: 5,
    now: clock.now,
  });
  const { factory, failWith } = makeFactory();
  failWith(new TransportError("down"));

  // Fail 4 times -- should stay CLOSED since threshold is 5
  for (let i = 0; i < 4; i++) {
    try {
      await breaker.call(factory);
    } catch {
      // expected
    }
  }

  assertEquals(breaker.state, "CLOSED");
  assertEquals(breaker.consecutiveFailures, 4);
});

Deno.test("CircuitBreaker resets failure count on success", async () => {
  const clock = makeClock();
  const breaker = new CircuitBreaker<string>({
    maxConsecutiveFailures: 5,
    now: clock.now,
  });
  const { factory, failWith, succeedWith } = makeFactory();

  // Accumulate 3 failures
  failWith(new TransportError("down"));
  for (let i = 0; i < 3; i++) {
    try {
      await breaker.call(factory);
    } catch {
      // expected
    }
  }
  assertEquals(breaker.consecutiveFailures, 3);

  // One success resets the counter
  succeedWith("ok");
  await breaker.call(factory);
  assertEquals(breaker.consecutiveFailures, 0);
  assertEquals(breaker.state, "CLOSED");
});

// ---------------------------------------------------------------------------
// Circuit opens after consecutive failures
// ---------------------------------------------------------------------------

Deno.test("CircuitBreaker opens after maxConsecutiveFailures", async () => {
  const clock = makeClock();
  const transitions: [CircuitBreakerState, CircuitBreakerState][] = [];
  const breaker = new CircuitBreaker<string>({
    maxConsecutiveFailures: 3,
    cooldownMs: 10_000,
    now: clock.now,
    onStateChange: (from, to) => {
      transitions.push([from, to]);
    },
  });
  const { factory, failWith } = makeFactory();
  failWith(new TransportError("down"));

  // Fail exactly 3 times to trip the breaker
  for (let i = 0; i < 3; i++) {
    try {
      await breaker.call(factory);
    } catch {
      // expected
    }
  }

  assertEquals(breaker.state, "OPEN");
  assertEquals(breaker.consecutiveFailures, 3);
  assertEquals(transitions.length, 1);
  assertEquals(transitions[0][0], "CLOSED");
  assertEquals(transitions[0][1], "OPEN");
});

Deno.test("CircuitBreaker rejects calls immediately when OPEN", async () => {
  const clock = makeClock();
  const breaker = new CircuitBreaker<string>({
    maxConsecutiveFailures: 2,
    cooldownMs: 10_000,
    now: clock.now,
  });
  const { factory, failWith } = makeFactory();
  failWith(new TransportError("down"));

  // Trip the breaker
  for (let i = 0; i < 2; i++) {
    try {
      await breaker.call(factory);
    } catch {
      // expected
    }
  }
  assertEquals(breaker.state, "OPEN");

  // Next call should be rejected without calling the factory
  let factoryCalled = false;
  try {
    await breaker.call(() => {
      factoryCalled = true;
      return Promise.resolve("should not reach");
    });
    throw new Error("should have thrown");
  } catch (error) {
    assert(error instanceof TransportError, "should be TransportError");
    assert(
      error.message.includes("circuit breaker is open"),
      `unexpected message: ${error.message}`,
    );
  }
  assertEquals(factoryCalled, false);
});

// ---------------------------------------------------------------------------
// Cooldown period behavior
// ---------------------------------------------------------------------------

Deno.test("CircuitBreaker transitions to HALF_OPEN after cooldown", async () => {
  const clock = makeClock();
  const transitions: [CircuitBreakerState, CircuitBreakerState][] = [];
  const breaker = new CircuitBreaker<string>({
    maxConsecutiveFailures: 2,
    cooldownMs: 5_000,
    now: clock.now,
    onStateChange: (from, to) => {
      transitions.push([from, to]);
    },
  });
  const { factory, failWith, succeedWith } = makeFactory();
  failWith(new TransportError("down"));

  // Trip the breaker
  for (let i = 0; i < 2; i++) {
    try {
      await breaker.call(factory);
    } catch {
      // expected
    }
  }
  assertEquals(breaker.state, "OPEN");

  // Still within cooldown -- should reject
  clock.advance(4_999);
  try {
    await breaker.call(factory);
    throw new Error("should have thrown");
  } catch (error) {
    assert(error instanceof TransportError, "should be TransportError");
    assert(
      error.message.includes("circuit breaker is open"),
      `unexpected message: ${error.message}`,
    );
  }
  assertEquals(breaker.state, "OPEN");

  // Advance past cooldown -- should transition to HALF_OPEN and allow a probe
  clock.advance(1);
  succeedWith("recovered");
  const result = await breaker.call(factory);
  assertEquals(result, "recovered");
  assertEquals(breaker.state, "CLOSED");

  // Transitions: CLOSED->OPEN, OPEN->HALF_OPEN, HALF_OPEN->CLOSED
  assertEquals(transitions.length, 3);
  assertEquals(transitions[1][0], "OPEN");
  assertEquals(transitions[1][1], "HALF_OPEN");
  assertEquals(transitions[2][0], "HALF_OPEN");
  assertEquals(transitions[2][1], "CLOSED");
});

// ---------------------------------------------------------------------------
// Half-open state and recovery
// ---------------------------------------------------------------------------

Deno.test("CircuitBreaker HALF_OPEN probe failure reopens the circuit", async () => {
  const clock = makeClock();
  const transitions: [CircuitBreakerState, CircuitBreakerState][] = [];
  const breaker = new CircuitBreaker<string>({
    maxConsecutiveFailures: 2,
    cooldownMs: 5_000,
    now: clock.now,
    onStateChange: (from, to) => {
      transitions.push([from, to]);
    },
  });
  const { factory, failWith } = makeFactory();
  failWith(new TransportError("down"));

  // Trip the breaker
  for (let i = 0; i < 2; i++) {
    try {
      await breaker.call(factory);
    } catch {
      // expected
    }
  }
  assertEquals(breaker.state, "OPEN");

  // Wait past cooldown
  clock.advance(5_000);

  // Probe attempt fails
  try {
    await breaker.call(factory);
  } catch {
    // expected -- factory still failing
  }

  // Should be back to OPEN
  assertEquals(breaker.state, "OPEN");

  // Transitions: CLOSED->OPEN, OPEN->HALF_OPEN, HALF_OPEN->OPEN
  assertEquals(transitions.length, 3);
  assertEquals(transitions[2][0], "HALF_OPEN");
  assertEquals(transitions[2][1], "OPEN");
});

Deno.test("CircuitBreaker HALF_OPEN probe success closes the circuit", async () => {
  const clock = makeClock();
  const breaker = new CircuitBreaker<string>({
    maxConsecutiveFailures: 2,
    cooldownMs: 5_000,
    now: clock.now,
  });
  const { factory, failWith, succeedWith } = makeFactory();
  failWith(new TransportError("down"));

  // Trip the breaker
  for (let i = 0; i < 2; i++) {
    try {
      await breaker.call(factory);
    } catch {
      // expected
    }
  }
  assertEquals(breaker.state, "OPEN");

  // Wait past cooldown and succeed
  clock.advance(5_000);
  succeedWith("back");
  const result = await breaker.call(factory);
  assertEquals(result, "back");
  assertEquals(breaker.state, "CLOSED");
  assertEquals(breaker.consecutiveFailures, 0);
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

Deno.test("CircuitBreaker reset() closes the circuit and clears failures", async () => {
  const clock = makeClock();
  const breaker = new CircuitBreaker<string>({
    maxConsecutiveFailures: 2,
    cooldownMs: 5_000,
    now: clock.now,
  });
  const { factory, failWith, succeedWith } = makeFactory();
  failWith(new TransportError("down"));

  // Trip the breaker
  for (let i = 0; i < 2; i++) {
    try {
      await breaker.call(factory);
    } catch {
      // expected
    }
  }
  assertEquals(breaker.state, "OPEN");

  // Manual reset
  breaker.reset();
  assertEquals(breaker.state, "CLOSED");
  assertEquals(breaker.consecutiveFailures, 0);

  // Should be able to call again
  succeedWith("fresh");
  const result = await breaker.call(factory);
  assertEquals(result, "fresh");
});

Deno.test("CircuitBreaker reset() is a no-op when already CLOSED", () => {
  const transitions: [CircuitBreakerState, CircuitBreakerState][] = [];
  const breaker = new CircuitBreaker<string>({
    onStateChange: (from, to) => {
      transitions.push([from, to]);
    },
  });

  breaker.reset();
  assertEquals(transitions.length, 0);
  assertEquals(breaker.state, "CLOSED");
});

// ---------------------------------------------------------------------------
// Multiple cycles: open -> half-open -> open -> half-open -> closed
// ---------------------------------------------------------------------------

Deno.test("CircuitBreaker supports multiple open/half-open cycles before recovery", async () => {
  const clock = makeClock();
  const breaker = new CircuitBreaker<string>({
    maxConsecutiveFailures: 1,
    cooldownMs: 1_000,
    now: clock.now,
  });
  const { factory, failWith, succeedWith } = makeFactory();
  failWith(new TransportError("down"));

  // Trip the breaker (1 failure is enough)
  try {
    await breaker.call(factory);
  } catch {
    // expected
  }
  assertEquals(breaker.state, "OPEN");

  // First probe fails
  clock.advance(1_000);
  try {
    await breaker.call(factory);
  } catch {
    // expected
  }
  assertEquals(breaker.state, "OPEN");

  // Second probe fails
  clock.advance(1_000);
  try {
    await breaker.call(factory);
  } catch {
    // expected
  }
  assertEquals(breaker.state, "OPEN");

  // Third probe succeeds
  clock.advance(1_000);
  succeedWith("finally");
  const result = await breaker.call(factory);
  assertEquals(result, "finally");
  assertEquals(breaker.state, "CLOSED");
  assertEquals(breaker.consecutiveFailures, 0);
});

// ---------------------------------------------------------------------------
// Default options
// ---------------------------------------------------------------------------

Deno.test("CircuitBreaker uses sensible defaults", () => {
  const breaker = new CircuitBreaker<string>();
  // Should not throw -- defaults are valid
  assertEquals(breaker.state, "CLOSED");
  assertEquals(breaker.consecutiveFailures, 0);
});

// ---------------------------------------------------------------------------
// Remaining cooldown in error message
// ---------------------------------------------------------------------------

Deno.test("CircuitBreaker OPEN error includes remaining cooldown time", async () => {
  const clock = makeClock();
  const breaker = new CircuitBreaker<string>({
    maxConsecutiveFailures: 1,
    cooldownMs: 10_000,
    now: clock.now,
  });
  const { factory, failWith } = makeFactory();
  failWith(new TransportError("down"));

  // Trip the breaker
  try {
    await breaker.call(factory);
  } catch {
    // expected
  }

  clock.advance(3_000);

  try {
    await breaker.call(factory);
    throw new Error("should have thrown");
  } catch (error) {
    assert(error instanceof TransportError, "should be TransportError");
    assert(
      error.message.includes("7000ms remaining"),
      `expected remaining time in message: ${error.message}`,
    );
  }
});
