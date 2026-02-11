import {
  decodeRpcMessage,
  dispatchRpcMessage,
  encodeBootstrapRequestFrame,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  encodeReturnExceptionFrame,
  encodeReturnResultsFrame,
  type RpcMessageHandlers,
} from "../../advanced.ts";
import { assert, assertEquals, assertThrows } from "../test_utils.ts";

// ---------------------------------------------------------------------------
// decodeRpcMessage: each message type returns the correct discriminated union
// ---------------------------------------------------------------------------

Deno.test("decodeRpcMessage decodes bootstrap request", () => {
  const frame = encodeBootstrapRequestFrame({ questionId: 42 });
  const msg = decodeRpcMessage(frame);
  assertEquals(msg.tag, "bootstrap");
  if (msg.tag === "bootstrap") {
    assertEquals(msg.data.questionId, 42);
  }
});

Deno.test("decodeRpcMessage decodes call request", () => {
  const frame = encodeCallRequestFrame({
    questionId: 7,
    interfaceId: 0xabcdn,
    methodId: 3,
    targetImportedCap: 1,
  });
  const msg = decodeRpcMessage(frame);
  assertEquals(msg.tag, "call");
  if (msg.tag === "call") {
    assertEquals(msg.data.questionId, 7);
    assertEquals(msg.data.interfaceId, 0xabcdn);
    assertEquals(msg.data.methodId, 3);
    assertEquals(msg.data.targetImportedCap, 1);
  }
});

Deno.test("decodeRpcMessage decodes return results", () => {
  const frame = encodeReturnResultsFrame({ answerId: 10 });
  const msg = decodeRpcMessage(frame);
  assertEquals(msg.tag, "return");
  if (msg.tag === "return") {
    assertEquals(msg.data.answerId, 10);
    assertEquals(msg.data.kind, "results");
  }
});

Deno.test("decodeRpcMessage decodes return exception", () => {
  const frame = encodeReturnExceptionFrame({
    answerId: 11,
    reason: "something failed",
  });
  const msg = decodeRpcMessage(frame);
  assertEquals(msg.tag, "return");
  if (msg.tag === "return") {
    assertEquals(msg.data.answerId, 11);
    assertEquals(msg.data.kind, "exception");
    if (msg.data.kind === "exception") {
      assertEquals(msg.data.reason, "something failed");
    }
  }
});

Deno.test("decodeRpcMessage decodes finish", () => {
  const frame = encodeFinishFrame({ questionId: 99 });
  const msg = decodeRpcMessage(frame);
  assertEquals(msg.tag, "finish");
  if (msg.tag === "finish") {
    assertEquals(msg.data.questionId, 99);
  }
});

Deno.test("decodeRpcMessage decodes release", () => {
  const frame = encodeReleaseFrame({ id: 5, referenceCount: 2 });
  const msg = decodeRpcMessage(frame);
  assertEquals(msg.tag, "release");
  if (msg.tag === "release") {
    assertEquals(msg.data.id, 5);
    assertEquals(msg.data.referenceCount, 2);
  }
});

Deno.test("decodeRpcMessage throws ProtocolError on unknown tag", () => {
  // Encode a valid bootstrap frame, then patch the tag to an unknown value.
  const frame = encodeBootstrapRequestFrame({ questionId: 1 });
  const patched = new Uint8Array(frame);
  // The tag is stored as a u16 at the start of the root struct's data section.
  // In a standard bootstrap frame the root struct pointer is at word 0 of
  // the segment (byte offset 8 in the full frame). The struct data starts
  // at the word following the pointer.  We locate the data section and
  // write an unsupported tag value there.
  const view = new DataView(
    patched.buffer,
    patched.byteOffset,
    patched.byteLength,
  );
  // Read root pointer to find data section
  const rootPtr = view.getBigUint64(8, true);
  const offset = Number((rootPtr >> 2n) & 0x3fff_ffffn);
  const dataByteOffset = 8 + (1 + offset) * 8; // segment start + (pointerWord + 1 + offset) * 8
  view.setUint16(dataByteOffset, 255, true); // tag = 255 (unsupported)

  assertThrows(
    () => decodeRpcMessage(patched),
    /unknown rpc message tag/,
  );
});

// ---------------------------------------------------------------------------
// dispatchRpcMessage: calls the right handler
// ---------------------------------------------------------------------------

function makeTrackingHandlers(): {
  handlers: RpcMessageHandlers<string>;
  calls: string[];
} {
  const calls: string[] = [];
  const handlers: RpcMessageHandlers<string> = {
    bootstrap(data) {
      calls.push("bootstrap");
      return `bootstrap:${data.questionId}`;
    },
    call(data) {
      calls.push("call");
      return `call:${data.questionId}`;
    },
    return(data) {
      calls.push("return");
      return `return:${data.answerId}`;
    },
    finish(data) {
      calls.push("finish");
      return `finish:${data.questionId}`;
    },
    release(data) {
      calls.push("release");
      return `release:${data.id}`;
    },
  };
  return { handlers, calls };
}

Deno.test("dispatchRpcMessage dispatches bootstrap to correct handler", () => {
  const frame = encodeBootstrapRequestFrame({ questionId: 1 });
  const msg = decodeRpcMessage(frame);
  const { handlers, calls } = makeTrackingHandlers();
  const result = dispatchRpcMessage(msg, handlers);
  assertEquals(result, "bootstrap:1");
  assertEquals(calls.length, 1);
  assertEquals(calls[0], "bootstrap");
});

Deno.test("dispatchRpcMessage dispatches call to correct handler", () => {
  const frame = encodeCallRequestFrame({
    questionId: 5,
    interfaceId: 0x1n,
    methodId: 0,
    targetImportedCap: 0,
  });
  const msg = decodeRpcMessage(frame);
  const { handlers, calls } = makeTrackingHandlers();
  const result = dispatchRpcMessage(msg, handlers);
  assertEquals(result, "call:5");
  assertEquals(calls.length, 1);
  assertEquals(calls[0], "call");
});

Deno.test("dispatchRpcMessage dispatches return to correct handler", () => {
  const frame = encodeReturnResultsFrame({ answerId: 20 });
  const msg = decodeRpcMessage(frame);
  const { handlers, calls } = makeTrackingHandlers();
  const result = dispatchRpcMessage(msg, handlers);
  assertEquals(result, "return:20");
  assertEquals(calls.length, 1);
  assertEquals(calls[0], "return");
});

Deno.test("dispatchRpcMessage dispatches finish to correct handler", () => {
  const frame = encodeFinishFrame({ questionId: 30 });
  const msg = decodeRpcMessage(frame);
  const { handlers, calls } = makeTrackingHandlers();
  const result = dispatchRpcMessage(msg, handlers);
  assertEquals(result, "finish:30");
  assertEquals(calls.length, 1);
  assertEquals(calls[0], "finish");
});

Deno.test("dispatchRpcMessage dispatches release to correct handler", () => {
  const frame = encodeReleaseFrame({ id: 8, referenceCount: 3 });
  const msg = decodeRpcMessage(frame);
  const { handlers, calls } = makeTrackingHandlers();
  const result = dispatchRpcMessage(msg, handlers);
  assertEquals(result, "release:8");
  assertEquals(calls.length, 1);
  assertEquals(calls[0], "release");
});

Deno.test("dispatchRpcMessage invokes only the matching handler", () => {
  // Encode all five message types and dispatch them, verifying that each
  // invocation calls exactly one handler and does not invoke the others.
  const frames: Uint8Array[] = [
    encodeBootstrapRequestFrame({ questionId: 1 }),
    encodeCallRequestFrame({
      questionId: 2,
      interfaceId: 0x1n,
      methodId: 0,
      targetImportedCap: 0,
    }),
    encodeReturnResultsFrame({ answerId: 3 }),
    encodeFinishFrame({ questionId: 4 }),
    encodeReleaseFrame({ id: 5, referenceCount: 1 }),
  ];

  const expectedTags = ["bootstrap", "call", "return", "finish", "release"];

  for (let i = 0; i < frames.length; i++) {
    const msg = decodeRpcMessage(frames[i]);
    const { handlers, calls } = makeTrackingHandlers();
    dispatchRpcMessage(msg, handlers);
    assertEquals(calls.length, 1);
    assertEquals(calls[0], expectedTags[i]);
  }
});

// ---------------------------------------------------------------------------
// dispatchRpcMessage: type-safe return values
// ---------------------------------------------------------------------------

Deno.test("dispatchRpcMessage returns the handler's return value", () => {
  const frame = encodeBootstrapRequestFrame({ questionId: 77 });
  const msg = decodeRpcMessage(frame);
  const result = dispatchRpcMessage<number>(msg, {
    bootstrap: (data) => data.questionId * 2,
    call: () => -1,
    return: () => -1,
    finish: () => -1,
    release: () => -1,
  });
  assertEquals(result, 154);
});

// ---------------------------------------------------------------------------
// decodeRpcMessage: data integrity round-trip
// ---------------------------------------------------------------------------

Deno.test("decodeRpcMessage preserves return flags", () => {
  const frame = encodeReturnResultsFrame({
    answerId: 50,
    releaseParamCaps: false,
    noFinishNeeded: true,
  });
  const msg = decodeRpcMessage(frame);
  assert(msg.tag === "return", "expected return tag");
  assertEquals(msg.data.releaseParamCaps, false);
  assertEquals(msg.data.noFinishNeeded, true);
});

Deno.test("decodeRpcMessage preserves finish flags", () => {
  const frame = encodeFinishFrame({
    questionId: 60,
    releaseResultCaps: false,
    requireEarlyCancellation: true,
  });
  const msg = decodeRpcMessage(frame);
  assert(msg.tag === "finish", "expected finish tag");
  assertEquals(msg.data.releaseResultCaps, false);
  assertEquals(msg.data.requireEarlyCancellation, true);
});
