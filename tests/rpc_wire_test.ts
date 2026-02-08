import {
  decodeBootstrapRequestFrame,
  decodeCallRequestFrame,
  decodeFinishFrame,
  decodeReleaseFrame,
  decodeReturnFrame,
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
import { assertBytes, assertEquals } from "./test_utils.ts";

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
  assertEquals(decodeSingleU32StructMessage(decoded.paramsContent), 77);
  assertEquals(decoded.paramsCapTable.length, 2);
  assertEquals(decoded.paramsCapTable[0].tag, 1);
  assertEquals(decoded.paramsCapTable[0].id, 7);
  assertEquals(decoded.paramsCapTable[1].tag, 3);
  assertEquals(decoded.paramsCapTable[1].id, 9);
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
