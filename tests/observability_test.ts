import {
  emitObservabilityEvent,
  getErrorType,
  type RpcObservability,
  type RpcObservabilityEvent,
} from "../src/observability/observability.ts";
import { assert, assertEquals } from "./test_utils.ts";

// ---------------------------------------------------------------------------
// emitObservabilityEvent – basic contract
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// emitObservabilityEvent – onEvent receives correct attributes per event type
// ---------------------------------------------------------------------------

Deno.test("emitObservabilityEvent forwards string attributes", () => {
  const captured: RpcObservabilityEvent[] = [];
  emitObservabilityEvent({
    onEvent: (event) => captured.push(event),
  }, {
    name: "rpc.session.start",
    attributes: {
      "rpc.transport": "tcp",
      "rpc.peer": "localhost:4321",
    },
  });
  assertEquals(captured.length, 1);
  assertEquals(captured[0].attributes?.["rpc.transport"], "tcp");
  assertEquals(captured[0].attributes?.["rpc.peer"], "localhost:4321");
});

Deno.test("emitObservabilityEvent forwards numeric attributes", () => {
  const captured: RpcObservabilityEvent[] = [];
  emitObservabilityEvent({
    onEvent: (event) => captured.push(event),
  }, {
    name: "rpc.call",
    attributes: {
      "rpc.question_id": 42,
      "rpc.method_id": 7,
    },
  });
  assertEquals(captured.length, 1);
  assertEquals(captured[0].attributes?.["rpc.question_id"], 42);
  assertEquals(captured[0].attributes?.["rpc.method_id"], 7);
});

Deno.test("emitObservabilityEvent forwards boolean attributes", () => {
  const captured: RpcObservabilityEvent[] = [];
  emitObservabilityEvent({
    onEvent: (event) => captured.push(event),
  }, {
    name: "rpc.finish",
    attributes: {
      "rpc.release_result_caps": true,
      "rpc.detached": false,
    },
  });
  assertEquals(captured.length, 1);
  assertEquals(captured[0].attributes?.["rpc.release_result_caps"], true);
  assertEquals(captured[0].attributes?.["rpc.detached"], false);
});

Deno.test("emitObservabilityEvent forwards bigint attributes", () => {
  const captured: RpcObservabilityEvent[] = [];
  emitObservabilityEvent({
    onEvent: (event) => captured.push(event),
  }, {
    name: "rpc.call",
    attributes: {
      "rpc.interface_id": 0xABCD_1234_5678_9012n,
    },
  });
  assertEquals(captured.length, 1);
  assertEquals(
    captured[0].attributes?.["rpc.interface_id"],
    0xABCD_1234_5678_9012n,
  );
});

Deno.test("emitObservabilityEvent forwards mixed attribute types together", () => {
  const captured: RpcObservabilityEvent[] = [];
  emitObservabilityEvent({
    onEvent: (event) => captured.push(event),
  }, {
    name: "rpc.call",
    attributes: {
      "rpc.interface_id": 0x1234n,
      "rpc.method_id": 3,
      "rpc.has_caps": true,
      "rpc.label": "bootstrap",
    },
  });
  assertEquals(captured.length, 1);
  const attrs = captured[0].attributes!;
  assertEquals(attrs["rpc.interface_id"], 0x1234n);
  assertEquals(attrs["rpc.method_id"], 3);
  assertEquals(attrs["rpc.has_caps"], true);
  assertEquals(attrs["rpc.label"], "bootstrap");
});

// ---------------------------------------------------------------------------
// emitObservabilityEvent – event without attributes
// ---------------------------------------------------------------------------

Deno.test("emitObservabilityEvent works with event that has no attributes", () => {
  const captured: RpcObservabilityEvent[] = [];
  emitObservabilityEvent({
    onEvent: (event) => captured.push(event),
  }, {
    name: "rpc.session.close",
  });
  assertEquals(captured.length, 1);
  assertEquals(captured[0].name, "rpc.session.close");
  assertEquals(captured[0].attributes, undefined);
});

// ---------------------------------------------------------------------------
// emitObservabilityEvent – error events include error field
// ---------------------------------------------------------------------------

Deno.test("emitObservabilityEvent forwards error field to onEvent", () => {
  const captured: RpcObservabilityEvent[] = [];
  const err = new TypeError("connection reset");
  emitObservabilityEvent({
    onEvent: (event) => captured.push(event),
  }, {
    name: "rpc.transport.error",
    error: err,
    attributes: {
      "rpc.transport": "tcp",
    },
  });
  assertEquals(captured.length, 1);
  assertEquals(captured[0].error, err);
  assertEquals(captured[0].name, "rpc.transport.error");
  assertEquals(captured[0].attributes?.["rpc.transport"], "tcp");
});

Deno.test("emitObservabilityEvent forwards non-Error error values", () => {
  const captured: RpcObservabilityEvent[] = [];
  emitObservabilityEvent({
    onEvent: (event) => captured.push(event),
  }, {
    name: "rpc.error",
    error: "string error",
  });
  assertEquals(captured.length, 1);
  assertEquals(captured[0].error, "string error");
});

Deno.test("emitObservabilityEvent forwards numeric error values", () => {
  const captured: RpcObservabilityEvent[] = [];
  emitObservabilityEvent({
    onEvent: (event) => captured.push(event),
  }, {
    name: "rpc.error",
    error: 404,
  });
  assertEquals(captured.length, 1);
  assertEquals(captured[0].error, 404);
});

// ---------------------------------------------------------------------------
// emitObservabilityEvent – durationMs forwarding
// ---------------------------------------------------------------------------

Deno.test("emitObservabilityEvent forwards durationMs when present", () => {
  const captured: RpcObservabilityEvent[] = [];
  emitObservabilityEvent({
    onEvent: (event) => captured.push(event),
  }, {
    name: "rpc.call",
    durationMs: 99.5,
  });
  assertEquals(captured.length, 1);
  assertEquals(captured[0].durationMs, 99.5);
});

Deno.test("emitObservabilityEvent forwards zero durationMs", () => {
  const captured: RpcObservabilityEvent[] = [];
  emitObservabilityEvent({
    onEvent: (event) => captured.push(event),
  }, {
    name: "rpc.fast_call",
    durationMs: 0,
  });
  assertEquals(captured.length, 1);
  assertEquals(captured[0].durationMs, 0);
});

Deno.test("emitObservabilityEvent passes undefined durationMs when omitted", () => {
  const captured: RpcObservabilityEvent[] = [];
  emitObservabilityEvent({
    onEvent: (event) => captured.push(event),
  }, {
    name: "rpc.session.start",
  });
  assertEquals(captured.length, 1);
  assertEquals(captured[0].durationMs, undefined);
});

// ---------------------------------------------------------------------------
// emitObservabilityEvent – missing / undefined observability hook
// ---------------------------------------------------------------------------

Deno.test("emitObservabilityEvent does not throw when hook is undefined", () => {
  // Passing undefined explicitly should be a silent no-op.
  emitObservabilityEvent(undefined, {
    name: "rpc.test",
    durationMs: 5,
    attributes: { "rpc.flag": true },
    error: new Error("should be ignored"),
  });
  // If we reach here, the test passes.
  assert(true, "no exception thrown");
});

Deno.test("emitObservabilityEvent does not throw when hook object has no onEvent", () => {
  const hook: RpcObservability = {};
  emitObservabilityEvent(hook, {
    name: "rpc.test",
    durationMs: 10,
    attributes: { "rpc.key": "value" },
  });
  assert(true, "no exception thrown");
});

Deno.test("emitObservabilityEvent does not throw when onEvent is explicitly undefined", () => {
  const hook: RpcObservability = { onEvent: undefined };
  emitObservabilityEvent(hook, {
    name: "rpc.test",
  });
  assert(true, "no exception thrown");
});

// ---------------------------------------------------------------------------
// emitObservabilityEvent – multiple sequential events
// ---------------------------------------------------------------------------

Deno.test("emitObservabilityEvent accumulates multiple events in sequence", () => {
  const captured: RpcObservabilityEvent[] = [];
  const hook: RpcObservability = {
    onEvent: (event) => captured.push(event),
  };

  emitObservabilityEvent(hook, { name: "rpc.session.start" });
  emitObservabilityEvent(hook, {
    name: "rpc.call",
    durationMs: 5,
    attributes: { "rpc.question_id": 1 },
  });
  emitObservabilityEvent(hook, {
    name: "rpc.return",
    durationMs: 3,
    attributes: { "rpc.answer_id": 1 },
  });
  emitObservabilityEvent(hook, { name: "rpc.session.close" });

  assertEquals(captured.length, 4);
  assertEquals(captured[0].name, "rpc.session.start");
  assertEquals(captured[1].name, "rpc.call");
  assertEquals(captured[2].name, "rpc.return");
  assertEquals(captured[3].name, "rpc.session.close");
});

// ---------------------------------------------------------------------------
// emitObservabilityEvent – swallows different exception types
// ---------------------------------------------------------------------------

Deno.test("emitObservabilityEvent swallows TypeError thrown by hook", () => {
  emitObservabilityEvent({
    onEvent: () => {
      throw new TypeError("type error in hook");
    },
  }, {
    name: "rpc.test",
  });
  assert(true, "TypeError was swallowed");
});

Deno.test("emitObservabilityEvent swallows non-Error throw from hook", () => {
  emitObservabilityEvent({
    onEvent: () => {
      throw "string exception";
    },
  }, {
    name: "rpc.test",
  });
  assert(true, "string exception was swallowed");
});

// ---------------------------------------------------------------------------
// getErrorType – comprehensive coverage
// ---------------------------------------------------------------------------

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

Deno.test("getErrorType returns correct name for built-in error types", () => {
  assertEquals(getErrorType(new TypeError("t")), "TypeError");
  assertEquals(getErrorType(new RangeError("r")), "RangeError");
  assertEquals(getErrorType(new SyntaxError("s")), "SyntaxError");
  assertEquals(getErrorType(new ReferenceError("ref")), "ReferenceError");
  assertEquals(getErrorType(new URIError("u")), "URIError");
  assertEquals(getErrorType(new EvalError("e")), "EvalError");
});

Deno.test("getErrorType returns 'Error' for plain Error instances", () => {
  assertEquals(getErrorType(new Error("plain")), "Error");
});

Deno.test("getErrorType returns 'function' for function values", () => {
  assertEquals(getErrorType(() => {}), "function");
});

Deno.test("getErrorType returns 'symbol' for symbol values", () => {
  assertEquals(getErrorType(Symbol("sym")), "symbol");
});
