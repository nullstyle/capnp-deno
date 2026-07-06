import {
  annotateCapnpError,
  createRpcDebugTracer,
  emitObservabilityEvent,
  EMPTY_STRUCT_MESSAGE,
  encodeBootstrapRequestFrame,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  formatRpcDebugEvent,
  ProtocolError,
  RPC_CALL_TARGET_TAG_IMPORTED_CAP,
  SessionError,
} from "../src/mod.ts";
import { assert, assertEquals } from "./test_utils.ts";

Deno.test("annotateCapnpError merges metadata and preserves typed kind", () => {
  const source = new ProtocolError("bad frame", {
    cause: "wire",
    metadata: {
      phase: "frame_decode",
      questionId: 7,
    },
  });

  const annotated = annotateCapnpError(source, {
    methodId: 2,
    methodName: "ping",
  }, "generated call");

  assert(annotated instanceof ProtocolError);
  assertEquals(annotated.kind, "protocol");
  assertEquals(annotated.message, "generated call: bad frame");
  assertEquals(annotated.cause, "wire");
  assertEquals(annotated.metadata?.phase, "frame_decode");
  assertEquals(annotated.metadata?.questionId, 7);
  assertEquals(annotated.metadata?.methodId, 2);
  assertEquals(annotated.metadata?.methodName, "ping");
});

Deno.test("RpcDebugTracer records bounded redacted frame summaries", () => {
  const tracer = createRpcDebugTracer({ maxEvents: 2 });
  const bootstrap = encodeBootstrapRequestFrame({ questionId: 1 });
  const finish = encodeFinishFrame({ questionId: 1 });
  const release = encodeReleaseFrame({ id: 3, referenceCount: 1 });

  assertEquals(tracer.middleware.onSend?.(bootstrap), bootstrap);
  assertEquals(tracer.middleware.onReceive?.(finish), finish);
  assertEquals(tracer.middleware.onSend?.(release), release);

  const events = tracer.snapshot();
  assertEquals(events.length, 2);
  assertEquals(events[0].messageName, "Finish");
  assertEquals(events[0].questionId, 1);
  assertEquals(events[1].messageName, "Release");
  assertEquals(events[1].capabilityIndex, 3);
});

Deno.test("RpcDebugTracer keeps recording when a custom log sink throws", () => {
  const tracer = createRpcDebugTracer({
    log: () => {
      throw new Error("log sink failed");
    },
  });
  const frame = encodeBootstrapRequestFrame({ questionId: 12 });

  assertEquals(tracer.middleware.onSend?.(frame), frame);
  assertEquals(tracer.snapshot()[0].questionId, 12);
});

Deno.test("RpcDebugTracer enriches frames with registered generated method names", () => {
  const tracer = createRpcDebugTracer();
  tracer.registerSchema?.([{
    interfaceId: 0x1234n,
    interfaceName: "Pinger",
    serviceName: "Pinger",
    methodId: 4,
    methodName: "ping",
  }]);
  const frame = encodeCallRequestFrame({
    questionId: 9,
    interfaceId: 0x1234n,
    methodId: 4,
    target: {
      tag: RPC_CALL_TARGET_TAG_IMPORTED_CAP,
      importedCap: 5,
    },
    paramsContent: new Uint8Array(EMPTY_STRUCT_MESSAGE),
  });

  tracer.middleware.onSend?.(frame);

  const event = tracer.snapshot()[0];
  assertEquals(event.interfaceName, "Pinger");
  assertEquals(event.serviceName, "Pinger");
  assertEquals(event.methodName, "ping");
  const formatted = formatRpcDebugEvent(event);
  assert(/rpc=Pinger\.ping/.test(formatted), formatted);
});

Deno.test("RpcDebugTracer redacts payloads by default and allows bounded hex snippets", () => {
  const frame = encodeCallRequestFrame({
    questionId: 9,
    interfaceId: 0x1234n,
    methodId: 4,
    target: {
      tag: RPC_CALL_TARGET_TAG_IMPORTED_CAP,
      importedCap: 5,
    },
    paramsContent: new Uint8Array(EMPTY_STRUCT_MESSAGE),
  });

  const redacted = createRpcDebugTracer();
  redacted.middleware.onSend?.(frame);
  const redactedEvent = redacted.snapshot()[0];
  assertEquals(redactedEvent.messageName, "Call");
  assertEquals(redactedEvent.questionId, 9);
  assertEquals(redactedEvent.interfaceId, 0x1234n);
  assertEquals(redactedEvent.methodId, 4);
  assertEquals(redactedEvent.capabilityIndex, 5);
  assertEquals(redactedEvent.payload?.redacted, true);
  assertEquals(redactedEvent.payload?.hex, undefined);

  const withHex = createRpcDebugTracer({
    includePayloadHex: { maxBytes: 2 },
  });
  withHex.middleware.onReceive?.(frame);
  const hexEvent = withHex.snapshot()[0];
  assertEquals(hexEvent.payload?.redacted, false);
  assertEquals(hexEvent.payload?.hexBytes, 2);
  assert(
    typeof hexEvent.payload?.hex === "string" &&
      hexEvent.payload.hex.length === 4,
    "expected two bytes of hexadecimal payload",
  );

  const formatted = formatRpcDebugEvent(hexEvent);
  assert(/receive Call/.test(formatted), formatted);
  assert(/q=9/.test(formatted), formatted);
  assert(/iface=0x1234/.test(formatted), formatted);
  assert(/method=4/.test(formatted), formatted);
});

Deno.test("RpcDebugTracer records decode errors without mutating frames", () => {
  const tracer = createRpcDebugTracer();
  const bad = new Uint8Array([1, 2, 3]);

  const returned = tracer.middleware.onReceive?.(bad);

  assertEquals(returned, bad);
  const event = tracer.snapshot()[0];
  assertEquals(event.messageName, "DecodeError");
  assertEquals(event.frameBytes, 3);
  assertEquals(event.errorType, "ProtocolError");
});

Deno.test("RpcDebugTracer observability records CapnpError metadata", () => {
  const tracer = createRpcDebugTracer();
  const error = new SessionError("callback export failed", {
    metadata: {
      phase: "capability_resolve",
      serviceName: "Pinger",
      interfaceId: 0xfc4a3c8417f1ca81n,
      methodName: "ping",
      methodId: 0,
      questionId: 11,
    },
  });

  emitObservabilityEvent(tracer.observability, {
    name: "rpc.generated.error",
    error,
  });

  const event = tracer.snapshot()[0];
  assertEquals(event.kind, "observability");
  assertEquals(event.eventName, "rpc.generated.error");
  assertEquals(event.questionId, 11);
  assertEquals(event.interfaceId, 0xfc4a3c8417f1ca81n);
  assertEquals(event.methodId, 0);
  assertEquals(event.attributes?.["rpc.service_name"], "Pinger");
  assertEquals(event.errorType, "SessionError");
});
