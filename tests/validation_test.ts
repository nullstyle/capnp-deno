import {
  assertNonNegativeFinite,
  assertNonNegativeInteger,
  assertPositiveFinite,
  assertPositiveInteger,
} from "../mod.ts";
import { assert, assertThrows } from "./test_utils.ts";

// ---------------------------------------------------------------------------
// assertPositiveInteger
// ---------------------------------------------------------------------------

Deno.test("assertPositiveInteger accepts 1", () => {
  assertPositiveInteger(1, "x");
});

Deno.test("assertPositiveInteger accepts large integers", () => {
  assertPositiveInteger(1_000_000, "x");
  assertPositiveInteger(Number.MAX_SAFE_INTEGER, "x");
});

Deno.test("assertPositiveInteger rejects zero", () => {
  assertThrows(
    () => assertPositiveInteger(0, "count"),
    /count must be a positive integer, got 0/,
  );
});

Deno.test("assertPositiveInteger rejects negative integers", () => {
  assertThrows(
    () => assertPositiveInteger(-1, "count"),
    /count must be a positive integer, got -1/,
  );
  assertThrows(
    () => assertPositiveInteger(-100, "count"),
    /count must be a positive integer, got -100/,
  );
});

Deno.test("assertPositiveInteger rejects floats", () => {
  assertThrows(
    () => assertPositiveInteger(1.5, "count"),
    /count must be a positive integer, got 1\.5/,
  );
  assertThrows(
    () => assertPositiveInteger(0.1, "count"),
    /count must be a positive integer, got 0\.1/,
  );
});

Deno.test("assertPositiveInteger rejects NaN", () => {
  assertThrows(
    () => assertPositiveInteger(NaN, "count"),
    /count must be a positive integer, got NaN/,
  );
});

Deno.test("assertPositiveInteger rejects Infinity", () => {
  assertThrows(
    () => assertPositiveInteger(Infinity, "count"),
    /count must be a positive integer, got Infinity/,
  );
  assertThrows(
    () => assertPositiveInteger(-Infinity, "count"),
    /count must be a positive integer, got -Infinity/,
  );
});

Deno.test("assertPositiveInteger includes parameter name in error", () => {
  let thrown: unknown;
  try {
    assertPositiveInteger(-1, "maxRetries");
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof Error, "should throw an Error");
  assert(
    thrown.message.includes("maxRetries"),
    `error message should include parameter name, got: ${thrown.message}`,
  );
});

// ---------------------------------------------------------------------------
// assertNonNegativeInteger
// ---------------------------------------------------------------------------

Deno.test("assertNonNegativeInteger accepts zero", () => {
  assertNonNegativeInteger(0, "x");
});

Deno.test("assertNonNegativeInteger accepts positive integers", () => {
  assertNonNegativeInteger(1, "x");
  assertNonNegativeInteger(42, "x");
  assertNonNegativeInteger(Number.MAX_SAFE_INTEGER, "x");
});

Deno.test("assertNonNegativeInteger rejects negative integers", () => {
  assertThrows(
    () => assertNonNegativeInteger(-1, "delay"),
    /delay must be a non-negative integer, got -1/,
  );
  assertThrows(
    () => assertNonNegativeInteger(-100, "delay"),
    /delay must be a non-negative integer, got -100/,
  );
});

Deno.test("assertNonNegativeInteger rejects floats", () => {
  assertThrows(
    () => assertNonNegativeInteger(0.5, "delay"),
    /delay must be a non-negative integer, got 0\.5/,
  );
  assertThrows(
    () => assertNonNegativeInteger(2.7, "delay"),
    /delay must be a non-negative integer, got 2\.7/,
  );
});

Deno.test("assertNonNegativeInteger rejects NaN", () => {
  assertThrows(
    () => assertNonNegativeInteger(NaN, "delay"),
    /delay must be a non-negative integer, got NaN/,
  );
});

Deno.test("assertNonNegativeInteger rejects Infinity", () => {
  assertThrows(
    () => assertNonNegativeInteger(Infinity, "delay"),
    /delay must be a non-negative integer, got Infinity/,
  );
  assertThrows(
    () => assertNonNegativeInteger(-Infinity, "delay"),
    /delay must be a non-negative integer, got -Infinity/,
  );
});

Deno.test("assertNonNegativeInteger includes parameter name in error", () => {
  let thrown: unknown;
  try {
    assertNonNegativeInteger(-5, "bufferSize");
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof Error, "should throw an Error");
  assert(
    thrown.message.includes("bufferSize"),
    `error message should include parameter name, got: ${thrown.message}`,
  );
});

// ---------------------------------------------------------------------------
// assertPositiveFinite
// ---------------------------------------------------------------------------

Deno.test("assertPositiveFinite accepts positive integers", () => {
  assertPositiveFinite(1, "x");
  assertPositiveFinite(42, "x");
});

Deno.test("assertPositiveFinite accepts positive floats", () => {
  assertPositiveFinite(0.001, "x");
  assertPositiveFinite(3.14, "x");
  assertPositiveFinite(Number.MIN_VALUE, "x");
});

Deno.test("assertPositiveFinite rejects zero", () => {
  assertThrows(
    () => assertPositiveFinite(0, "timeout"),
    /timeout must be a positive finite number, got 0/,
  );
});

Deno.test("assertPositiveFinite rejects negative values", () => {
  assertThrows(
    () => assertPositiveFinite(-1, "timeout"),
    /timeout must be a positive finite number, got -1/,
  );
  assertThrows(
    () => assertPositiveFinite(-0.5, "timeout"),
    /timeout must be a positive finite number, got -0\.5/,
  );
});

Deno.test("assertPositiveFinite rejects Infinity", () => {
  assertThrows(
    () => assertPositiveFinite(Infinity, "timeout"),
    /timeout must be a positive finite number, got Infinity/,
  );
  assertThrows(
    () => assertPositiveFinite(-Infinity, "timeout"),
    /timeout must be a positive finite number, got -Infinity/,
  );
});

Deno.test("assertPositiveFinite rejects NaN", () => {
  assertThrows(
    () => assertPositiveFinite(NaN, "timeout"),
    /timeout must be a positive finite number, got NaN/,
  );
});

Deno.test("assertPositiveFinite includes parameter name in error", () => {
  let thrown: unknown;
  try {
    assertPositiveFinite(0, "cooldownMs");
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof Error, "should throw an Error");
  assert(
    thrown.message.includes("cooldownMs"),
    `error message should include parameter name, got: ${thrown.message}`,
  );
});

// ---------------------------------------------------------------------------
// assertNonNegativeFinite
// ---------------------------------------------------------------------------

Deno.test("assertNonNegativeFinite accepts zero", () => {
  assertNonNegativeFinite(0, "x");
});

Deno.test("assertNonNegativeFinite accepts positive integers", () => {
  assertNonNegativeFinite(1, "x");
  assertNonNegativeFinite(42, "x");
});

Deno.test("assertNonNegativeFinite accepts positive floats", () => {
  assertNonNegativeFinite(0.001, "x");
  assertNonNegativeFinite(3.14, "x");
});

Deno.test("assertNonNegativeFinite rejects negative values", () => {
  assertThrows(
    () => assertNonNegativeFinite(-1, "jitter"),
    /jitter must be a non-negative finite number, got -1/,
  );
  assertThrows(
    () => assertNonNegativeFinite(-0.001, "jitter"),
    /jitter must be a non-negative finite number, got -0\.001/,
  );
});

Deno.test("assertNonNegativeFinite rejects Infinity", () => {
  assertThrows(
    () => assertNonNegativeFinite(Infinity, "jitter"),
    /jitter must be a non-negative finite number, got Infinity/,
  );
  assertThrows(
    () => assertNonNegativeFinite(-Infinity, "jitter"),
    /jitter must be a non-negative finite number, got -Infinity/,
  );
});

Deno.test("assertNonNegativeFinite rejects NaN", () => {
  assertThrows(
    () => assertNonNegativeFinite(NaN, "jitter"),
    /jitter must be a non-negative finite number, got NaN/,
  );
});

Deno.test("assertNonNegativeFinite includes parameter name in error", () => {
  let thrown: unknown;
  try {
    assertNonNegativeFinite(-1, "baseDelayMs");
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof Error, "should throw an Error");
  assert(
    thrown.message.includes("baseDelayMs"),
    `error message should include parameter name, got: ${thrown.message}`,
  );
});

// ---------------------------------------------------------------------------
// All validators throw plain Error (not a subclass)
// ---------------------------------------------------------------------------

Deno.test("all validators throw plain Error, not a CapnpError subclass", () => {
  const cases: Array<{ fn: () => void; label: string }> = [
    { fn: () => assertPositiveInteger(0, "a"), label: "assertPositiveInteger" },
    {
      fn: () => assertNonNegativeInteger(-1, "a"),
      label: "assertNonNegativeInteger",
    },
    { fn: () => assertPositiveFinite(0, "a"), label: "assertPositiveFinite" },
    {
      fn: () => assertNonNegativeFinite(-1, "a"),
      label: "assertNonNegativeFinite",
    },
  ];

  for (const { fn, label } of cases) {
    let thrown: unknown;
    try {
      fn();
    } catch (err) {
      thrown = err;
    }
    assert(thrown instanceof Error, `${label} should throw an Error`);
    // The constructor name should be exactly "Error", not a subclass.
    assert(
      thrown.constructor === Error,
      `${label} should throw a plain Error, got ${thrown.constructor.name}`,
    );
  }
});
