import { emitObservabilityEvent, getErrorType } from "../src/observability.ts";
import { assertEquals } from "./test_utils.ts";

Deno.test("emitObservabilityEvent is a no-op when observability hook is missing", () => {
  emitObservabilityEvent(undefined, {
    name: "rpc.test",
  });
});

Deno.test("emitObservabilityEvent invokes the observability hook", () => {
  let calls = 0;
  emitObservabilityEvent({
    onEvent: (event) => {
      calls += 1;
      assertEquals(event.name, "rpc.called");
      assertEquals(event.durationMs, 12);
      assertEquals(event.attributes?.["rpc.ok"], true);
    },
  }, {
    name: "rpc.called",
    durationMs: 12,
    attributes: {
      "rpc.ok": true,
    },
  });
  assertEquals(calls, 1);
});

Deno.test("emitObservabilityEvent swallows hook failures", () => {
  emitObservabilityEvent({
    onEvent: () => {
      throw new Error("telemetry sink failure");
    },
  }, {
    name: "rpc.safe_failure",
  });
});

Deno.test("getErrorType returns the error name for Error instances", () => {
  class CustomRpcError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "CustomRpcError";
    }
  }

  assertEquals(getErrorType(new CustomRpcError("boom")), "CustomRpcError");
});

Deno.test("getErrorType falls back to typeof for non-Error values", () => {
  const anonymous = new Error("anonymous");
  anonymous.name = "";
  assertEquals(getErrorType(anonymous), "object");
  assertEquals(getErrorType("boom"), "string");
  assertEquals(getErrorType(123), "number");
  assertEquals(getErrorType(true), "boolean");
  assertEquals(getErrorType(123n), "bigint");
  assertEquals(getErrorType(undefined), "undefined");
  assertEquals(getErrorType(null), "object");
});
