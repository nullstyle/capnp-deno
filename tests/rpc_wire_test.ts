import {
  decodeBootstrapRequestFrame,
  decodeCallRequestFrame,
  decodeFinishFrame,
  decodeReleaseFrame,
  decodeReturnFrame,
  decodeRpcMessageTag,
  EMPTY_STRUCT_MESSAGE,
  encodeBootstrapRequestFrame,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  encodeReturnExceptionFrame,
  encodeReturnResultsFrame,
  extractBootstrapCapabilityIndex,
} from "../mod.ts";
import {
  BOOTSTRAP_Q1_SUCCESS_INBOUND,
  BOOTSTRAP_Q1_SUCCESS_OUTBOUND,
  CALL_BOOTSTRAP_CAP_Q2_INBOUND,
  CALL_BOOTSTRAP_CAP_Q2_OUTBOUND,
} from "./fixtures/rpc_frames.ts";
import { assertBytes, assertEquals, assertThrows } from "./test_utils.ts";

const MASK_30 = 0x3fff_ffffn;

function encodeSingleU32StructMessage(value: number): Uint8Array {
  const out = new Uint8Array(24);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, 0, true);
  view.setUint32(4, 2, true);
  view.setBigUint64(8, 0x0000_0001_0000_0000n, true); // root struct ptr {data=1, ptr=0}
  view.setUint32(16, value >>> 0, true);
  return out;
}

function signed30(value: bigint): number {
  const raw = Number(value & MASK_30);
  return (raw & (1 << 29)) !== 0 ? raw - (1 << 30) : raw;
}

function decodeSingleU32StructMessage(frame: Uint8Array): number {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const root = view.getBigUint64(8, true);
  const offset = signed30((root >> 2n) & MASK_30);
  const dataWord = 1 + offset;
  return view.getUint32(8 + (dataWord * 8), true);
}

function withFrameMutation(
  frame: Uint8Array,
  mutate: (view: DataView) => void,
): Uint8Array {
  const out = new Uint8Array(frame);
  mutate(new DataView(out.buffer, out.byteOffset, out.byteLength));
  return out;
}

Deno.test("rpc wire encodes bootstrap request frame matching fixture", () => {
  const encoded = encodeBootstrapRequestFrame({ questionId: 1 });
  assertBytes(encoded, Array.from(BOOTSTRAP_Q1_SUCCESS_INBOUND));

  const decoded = decodeBootstrapRequestFrame(encoded);
  assertEquals(decoded.questionId, 1);
});

Deno.test("rpc wire encodes call request frame matching fixture", () => {
  const encoded = encodeCallRequestFrame({
    questionId: 2,
    interfaceId: 0x1234n,
    methodId: 9,
    targetImportedCap: 1,
  });
  assertBytes(encoded, Array.from(CALL_BOOTSTRAP_CAP_Q2_INBOUND));

  const decoded = decodeCallRequestFrame(encoded);
  assertEquals(decoded.questionId, 2);
  assertEquals(decoded.interfaceId, 0x1234n);
  assertEquals(decoded.methodId, 9);
  assertEquals(decoded.targetImportedCap, 1);
  assertEquals(decoded.paramsCapTable.length, 0);
});

Deno.test("rpc wire transports non-empty call payload content", () => {
  const params = encodeSingleU32StructMessage(77);
  const encoded = encodeCallRequestFrame({
    questionId: 11,
    interfaceId: 0x1234n,
    methodId: 9,
    targetImportedCap: 3,
    paramsContent: params,
    paramsCapTable: [
      { tag: 1, id: 7 },
      { tag: 3, id: 9 },
    ],
  });

  const decoded = decodeCallRequestFrame(encoded);
  assertEquals(decoded.questionId, 11);
  assertEquals(decoded.interfaceId, 0x1234n);
  assertEquals(decoded.methodId, 9);
  assertEquals(decoded.targetImportedCap, 3);
  assertEquals(decoded.target.tag, 0);
  assertEquals(decodeSingleU32StructMessage(decoded.paramsContent), 77);
  assertEquals(decoded.paramsCapTable.length, 2);
  assertEquals(decoded.paramsCapTable[0].tag, 1);
  assertEquals(decoded.paramsCapTable[0].id, 7);
  assertEquals(decoded.paramsCapTable[1].tag, 3);
  assertEquals(decoded.paramsCapTable[1].id, 9);
});

Deno.test("rpc wire encodes and decodes promisedAnswer call targets", () => {
  const params = encodeSingleU32StructMessage(55);
  const encoded = encodeCallRequestFrame({
    questionId: 31,
    interfaceId: 0x1234n,
    methodId: 2,
    target: {
      tag: 1,
      promisedAnswer: {
        questionId: 17,
        transform: [
          { tag: 0 },
          { tag: 1, pointerIndex: 3 },
        ],
      },
    },
    paramsContent: params,
  });

  const decoded = decodeCallRequestFrame(encoded);
  assertEquals(decoded.questionId, 31);
  assertEquals(decoded.interfaceId, 0x1234n);
  assertEquals(decoded.methodId, 2);
  assertEquals(decoded.target.tag, 1);
  if (decoded.target.tag !== 1) {
    throw new Error(
      `expected promisedAnswer target, got: ${decoded.target.tag}`,
    );
  }
  assertEquals(decoded.target.promisedAnswer.questionId, 17);
  assertEquals(decoded.target.promisedAnswer.transform?.length, 2);
  assertEquals(decoded.target.promisedAnswer.transform?.[0].tag, 0);
  assertEquals(decoded.target.promisedAnswer.transform?.[1].tag, 1);
  assertEquals(decoded.target.promisedAnswer.transform?.[1].pointerIndex, 3);
  assertEquals(decoded.targetImportedCap, undefined);
  assertEquals(decodeSingleU32StructMessage(decoded.paramsContent), 55);
});

Deno.test("rpc wire decodes bootstrap success return and extracts capability index", () => {
  const message = decodeReturnFrame(BOOTSTRAP_Q1_SUCCESS_OUTBOUND);
  assertEquals(message.kind, "results");
  assertEquals(message.answerId, 1);
  const capIndex = extractBootstrapCapabilityIndex(message);
  assertEquals(capIndex, 1);
});

Deno.test("rpc wire decodes call exception return", () => {
  const message = decodeReturnFrame(CALL_BOOTSTRAP_CAP_Q2_OUTBOUND);
  assertEquals(message.kind, "exception");
  assertEquals(message.answerId, 2);
  if (message.kind === "exception") {
    assertEquals(message.reason, "bootstrap stub");
  }
});

Deno.test("rpc wire encodes and decodes return results payload", () => {
  const payload = encodeSingleU32StructMessage(123);
  const frame = encodeReturnResultsFrame({
    answerId: 19,
    content: payload,
    capTable: [
      { tag: 1, id: 4 },
      { tag: 3, id: 5 },
    ],
    noFinishNeeded: true,
  });

  const decoded = decodeReturnFrame(frame);
  assertEquals(decoded.kind, "results");
  assertEquals(decoded.answerId, 19);
  assertEquals(decoded.noFinishNeeded, true);
  if (decoded.kind === "results") {
    assertEquals(decodeSingleU32StructMessage(decoded.contentBytes), 123);
    assertEquals(decoded.capTable.length, 2);
    assertEquals(decoded.capTable[0].tag, 1);
    assertEquals(decoded.capTable[0].id, 4);
    assertEquals(decoded.capTable[1].tag, 3);
    assertEquals(decoded.capTable[1].id, 5);
  }
});

Deno.test("rpc wire encodes and decodes return exceptions", () => {
  const frame = encodeReturnExceptionFrame({
    answerId: 5,
    reason: "kaboom",
  });

  const decoded = decodeReturnFrame(frame);
  assertEquals(decoded.kind, "exception");
  assertEquals(decoded.answerId, 5);
  if (decoded.kind === "exception") {
    assertEquals(decoded.reason, "kaboom");
  }
});

Deno.test("rpc wire encodes and decodes finish", () => {
  const frame = encodeFinishFrame({
    questionId: 29,
    releaseResultCaps: true,
    requireEarlyCancellation: false,
  });
  const decoded = decodeFinishFrame(frame);
  assertEquals(decoded.questionId, 29);
  assertEquals(decoded.releaseResultCaps, true);
  assertEquals(decoded.requireEarlyCancellation, false);
});

Deno.test("rpc wire encodes and decodes release", () => {
  const frame = encodeReleaseFrame({
    id: 9,
    referenceCount: 3,
  });
  const decoded = decodeReleaseFrame(frame);
  assertEquals(decoded.id, 9);
  assertEquals(decoded.referenceCount, 3);
});

Deno.test("rpc wire decode rejects message tag mismatches across decoders", () => {
  const bootstrap = encodeBootstrapRequestFrame({ questionId: 1 });
  const call = encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 9,
    targetImportedCap: 1,
  });
  const finish = encodeFinishFrame({ questionId: 1 });
  const release = encodeReleaseFrame({ id: 1, referenceCount: 1 });
  const ret = encodeReturnResultsFrame({ answerId: 1 });

  assertThrows(
    () => decodeBootstrapRequestFrame(call),
    /rpc message is not bootstrap/i,
  );
  assertThrows(
    () => decodeCallRequestFrame(bootstrap),
    /rpc message is not call/i,
  );
  assertThrows(() => decodeFinishFrame(release), /rpc message is not finish/i);
  assertThrows(() => decodeReleaseFrame(finish), /rpc message is not release/i);
  assertThrows(
    () => decodeReturnFrame(bootstrap),
    /rpc message is not return/i,
  );

  const nullReturnPayload = withFrameMutation(ret, (view) =>
    // Return struct pointer is at word 2.
    view.setBigUint64(8 + (2 * 8), 0n, true));
  assertThrows(
    () => decodeReturnFrame(nullReturnPayload),
    /return payload pointer is null/i,
  );
});

Deno.test("rpc wire bootstrap capability extraction reports failure cases", () => {
  const exception = decodeReturnFrame(
    encodeReturnExceptionFrame({
      answerId: 3,
      reason: "no bootstrap",
    }),
  );
  assertThrows(
    () => extractBootstrapCapabilityIndex(exception),
    /bootstrap failed: no bootstrap/i,
  );

  const noHostedCap = decodeReturnFrame(
    encodeReturnResultsFrame({
      answerId: 4,
      capTable: [{ tag: 2, id: 9 }],
    }),
  );
  assertThrows(
    () => extractBootstrapCapabilityIndex(noHostedCap),
    /did not include a hosted capability/i,
  );
});

Deno.test("rpc wire rejects truncated multi-segment frame header", () => {
  // Two segments declared, but no room for the second segment size.
  const frame = new Uint8Array(8);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  // segmentCountMinusOne=1 => two segments.
  view.setUint32(0, 1, true);

  assertThrows(
    () => decodeCallRequestFrame(frame),
    /rpc frame header is truncated/i,
  );
});

Deno.test("rpc wire rejects out-of-range struct pointers", () => {
  const frame = withFrameMutation(
    encodeCallRequestFrame({
      questionId: 1,
      interfaceId: 0x1234n,
      methodId: 9,
      targetImportedCap: 1,
    }),
    (view) => {
      // Root pointer at frame byte 8. Large positive struct offset => OOB.
      view.setBigUint64(8, 10_000n << 2n, true);
    },
  );

  assertThrows(
    () => decodeCallRequestFrame(frame),
    /struct pointer target out of range/i,
  );
});

Deno.test("rpc wire rejects out-of-range list pointers", () => {
  const frame = withFrameMutation(
    encodeCallRequestFrame({
      questionId: 1,
      interfaceId: 0x1234n,
      methodId: 9,
      targetImportedCap: 1,
    }),
    (view) => {
      // Payload struct lives at word 11. Pointer slot 1 (cap-table) at word 12.
      // Set an inline-composite list pointer with huge offset.
      const listPtr = 1n | (10_000n << 2n) | (7n << 32n) | (1n << 35n);
      view.setBigUint64(8 + (12 * 8), listPtr, true);
    },
  );

  assertThrows(
    () => decodeCallRequestFrame(frame),
    /out of range/i,
  );
});

Deno.test("rpc wire rejects unsupported call target tags", () => {
  const frame = withFrameMutation(
    encodeCallRequestFrame({
      questionId: 2,
      interfaceId: 0x1234n,
      methodId: 9,
      targetImportedCap: 1,
    }),
    (view) => {
      // Target struct is at word 9; target tag is u16 at byte offset 4.
      view.setUint16(8 + (9 * 8) + 4, 99, true);
    },
  );

  assertThrows(
    () => decodeCallRequestFrame(frame),
    /unsupported call target tag: 99/i,
  );
});

Deno.test("rpc wire rejects promisedAnswer call targets with null promised pointer", () => {
  const frame = withFrameMutation(
    encodeCallRequestFrame({
      questionId: 12,
      interfaceId: 0x1234n,
      methodId: 1,
      target: {
        tag: 1,
        promisedAnswer: {
          questionId: 7,
          transform: [],
        },
      },
    }),
    (view) => {
      // Target struct pointer slot 0 is at word 10.
      view.setBigUint64(8 + (10 * 8), 0n, true);
    },
  );

  assertThrows(
    () => decodeCallRequestFrame(frame),
    /promisedAnswer pointer is null/i,
  );
});

Deno.test("rpc wire rejects unsupported promisedAnswer transform op tags", () => {
  const frame = withFrameMutation(
    encodeCallRequestFrame({
      questionId: 12,
      interfaceId: 0x1234n,
      methodId: 1,
      target: {
        tag: 1,
        promisedAnswer: {
          questionId: 7,
          transform: [{ tag: 0 }],
        },
      },
    }),
    (view) => {
      // PromisedAnswer op[0] data word starts at word 14.
      view.setUint16(8 + (14 * 8), 99, true);
    },
  );

  assertThrows(
    () => decodeCallRequestFrame(frame),
    /unsupported promisedAnswer op tag: 99/i,
  );
});

Deno.test("rpc wire resolves far pointers in content pointer during decode", () => {
  // When a content pointer slot contains a far pointer in a single-segment
  // message, the far pointer resolution follows it within the same segment.
  // This verifies no crash occurs and the decoder proceeds.
  const frame = withFrameMutation(
    encodeCallRequestFrame({
      questionId: 3,
      interfaceId: 0x1234n,
      methodId: 9,
      targetImportedCap: 1,
      paramsContent: encodeSingleU32StructMessage(99),
    }),
    (view) => {
      // Payload struct is at word 11; pointer slot 0 (content) at word 11.
      // Set a single-far pointer to segment 0, word 13 (where the actual
      // content struct pointer data lives).
      // Far pointer: kind=2, doubleFar=0, offset=13 words, segmentId=0
      const farPtr = 2n | (13n << 3n) | (0n << 32n);
      view.setBigUint64(8 + (11 * 8), farPtr, true);
      // At word 13 write a struct pointer with offset=0, data=1, ptr=0
      // pointing to word 14 which contains the value 99.
      const structPtr = 0n | (0n << 2n) | (1n << 32n) | (0n << 48n);
      view.setBigUint64(8 + (13 * 8), structPtr, true);
      view.setUint32(8 + (14 * 8), 99, true);
    },
  );

  const decoded = decodeCallRequestFrame(frame);
  assertEquals(decoded.questionId, 3);
  assertEquals(decodeSingleU32StructMessage(decoded.paramsContent), 99);
});

Deno.test("rpc wire rejects unsupported return tags", () => {
  const frame = withFrameMutation(
    encodeReturnResultsFrame({
      answerId: 7,
      content: encodeSingleU32StructMessage(42),
    }),
    (view) => {
      // Return struct is at word 3; tag is u16 at byte offset 6.
      view.setUint16(8 + (3 * 8) + 6, 99, true);
    },
  );

  assertThrows(
    () => decodeReturnFrame(frame),
    /unsupported return tag: 99/i,
  );
});

Deno.test("rpc wire rejects short and truncated frames at decode boundaries", () => {
  assertThrows(
    () => decodeCallRequestFrame(new Uint8Array([0x00, 0x01, 0x02])),
    /rpc frame is too short/i,
  );

  const encoded = encodeCallRequestFrame({
    questionId: 4,
    interfaceId: 0x1234n,
    methodId: 9,
    targetImportedCap: 1,
  });
  const truncated = encoded.subarray(0, encoded.byteLength - 1);
  assertThrows(
    () => decodeCallRequestFrame(truncated),
    /segment payload is truncated/i,
  );
});

Deno.test("rpc wire decode guards root and payload null-pointer branches", () => {
  const nullRoot = new Uint8Array(16);
  const rootView = new DataView(
    nullRoot.buffer,
    nullRoot.byteOffset,
    nullRoot.byteLength,
  );
  rootView.setUint32(0, 0, true);
  rootView.setUint32(4, 1, true);
  assertThrows(
    () => decodeBootstrapRequestFrame(nullRoot),
    /root pointer is null/i,
  );

  const bootstrapNoPayload = withFrameMutation(
    encodeBootstrapRequestFrame({ questionId: 1 }),
    (view) => view.setBigUint64(8 + (2 * 8), 0n, true),
  );
  assertThrows(
    () => decodeBootstrapRequestFrame(bootstrapNoPayload),
    /bootstrap payload pointer is null/i,
  );

  const callNoPayload = withFrameMutation(
    encodeCallRequestFrame({
      questionId: 5,
      interfaceId: 0x1234n,
      methodId: 9,
      targetImportedCap: 1,
    }),
    (view) => view.setBigUint64(8 + (2 * 8), 0n, true),
  );
  assertThrows(
    () => decodeCallRequestFrame(callNoPayload),
    /call payload pointer is null/i,
  );

  const callNoTarget = withFrameMutation(
    encodeCallRequestFrame({
      questionId: 6,
      interfaceId: 0x1234n,
      methodId: 9,
      targetImportedCap: 1,
    }),
    (view) => view.setBigUint64(8 + (6 * 8), 0n, true),
  );
  assertThrows(
    () => decodeCallRequestFrame(callNoTarget),
    /call target pointer is null/i,
  );

  const finishNoPayload = withFrameMutation(
    encodeFinishFrame({ questionId: 7 }),
    (view) => view.setBigUint64(8 + (2 * 8), 0n, true),
  );
  assertThrows(
    () => decodeFinishFrame(finishNoPayload),
    /finish payload pointer is null/i,
  );

  const releaseNoPayload = withFrameMutation(
    encodeReleaseFrame({ id: 1, referenceCount: 1 }),
    (view) => view.setBigUint64(8 + (2 * 8), 0n, true),
  );
  assertThrows(
    () => decodeReleaseFrame(releaseNoPayload),
    /release payload pointer is null/i,
  );
});

Deno.test("rpc wire decode handles return exception/result pointer edge cases", () => {
  const exceptionNoPayload = withFrameMutation(
    encodeReturnExceptionFrame({ answerId: 8, reason: "boom" }),
    (view) => view.setBigUint64(8 + (5 * 8), 0n, true),
  );
  assertThrows(
    () => decodeReturnFrame(exceptionNoPayload),
    /return\.exception payload pointer is null/i,
  );

  const exceptionNoReason = withFrameMutation(
    encodeReturnExceptionFrame({ answerId: 9, reason: "boom" }),
    (view) => view.setBigUint64(8 + (7 * 8), 0n, true),
  );
  const noReason = decodeReturnFrame(exceptionNoReason);
  assertEquals(noReason.kind, "exception");
  if (noReason.kind === "exception") {
    assertEquals(noReason.reason, "");
  }

  const exceptionWrongReasonSize = withFrameMutation(
    encodeReturnExceptionFrame({ answerId: 10, reason: "boom" }),
    (view) => {
      // Reason pointer at word 7: set list pointer with elementSize=4 (not bytes).
      const wrong = 0x1n | (4n << 32n) | (1n << 35n);
      view.setBigUint64(8 + (7 * 8), wrong, true);
    },
  );
  assertThrows(
    () => decodeReturnFrame(exceptionWrongReasonSize),
    /expected byte list element size/i,
  );

  const resultsNoPayload = withFrameMutation(
    encodeReturnResultsFrame({
      answerId: 11,
      content: encodeSingleU32StructMessage(55),
      capTable: [{ tag: 1, id: 3 }],
    }),
    (view) => view.setBigUint64(8 + (5 * 8), 0n, true),
  );
  const noPayload = decodeReturnFrame(resultsNoPayload);
  assertEquals(noPayload.kind, "results");
  if (noPayload.kind === "results") {
    assertEquals(noPayload.capTable.length, 0);
    assertEquals(noPayload.contentBytes.byteLength, 16);
    const view = new DataView(
      noPayload.contentBytes.buffer,
      noPayload.contentBytes.byteOffset,
      noPayload.contentBytes.byteLength,
    );
    assertEquals(view.getBigUint64(8, true), 0n);
  }
});

Deno.test("rpc wire decode cap-table pointer validation catches malformed list forms", () => {
  const capTableKindMismatch = withFrameMutation(
    encodeCallRequestFrame({
      questionId: 12,
      interfaceId: 0x1234n,
      methodId: 9,
      targetImportedCap: 1,
    }),
    (view) => {
      // Payload cap-table pointer is at word 12.
      view.setBigUint64(8 + (12 * 8), 0x0000_0001_0000_0000n, true);
    },
  );
  assertThrows(
    () => decodeCallRequestFrame(capTableKindMismatch),
    /expected list pointer, got kind=0/i,
  );

  const capTableWrongElementSize = withFrameMutation(
    encodeCallRequestFrame({
      questionId: 13,
      interfaceId: 0x1234n,
      methodId: 9,
      targetImportedCap: 1,
    }),
    (view) => {
      const wrong = 0x1n | (2n << 32n) | (1n << 35n);
      view.setBigUint64(8 + (12 * 8), wrong, true);
    },
  );
  assertThrows(
    () => decodeCallRequestFrame(capTableWrongElementSize),
    /expected inline composite list pointer/i,
  );

  const capTableTagKindMismatch = withFrameMutation(
    encodeCallRequestFrame({
      questionId: 14,
      interfaceId: 0x1234n,
      methodId: 9,
      targetImportedCap: 1,
    }),
    (view) => {
      // Cap-table tag word for empty list is at word 13.
      view.setBigUint64(8 + (13 * 8), 0x1n, true);
    },
  );
  assertThrows(
    () => decodeCallRequestFrame(capTableTagKindMismatch),
    /invalid inline composite tag kind=1/i,
  );
});

Deno.test("rpc wire encode validation enforces scalar and payload invariants", () => {
  assertThrows(
    () =>
      encodeCallRequestFrame({
        questionId: -1,
        interfaceId: 1n,
        methodId: 0,
        targetImportedCap: 0,
      }),
    /questionId must be a u32/i,
  );
  assertThrows(
    () =>
      encodeCallRequestFrame({
        questionId: 1,
        interfaceId: -1n,
        methodId: 0,
        targetImportedCap: 0,
      }),
    /interfaceId must be a u64/i,
  );
  assertThrows(
    () =>
      encodeCallRequestFrame({
        questionId: 1,
        interfaceId: 1n,
        methodId: 70_000,
        targetImportedCap: 0,
      }),
    /methodId must be a u16/i,
  );
  assertThrows(
    () =>
      encodeCallRequestFrame({
        questionId: 1,
        interfaceId: 1n,
        methodId: 0,
        targetImportedCap: Number.NaN,
      }),
    /targetImportedCap must be a u32/i,
  );
  assertThrows(
    () =>
      encodeCallRequestFrame({
        questionId: 1,
        interfaceId: 1n,
        methodId: 0,
        targetImportedCap: 0,
        paramsContent: new Uint8Array(),
      }),
    /paramsContent must be a framed Cap'n Proto message/i,
  );
  assertThrows(
    () =>
      encodeCallRequestFrame({
        questionId: 1,
        interfaceId: 1n,
        methodId: 0,
        targetImportedCap: 0,
        paramsCapTable: [{ tag: -1, id: 1 }],
      }),
    /capTable\[0\]\.tag must be a u16/i,
  );
  assertThrows(
    () =>
      encodeCallRequestFrame({
        questionId: 1,
        interfaceId: 1n,
        methodId: 0,
        targetImportedCap: 0,
        paramsCapTable: [{ tag: 1, id: -1 }],
      }),
    /capTable\[0\]\.id must be a u32/i,
  );
});

Deno.test("rpc wire encode/decode handles null-root payloads and far-pointer rejection", () => {
  const nullRootPayload = new Uint8Array(16);
  const nullRootView = new DataView(
    nullRootPayload.buffer,
    nullRootPayload.byteOffset,
    nullRootPayload.byteLength,
  );
  nullRootView.setUint32(0, 0, true);
  nullRootView.setUint32(4, 1, true);

  const encoded = encodeCallRequestFrame({
    questionId: 15,
    interfaceId: 0x1234n,
    methodId: 9,
    targetImportedCap: 1,
    paramsContent: nullRootPayload,
  });
  const decoded = decodeCallRequestFrame(encoded);
  assertEquals(decoded.paramsContent.byteLength, 16);
  const paramsView = new DataView(
    decoded.paramsContent.buffer,
    decoded.paramsContent.byteOffset,
    decoded.paramsContent.byteLength,
  );
  assertEquals(paramsView.getBigUint64(8, true), 0n);

  const farRootPayload = new Uint8Array(16);
  const farRootView = new DataView(
    farRootPayload.buffer,
    farRootPayload.byteOffset,
    farRootPayload.byteLength,
  );
  farRootView.setUint32(0, 0, true);
  farRootView.setUint32(4, 1, true);
  farRootView.setBigUint64(8, 0x2n, true);

  assertThrows(
    () =>
      encodeCallRequestFrame({
        questionId: 16,
        interfaceId: 0x1234n,
        methodId: 9,
        targetImportedCap: 1,
        paramsContent: farRootPayload,
      }),
    /does not support far pointers yet/i,
  );
  assertThrows(
    () =>
      encodeReturnResultsFrame({
        answerId: 16,
        content: farRootPayload,
      }),
    /does not support far pointers yet/i,
  );
});

Deno.test("rpc wire encodes return flags and rejects malformed cap-table allocations", () => {
  const decoded = decodeReturnFrame(
    encodeReturnResultsFrame({
      answerId: 17,
      releaseParamCaps: false,
      noFinishNeeded: true,
    }),
  );
  assertEquals(decoded.answerId, 17);
  assertEquals(decoded.releaseParamCaps, false);
  assertEquals(decoded.noFinishNeeded, true);

  const malformedCapTable = {
    length: Number.POSITIVE_INFINITY,
    0: { tag: 1, id: 1 },
  } as unknown as Array<{ tag: number; id: number }>;
  assertThrows(
    () =>
      encodeReturnResultsFrame({
        answerId: 18,
        capTable: malformedCapTable,
      }),
    /allocWords requires non-negative integer/i,
  );
});

Deno.test("rpc wire decoders reject null root pointers across message kinds", () => {
  const nullRoot = new Uint8Array(16);
  const view = new DataView(
    nullRoot.buffer,
    nullRoot.byteOffset,
    nullRoot.byteLength,
  );
  view.setUint32(0, 0, true);
  view.setUint32(4, 1, true);

  assertThrows(() => decodeRpcMessageTag(nullRoot), /root pointer is null/i);
  assertThrows(() => decodeCallRequestFrame(nullRoot), /root pointer is null/i);
  assertThrows(() => decodeFinishFrame(nullRoot), /root pointer is null/i);
  assertThrows(() => decodeReleaseFrame(nullRoot), /root pointer is null/i);
  assertThrows(() => decodeReturnFrame(nullRoot), /root pointer is null/i);
});

Deno.test("rpc wire decodes null content and null cap-table pointers in payloads", () => {
  const frame = withFrameMutation(
    encodeCallRequestFrame({
      questionId: 33,
      interfaceId: 0x1234n,
      methodId: 2,
      targetImportedCap: 1,
      paramsContent: encodeSingleU32StructMessage(7),
      paramsCapTable: [{ tag: 1, id: 9 }],
    }),
    (view) => {
      // Payload struct at word 11: pointer[0]=content, pointer[1]=capTable.
      view.setBigUint64(8 + (11 * 8), 0n, true);
      view.setBigUint64(8 + (12 * 8), 0n, true);
    },
  );

  const decoded = decodeCallRequestFrame(frame);
  assertEquals(decoded.paramsCapTable.length, 0);
  assertEquals(
    decoded.paramsContent.byteLength,
    EMPTY_STRUCT_MESSAGE.byteLength,
  );
  const rootWord = new DataView(
    decoded.paramsContent.buffer,
    decoded.paramsContent.byteOffset,
    decoded.paramsContent.byteLength,
  ).getBigUint64(8, true);
  assertEquals(rootWord, 0n);
});

Deno.test("rpc wire decodes non-NUL exception text and validates byte-list bounds", () => {
  const nonNulReason = withFrameMutation(
    encodeReturnExceptionFrame({ answerId: 34, reason: "ab" }),
    (view) => {
      // Reason pointer is at word 7; force elementCount=2 (drop trailing NUL).
      const current = view.getBigUint64(8 + (7 * 8), true);
      const next = (current & ~(0x1fff_ffffn << 35n)) | (2n << 35n);
      view.setBigUint64(8 + (7 * 8), next, true);
    },
  );
  const decoded = decodeReturnFrame(nonNulReason);
  assertEquals(decoded.kind, "exception");
  if (decoded.kind === "exception") {
    assertEquals(decoded.reason, "ab");
  }

  const outOfRangeReason = withFrameMutation(
    encodeReturnExceptionFrame({ answerId: 35, reason: "x" }),
    (view) => {
      const bad = 0x1n | (10_000n << 2n) | (2n << 32n) | (1n << 35n);
      view.setBigUint64(8 + (7 * 8), bad, true);
    },
  );
  assertThrows(
    () => decodeReturnFrame(outOfRangeReason),
    /byte list pointer target out of range/i,
  );
});

Deno.test("rpc wire handles finish flag variants and receiver-hosted bootstrap caps", () => {
  const finish = decodeFinishFrame(
    encodeFinishFrame({
      questionId: 36,
      releaseResultCaps: false,
      requireEarlyCancellation: true,
    }),
  );
  assertEquals(finish.questionId, 36);
  assertEquals(finish.releaseResultCaps, false);
  assertEquals(finish.requireEarlyCancellation, true);

  const results = decodeReturnFrame(
    encodeReturnResultsFrame({
      answerId: 37,
      capTable: [{ tag: 3, id: 77 }],
    }),
  );
  assertEquals(extractBootstrapCapabilityIndex(results), 77);
});

Deno.test("rpc wire rejects non-struct root pointers and preserves opaque source root kinds", () => {
  const wrongRootKind = withFrameMutation(
    encodeCallRequestFrame({
      questionId: 38,
      interfaceId: 0x1234n,
      methodId: 2,
      targetImportedCap: 1,
    }),
    (view) => {
      // list pointer kind at root slot
      view.setBigUint64(8, 0x1n, true);
    },
  );
  assertThrows(
    () => decodeCallRequestFrame(wrongRootKind),
    /expected struct pointer, got kind=1/i,
  );

  const opaqueRootPayload = new Uint8Array(16);
  const payloadView = new DataView(
    opaqueRootPayload.buffer,
    opaqueRootPayload.byteOffset,
    opaqueRootPayload.byteLength,
  );
  payloadView.setUint32(0, 0, true);
  payloadView.setUint32(4, 1, true);
  payloadView.setBigUint64(8, 0x3n, true);

  const encoded = encodeCallRequestFrame({
    questionId: 39,
    interfaceId: 0x1234n,
    methodId: 2,
    targetImportedCap: 1,
    paramsContent: opaqueRootPayload,
  });
  const decoded = decodeCallRequestFrame(encoded);
  const copiedRoot = new DataView(
    decoded.paramsContent.buffer,
    decoded.paramsContent.byteOffset,
    decoded.paramsContent.byteLength,
  ).getBigUint64(8, true);
  assertEquals(Number(copiedRoot & 0x3n), 3);
});

// ----------------------------------------------------------------
// Multi-segment and far pointer tests
// ----------------------------------------------------------------

/**
 * Helper to build a raw multi-segment Cap'n Proto frame from an array
 * of segment byte arrays. Each segment must be word-aligned.
 */
function buildMultiSegmentFrame(segments: Uint8Array[]): Uint8Array {
  const segmentCount = segments.length;
  // Header: (1 + segmentCount) u32 values, padded to 8-byte alignment
  const headerU32Count = 1 + segmentCount;
  const headerBytes = Math.ceil((headerU32Count * 4) / 8) * 8;

  let totalSegmentBytes = 0;
  for (const seg of segments) totalSegmentBytes += seg.byteLength;

  const out = new Uint8Array(headerBytes + totalSegmentBytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, segmentCount - 1, true);
  for (let i = 0; i < segmentCount; i += 1) {
    view.setUint32(4 + i * 4, segments[i].byteLength / 8, true);
  }

  let cursor = headerBytes;
  for (const seg of segments) {
    out.set(seg, cursor);
    cursor += seg.byteLength;
  }
  return out;
}

/**
 * Helper: build a segment as a typed Uint8Array from word-level bigints.
 */
function segmentFromWords(...words: bigint[]): Uint8Array {
  const buf = new Uint8Array(words.length * 8);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < words.length; i += 1) {
    dv.setBigUint64(i * 8, words[i], true);
  }
  return buf;
}

/**
 * Encode a struct pointer word.
 * kind=0, offset in bits[2..31], dataWords in bits[32..47], ptrCount in bits[48..63]
 */
function structPtr(
  offset: number,
  dataWords: number,
  ptrCount: number,
): bigint {
  const off = offset < 0 ? offset + (1 << 30) : offset;
  return (BigInt(off & 0x3fffffff) << 2n) |
    (BigInt(dataWords & 0xffff) << 32n) |
    (BigInt(ptrCount & 0xffff) << 48n);
}

/**
 * Encode a single-far pointer word.
 * kind=2, B=0, offset (word in target segment), segmentId
 */
function singleFarPtr(wordOffset: number, segmentId: number): bigint {
  return 2n |
    (BigInt(wordOffset) << 3n) |
    (BigInt(segmentId) << 32n);
}

/**
 * Encode a double-far pointer word.
 * kind=2, B=1, offset (word in landing pad segment), segmentId
 */
function doubleFarPtr(wordOffset: number, segmentId: number): bigint {
  return 2n |
    (1n << 2n) |
    (BigInt(wordOffset) << 3n) |
    (BigInt(segmentId) << 32n);
}

Deno.test("rpc wire decodes a two-segment bootstrap frame with far pointer to root", () => {
  // Segment 0: word 0 = far pointer to segment 1, word 0
  // Segment 1: word 0 = struct pointer (Message) to word 1
  //            word 1 = data word (tag = bootstrap = 8)
  //            word 2 = struct pointer (Bootstrap) to word 3
  //            word 3 = data word (questionId = 42)
  //            word 4 = padding (Bootstrap ptr slot)
  const seg0 = segmentFromWords(
    singleFarPtr(0, 1), // far ptr -> segment 1, word 0
  );
  const seg1 = segmentFromWords(
    structPtr(0, 1, 1), // Message: offset=0 -> word 1, data=1, ptr=1
    8n, // Message.data[0]: tag = 8 (bootstrap), u16 at byte 0
    structPtr(0, 1, 1), // ptr[0] -> Bootstrap struct at word 3, data=1, ptr=1
    42n, // Bootstrap.data[0]: questionId = 42
    0n, // Bootstrap.ptr[0]: null (deprecatedObjectId)
  );

  const frame = buildMultiSegmentFrame([seg0, seg1]);
  const decoded = decodeBootstrapRequestFrame(frame);
  assertEquals(decoded.questionId, 42);
});

Deno.test("rpc wire decodes a two-segment release frame with far pointer", () => {
  // Segment 0: word 0 = far pointer to segment 1, word 0
  // Segment 1: word 0 = struct pointer (Message) -> word 1
  //            word 1 = data (tag = release = 6)
  //            word 2 = struct pointer (Release) -> word 3
  //            word 3 = data (id=7, referenceCount=3)
  const seg0 = segmentFromWords(
    singleFarPtr(0, 1),
  );
  // Build segment 1 data manually for Release
  const seg1Buf = new Uint8Array(4 * 8);
  const seg1View = new DataView(seg1Buf.buffer);
  // word 0: Message struct pointer: offset=0, data=1, ptr=1
  seg1View.setBigUint64(0, structPtr(0, 1, 1), true);
  // word 1: Message data: tag = 6 (release) as u16 at byte 0
  seg1View.setUint16(8, 6, true);
  // word 2: ptr[0] = struct pointer -> word 3, data=1, ptr=0
  seg1View.setBigUint64(16, structPtr(0, 1, 0), true);
  // word 3: Release data: id=7 (u32 at byte 0), referenceCount=3 (u32 at byte 4)
  seg1View.setUint32(24, 7, true);
  seg1View.setUint32(28, 3, true);

  const frame = buildMultiSegmentFrame([seg0, seg1Buf]);
  const decoded = decodeReleaseFrame(frame);
  assertEquals(decoded.id, 7);
  assertEquals(decoded.referenceCount, 3);
});

Deno.test("rpc wire decodes a three-segment finish frame with chained far pointers", () => {
  // Segment 0: word 0 = far pointer to segment 1, word 0
  // Segment 1: word 0 = far pointer to segment 2, word 0  (chained single-far)
  // Segment 2: word 0 = struct pointer (Message) -> word 1
  //            word 1 = data (tag = finish = 4)
  //            word 2 = struct pointer (Finish) -> word 3
  //            word 3 = data (questionId=99, flags)
  const seg0 = segmentFromWords(
    singleFarPtr(0, 1),
  );
  const seg1 = segmentFromWords(
    singleFarPtr(0, 2),
  );

  const seg2Buf = new Uint8Array(4 * 8);
  const seg2View = new DataView(seg2Buf.buffer);
  seg2View.setBigUint64(0, structPtr(0, 1, 1), true);
  seg2View.setUint16(8, 4, true); // tag = finish
  seg2View.setBigUint64(16, structPtr(0, 1, 0), true);
  seg2View.setUint32(24, 99, true); // questionId
  // flags: releaseResultCaps=true (bit0=0), requireEarlyCancellation=true (bit1=0)
  seg2View.setUint32(28, 0, true);

  const frame = buildMultiSegmentFrame([seg0, seg1, seg2Buf]);
  const decoded = decodeFinishFrame(frame);
  assertEquals(decoded.questionId, 99);
  assertEquals(decoded.releaseResultCaps, true);
  assertEquals(decoded.requireEarlyCancellation, true);
});

Deno.test("rpc wire decodes a double-far pointer across segments", () => {
  // Double-far pointer: segment 0 root -> landing pad in segment 1 ->
  // actual data in segment 2.
  //
  // Segment 0: word 0 = double-far pointer (B=1) to segment 1, word 0
  // Segment 1: word 0 = single-far pointer to segment 2, word 0 (the data location)
  //            word 1 = tag word (struct pointer with offset=0, data=1, ptr=1)
  // Segment 2: word 0 = Message data: tag = bootstrap = 8
  //            word 1 = struct pointer (Bootstrap) -> word 2
  //            word 2 = data (questionId = 77)
  //            word 3 = padding (Bootstrap ptr slot)
  const seg0 = segmentFromWords(
    doubleFarPtr(0, 1),
  );
  const seg1 = segmentFromWords(
    singleFarPtr(0, 2), // pad[0]: far ptr to segment 2, word 0
    structPtr(0, 1, 1), // pad[1]: tag = struct(data=1, ptr=1), offset is ignored (treated as 0)
  );

  const seg2Buf = new Uint8Array(4 * 8);
  const seg2View = new DataView(seg2Buf.buffer);
  // word 0: Message data: tag = 8 (bootstrap)
  seg2View.setUint16(0, 8, true);
  // word 1: ptr[0] = struct pointer (Bootstrap) -> word 2, data=1, ptr=1
  seg2View.setBigUint64(8, structPtr(0, 1, 1), true);
  // word 2: questionId = 77
  seg2View.setUint32(16, 77, true);
  // word 3: Bootstrap ptr slot = null
  seg2View.setBigUint64(24, 0n, true);

  const frame = buildMultiSegmentFrame([seg0, seg1, seg2Buf]);
  const decoded = decodeBootstrapRequestFrame(frame);
  assertEquals(decoded.questionId, 77);
});

Deno.test("rpc wire decodes return exception from two-segment frame", () => {
  // Build a Return(exception) message split across two segments.
  // Segment 0 has the root + far pointer to segment 1.
  // Segment 1 has the Return struct and Exception with reason text.

  // First build a single-segment version, then split it.
  const singleFrame = encodeReturnExceptionFrame({
    answerId: 55,
    reason: "multi-seg error",
  });

  // Parse the single frame to get the segment data
  const singleView = new DataView(
    singleFrame.buffer,
    singleFrame.byteOffset,
    singleFrame.byteLength,
  );
  const segWords = singleView.getUint32(4, true);
  const segData = singleFrame.subarray(8, 8 + segWords * 8);

  // Create a two-segment version where segment 0 has just a far pointer
  // and segment 1 has all the actual data.
  const seg0 = segmentFromWords(
    singleFarPtr(0, 1), // far ptr -> segment 1, word 0
  );

  // Segment 1 = the original segment data, but we need to adjust the root
  // pointer. The original root pointer at word 0 is a struct pointer with
  // offset to word 1. In segment 1, the data starts at word 0, so we
  // keep the same layout.
  const seg1 = new Uint8Array(segData);

  const frame = buildMultiSegmentFrame([seg0, seg1]);
  const decoded = decodeReturnFrame(frame);
  assertEquals(decoded.kind, "exception");
  assertEquals(decoded.answerId, 55);
  if (decoded.kind === "exception") {
    assertEquals(decoded.reason, "multi-seg error");
  }
});

Deno.test("rpc wire decodes return results from two-segment frame", () => {
  // Similar approach: build single-segment Return(results), then wrap
  // with a far pointer in segment 0.
  const singleFrame = encodeReturnResultsFrame({
    answerId: 88,
    content: encodeSingleU32StructMessage(12345),
    capTable: [{ tag: 1, id: 42 }],
  });

  const singleView = new DataView(
    singleFrame.buffer,
    singleFrame.byteOffset,
    singleFrame.byteLength,
  );
  const segWords = singleView.getUint32(4, true);
  const segData = singleFrame.subarray(8, 8 + segWords * 8);

  const seg0 = segmentFromWords(singleFarPtr(0, 1));
  const seg1 = new Uint8Array(segData);

  const frame = buildMultiSegmentFrame([seg0, seg1]);
  const decoded = decodeReturnFrame(frame);
  assertEquals(decoded.kind, "results");
  assertEquals(decoded.answerId, 88);
  if (decoded.kind === "results") {
    assertEquals(decodeSingleU32StructMessage(decoded.contentBytes), 12345);
    assertEquals(decoded.capTable.length, 1);
    assertEquals(decoded.capTable[0].tag, 1);
    assertEquals(decoded.capTable[0].id, 42);
  }
});

Deno.test("rpc wire decodes call from two-segment frame", () => {
  const singleFrame = encodeCallRequestFrame({
    questionId: 77,
    interfaceId: 0xABCDn,
    methodId: 5,
    targetImportedCap: 3,
    paramsContent: encodeSingleU32StructMessage(333),
    paramsCapTable: [{ tag: 1, id: 10 }],
  });

  const singleView = new DataView(
    singleFrame.buffer,
    singleFrame.byteOffset,
    singleFrame.byteLength,
  );
  const segWords = singleView.getUint32(4, true);
  const segData = singleFrame.subarray(8, 8 + segWords * 8);

  const seg0 = segmentFromWords(singleFarPtr(0, 1));
  const seg1 = new Uint8Array(segData);

  const frame = buildMultiSegmentFrame([seg0, seg1]);
  const decoded = decodeCallRequestFrame(frame);
  assertEquals(decoded.questionId, 77);
  assertEquals(decoded.interfaceId, 0xABCDn);
  assertEquals(decoded.methodId, 5);
  assertEquals(decoded.targetImportedCap, 3);
  assertEquals(decodeSingleU32StructMessage(decoded.paramsContent), 333);
  assertEquals(decoded.paramsCapTable.length, 1);
  assertEquals(decoded.paramsCapTable[0].tag, 1);
  assertEquals(decoded.paramsCapTable[0].id, 10);
});

Deno.test("rpc wire decodes message tag from multi-segment frame", () => {
  const singleFrame = encodeBootstrapRequestFrame({ questionId: 1 });
  const singleView = new DataView(
    singleFrame.buffer,
    singleFrame.byteOffset,
    singleFrame.byteLength,
  );
  const segWords = singleView.getUint32(4, true);
  const segData = singleFrame.subarray(8, 8 + segWords * 8);

  const seg0 = segmentFromWords(singleFarPtr(0, 1));
  const seg1 = new Uint8Array(segData);
  const frame = buildMultiSegmentFrame([seg0, seg1]);

  assertEquals(decodeRpcMessageTag(frame), 8); // bootstrap tag
});

Deno.test("rpc wire rejects far pointer to out-of-bounds segment", () => {
  // Far pointer referencing segment 5 which doesn't exist
  const seg0 = segmentFromWords(
    singleFarPtr(0, 5),
  );
  const frame = buildMultiSegmentFrame([seg0]);
  assertThrows(
    () => decodeBootstrapRequestFrame(frame),
    /references missing segment/i,
  );
});

Deno.test("rpc wire rejects far pointer chain exceeding hop limit", () => {
  // Create a cycle: segment 0 word 0 -> segment 1 word 0 -> segment 0 word 0
  const seg0 = segmentFromWords(singleFarPtr(0, 1));
  const seg1 = segmentFromWords(singleFarPtr(0, 0));
  const frame = buildMultiSegmentFrame([seg0, seg1]);
  assertThrows(
    () => decodeBootstrapRequestFrame(frame),
    /far pointer chain exceeded maximum hop count/i,
  );
});

Deno.test("rpc wire rejects double-far with double-far in landing pad[0]", () => {
  // Segment 0: double-far to segment 1, word 0
  // Segment 1: word 0 = double-far (invalid: pad[0] must be single-far)
  //            word 1 = struct tag
  const seg0 = segmentFromWords(doubleFarPtr(0, 1));
  const seg1 = segmentFromWords(
    doubleFarPtr(0, 0), // pad[0] is double-far (invalid)
    structPtr(0, 1, 0), // pad[1] tag
  );
  const frame = buildMultiSegmentFrame([seg0, seg1]);
  assertThrows(
    () => decodeBootstrapRequestFrame(frame),
    /must be a single-far pointer/i,
  );
});

Deno.test("rpc wire rejects double-far with non-far landing pad[0]", () => {
  // Segment 0: double-far to segment 1, word 0
  // Segment 1: word 0 = struct pointer (not a far pointer - invalid)
  //            word 1 = struct tag
  const seg0 = segmentFromWords(doubleFarPtr(0, 1));
  const seg1 = segmentFromWords(
    structPtr(0, 1, 0), // pad[0] is struct pointer (invalid)
    structPtr(0, 1, 0), // pad[1] tag
  );
  const frame = buildMultiSegmentFrame([seg0, seg1]);
  assertThrows(
    () => decodeBootstrapRequestFrame(frame),
    /must be far pointer/i,
  );
});

Deno.test("rpc wire handles multi-segment frame with all data in segment 0", () => {
  // Two segments but all data in segment 0 (segment 1 is empty padding).
  // No far pointers needed.
  const singleFrame = encodeBootstrapRequestFrame({ questionId: 123 });
  const singleView = new DataView(
    singleFrame.buffer,
    singleFrame.byteOffset,
    singleFrame.byteLength,
  );
  const segWords = singleView.getUint32(4, true);
  const segData = singleFrame.subarray(8, 8 + segWords * 8);

  // Build a two-segment frame where segment 0 has all the data
  // and segment 1 is a single empty word.
  const seg1 = segmentFromWords(0n);
  const frame = buildMultiSegmentFrame([segData, seg1]);
  const decoded = decodeBootstrapRequestFrame(frame);
  assertEquals(decoded.questionId, 123);
});

Deno.test("rpc wire encoding still rejects far pointers in payload content input", () => {
  // The encoding path (encodeCallRequestFrame with paramsContent) still uses
  // segmentFromFrame which only accepts single-segment content and
  // rebaseCopiedRootPointer which rejects far pointers.
  const farRootPayload = new Uint8Array(16);
  const farRootView = new DataView(
    farRootPayload.buffer,
    farRootPayload.byteOffset,
    farRootPayload.byteLength,
  );
  farRootView.setUint32(0, 0, true);
  farRootView.setUint32(4, 1, true);
  farRootView.setBigUint64(8, 0x2n, true);

  assertThrows(
    () =>
      encodeCallRequestFrame({
        questionId: 50,
        interfaceId: 0x1234n,
        methodId: 0,
        targetImportedCap: 0,
        paramsContent: farRootPayload,
      }),
    /does not support far pointers yet/i,
  );
});
