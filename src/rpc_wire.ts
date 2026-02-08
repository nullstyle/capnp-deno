import { ProtocolError } from "./errors.ts";

const WORD_BYTES = 8;
const MASK_30 = 0x3fff_ffffn;
const POINTER_OFFSET_MASK = MASK_30 << 2n;

/** Tag value for a Cap'n Proto RPC Call message. */
export const RPC_MESSAGE_TAG_CALL = 2;
/** Tag value for a Cap'n Proto RPC Return message. */
export const RPC_MESSAGE_TAG_RETURN = 3;
/** Tag value for a Cap'n Proto RPC Finish message. */
export const RPC_MESSAGE_TAG_FINISH = 4;
/** Tag value for a Cap'n Proto RPC Release message. */
export const RPC_MESSAGE_TAG_RELEASE = 6;
/** Tag value for a Cap'n Proto RPC Bootstrap message. */
export const RPC_MESSAGE_TAG_BOOTSTRAP = 8;

/** Call target tag: the target is an imported capability. */
export const RPC_CALL_TARGET_TAG_IMPORTED_CAP = 0;
/** Call target tag: the target is a promised answer (pipelined call). */
export const RPC_CALL_TARGET_TAG_PROMISED_ANSWER = 1;

/** PromisedAnswer transform op: no-op (identity). */
export const RPC_PROMISED_ANSWER_OP_TAG_NOOP = 0;
/** PromisedAnswer transform op: follow a pointer field in the result struct. */
export const RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD = 1;

const RETURN_TAG_RESULTS = 0;
const RETURN_TAG_EXCEPTION = 1;

const CAP_DESCRIPTOR_TAG_SENDER_HOSTED = 1;
const CAP_DESCRIPTOR_TAG_RECEIVER_HOSTED = 3;

/**
 * A minimal Cap'n Proto message containing an empty struct.
 * Used as the default content for payloads that carry no data.
 */
export const EMPTY_STRUCT_MESSAGE: Uint8Array = new Uint8Array([
  0x00,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
]);

/** Parameters for encoding a Bootstrap request frame. */
export interface RpcBootstrapRequest {
  /** The question ID assigned to this bootstrap request. */
  questionId: number;
}

/** Decoded representation of a Cap'n Proto RPC Call message. */
export interface RpcCallRequest {
  questionId: number;
  interfaceId: bigint;
  methodId: number;
  target: RpcCallTarget;
  targetImportedCap?: number;
  paramsContent: Uint8Array;
  paramsCapTable: RpcCapDescriptor[];
}

/** Decoded representation of a Cap'n Proto RPC Finish message. */
export interface RpcFinishRequest {
  /** The question ID to finish. */
  questionId: number;
  /** Whether to release capabilities in the result. */
  releaseResultCaps: boolean;
  /** Whether early cancellation is required. */
  requireEarlyCancellation: boolean;
}

/** Decoded representation of a Cap'n Proto RPC Release message. */
export interface RpcReleaseRequest {
  id: number;
  referenceCount: number;
}

/** Parameters for encoding a Call request frame via {@link encodeCallRequestFrame}. */
export interface RpcCallFrameRequest {
  questionId: number;
  interfaceId: bigint;
  methodId: number;
  targetImportedCap?: number;
  target?: RpcCallTarget;
  paramsContent?: Uint8Array;
  paramsCapTable?: RpcCapDescriptor[];
}

/** A single transform operation in a PromisedAnswer pipeline. */
export interface RpcPromisedAnswerOp {
  tag: number;
  pointerIndex?: number;
}

/** A PromisedAnswer call target referencing a previous question's result. */
export interface RpcPromisedAnswerTarget {
  questionId: number;
  transform?: RpcPromisedAnswerOp[];
}

/** Discriminated union of call target types: imported capability or promised answer. */
export type RpcCallTarget =
  | {
    tag: typeof RPC_CALL_TARGET_TAG_IMPORTED_CAP;
    importedCap: number;
  }
  | {
    tag: typeof RPC_CALL_TARGET_TAG_PROMISED_ANSWER;
    promisedAnswer: RpcPromisedAnswerTarget;
  };

/** A capability descriptor in a Cap'n Proto RPC payload's capability table. */
export interface RpcCapDescriptor {
  /** The descriptor tag (e.g., senderHosted=1, receiverHosted=3). */
  tag: number;
  /** The capability ID (export/import table index). */
  id: number;
}

interface RpcReturnBase {
  answerId: number;
  releaseParamCaps: boolean;
  noFinishNeeded: boolean;
}

/** A successful Return message containing results. */
export interface RpcReturnResults extends RpcReturnBase {
  kind: "results";
  contentBytes: Uint8Array;
  capTable: RpcCapDescriptor[];
}

/** A Return message indicating an exception/error. */
export interface RpcReturnException extends RpcReturnBase {
  kind: "exception";
  reason: string;
}

/** Discriminated union of Return message types: results or exception. */
export type RpcReturnMessage = RpcReturnResults | RpcReturnException;

/** Parameters for encoding a Return results frame via {@link encodeReturnResultsFrame}. */
export interface RpcReturnResultsFrameRequest {
  answerId: number;
  content?: Uint8Array;
  capTable?: RpcCapDescriptor[];
  releaseParamCaps?: boolean;
  noFinishNeeded?: boolean;
}

/** Parameters for encoding a Return exception frame via {@link encodeReturnExceptionFrame}. */
export interface RpcReturnExceptionFrameRequest {
  answerId: number;
  reason: string;
  releaseParamCaps?: boolean;
  noFinishNeeded?: boolean;
}

interface StructRef {
  startWord: number;
  dataWordCount: number;
  pointerCount: number;
}

interface ByteListRef {
  startWord: number;
  elementCount: number;
}

interface StructListRef {
  elementsStartWord: number;
  elementCount: number;
  dataWordCount: number;
  pointerCount: number;
}

function signed30(value: bigint): number {
  const raw = Number(value & MASK_30);
  return (raw & (1 << 29)) !== 0 ? raw - (1 << 30) : raw;
}

function ensureRange(
  segment: Uint8Array,
  byteOffset: number,
  len: number,
  context: string,
): void {
  if (byteOffset < 0 || byteOffset + len > segment.byteLength) {
    throw new ProtocolError(
      `${context} out of range: offset=${byteOffset} len=${len} segment=${segment.byteLength}`,
    );
  }
}

function segmentFromFrame(frame: Uint8Array): Uint8Array {
  if (frame.byteLength < 8) {
    throw new ProtocolError("rpc frame is too short");
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const segmentCount = view.getUint32(0, true) + 1;
  if (segmentCount !== 1) {
    throw new ProtocolError(
      `rpc frame currently supports single segment only, got ${segmentCount}`,
    );
  }
  const segmentWords = view.getUint32(4, true);
  const segmentBytes = segmentWords * WORD_BYTES;
  if (frame.byteLength < 8 + segmentBytes) {
    throw new ProtocolError("rpc frame segment payload is truncated");
  }
  return frame.subarray(8, 8 + segmentBytes);
}

function frameFromSegment(segment: Uint8Array): Uint8Array {
  if (segment.byteLength % WORD_BYTES !== 0) {
    throw new ProtocolError(
      `segment length must be word-aligned, got ${segment.byteLength}`,
    );
  }
  const words = segment.byteLength / WORD_BYTES;
  const out = new Uint8Array(8 + segment.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, 0, true);
  view.setUint32(4, words, true);
  out.set(segment, 8);
  return out;
}

function readWord(segment: Uint8Array, wordIndex: number): bigint {
  const byteOffset = wordIndex * WORD_BYTES;
  ensureRange(segment, byteOffset, WORD_BYTES, "readWord");
  const view = new DataView(
    segment.buffer,
    segment.byteOffset,
    segment.byteLength,
  );
  return view.getBigUint64(byteOffset, true);
}

function writeWord(
  segment: Uint8Array,
  wordIndex: number,
  value: bigint,
): void {
  const byteOffset = wordIndex * WORD_BYTES;
  ensureRange(segment, byteOffset, WORD_BYTES, "writeWord");
  new DataView(segment.buffer, segment.byteOffset, segment.byteLength)
    .setBigUint64(byteOffset, value, true);
}

function rebasePointerWord(
  pointerWord: bigint,
  fromPointerWord: number,
  toPointerWord: number,
  context: string,
): bigint {
  if (pointerWord === 0n) return 0n;
  const kind = Number(pointerWord & 0x3n);
  if (kind === 0 || kind === 1) {
    const offset = signed30((pointerWord >> 2n) & MASK_30);
    const targetWord = fromPointerWord + 1 + offset;
    const rebasedOffset = targetWord - (toPointerWord + 1);
    return (pointerWord & ~POINTER_OFFSET_MASK) |
      (encodeSigned30(rebasedOffset) << 2n);
  }
  if (kind === 2) {
    throw new ProtocolError(`${context} does not support far pointers yet`);
  }
  return pointerWord;
}

function rebaseCopiedRootPointer(
  sourceRootPointer: bigint,
  copiedStartWord: number,
  destinationPointerWord: number,
  context: string,
): bigint {
  if (sourceRootPointer === 0n) return 0n;
  const kind = Number(sourceRootPointer & 0x3n);
  if (kind === 0 || kind === 1) {
    const sourceOffset = signed30((sourceRootPointer >> 2n) & MASK_30);
    const sourceTargetWord = 1 + sourceOffset;
    const destinationTargetWord = copiedStartWord + sourceTargetWord;
    const destinationOffset = destinationTargetWord -
      (destinationPointerWord + 1);
    return (sourceRootPointer & ~POINTER_OFFSET_MASK) |
      (encodeSigned30(destinationOffset) << 2n);
  }
  if (kind === 2) {
    throw new ProtocolError(`${context} does not support far pointers yet`);
  }
  return sourceRootPointer;
}

function extractPointerContentAsMessage(
  segment: Uint8Array,
  pointerWord: number,
  context: string,
): Uint8Array {
  const contentPointer = readWord(segment, pointerWord);
  if (contentPointer === 0n) {
    return new Uint8Array(EMPTY_STRUCT_MESSAGE);
  }
  const rebasedRoot = rebasePointerWord(
    contentPointer,
    pointerWord,
    0,
    context,
  );
  const outSegment = new Uint8Array(segment);
  writeWord(outSegment, 0, rebasedRoot);
  return frameFromSegment(outSegment);
}

function readU16InStruct(
  segment: Uint8Array,
  structRef: StructRef,
  byteOffset: number,
): number {
  if (byteOffset < 0 || byteOffset + 2 > structRef.dataWordCount * WORD_BYTES) {
    throw new ProtocolError(`readU16InStruct out of range: ${byteOffset}`);
  }
  const absolute = structRef.startWord * WORD_BYTES + byteOffset;
  ensureRange(segment, absolute, 2, "readU16InStruct");
  return new DataView(
    segment.buffer,
    segment.byteOffset,
    segment.byteLength,
  ).getUint16(absolute, true);
}

function readU32InStruct(
  segment: Uint8Array,
  structRef: StructRef,
  byteOffset: number,
): number {
  if (byteOffset < 0 || byteOffset + 4 > structRef.dataWordCount * WORD_BYTES) {
    throw new ProtocolError(`readU32InStruct out of range: ${byteOffset}`);
  }
  const absolute = structRef.startWord * WORD_BYTES + byteOffset;
  ensureRange(segment, absolute, 4, "readU32InStruct");
  return new DataView(
    segment.buffer,
    segment.byteOffset,
    segment.byteLength,
  ).getUint32(absolute, true);
}

function readU64InStruct(
  segment: Uint8Array,
  structRef: StructRef,
  byteOffset: number,
): bigint {
  if (byteOffset < 0 || byteOffset + 8 > structRef.dataWordCount * WORD_BYTES) {
    throw new ProtocolError(`readU64InStruct out of range: ${byteOffset}`);
  }
  const absolute = structRef.startWord * WORD_BYTES + byteOffset;
  ensureRange(segment, absolute, 8, "readU64InStruct");
  return new DataView(
    segment.buffer,
    segment.byteOffset,
    segment.byteLength,
  ).getBigUint64(absolute, true);
}

function pointerWordIndex(structRef: StructRef, pointerOffset: number): number {
  if (pointerOffset < 0 || pointerOffset >= structRef.pointerCount) {
    throw new ProtocolError(`pointer offset out of range: ${pointerOffset}`);
  }
  return structRef.startWord + structRef.dataWordCount + pointerOffset;
}

function decodeStructPointer(
  segment: Uint8Array,
  pointerWord: number,
): StructRef | null {
  const word = readWord(segment, pointerWord);
  if (word === 0n) return null;
  const kind = Number(word & 0x3n);
  if (kind !== 0) {
    throw new ProtocolError(`expected struct pointer, got kind=${kind}`);
  }
  const offsetWords = signed30((word >> 2n) & MASK_30);
  const dataWordCount = Number((word >> 32n) & 0xffffn);
  const pointerCount = Number((word >> 48n) & 0xffffn);
  const startWord = pointerWord + 1 + offsetWords;
  const words = dataWordCount + pointerCount;
  if (startWord < 0 || (startWord + words) * WORD_BYTES > segment.byteLength) {
    throw new ProtocolError("struct pointer target out of range");
  }
  return {
    startWord,
    dataWordCount,
    pointerCount,
  };
}

function decodeByteListPointer(
  segment: Uint8Array,
  pointerWord: number,
): ByteListRef | null {
  const word = readWord(segment, pointerWord);
  if (word === 0n) return null;
  const kind = Number(word & 0x3n);
  if (kind !== 1) {
    throw new ProtocolError(`expected list pointer, got kind=${kind}`);
  }
  const offsetWords = signed30((word >> 2n) & MASK_30);
  const elementSize = Number((word >> 32n) & 0x7n);
  const elementCount = Number((word >> 35n) & 0x1fff_ffffn);
  if (elementSize !== 2) {
    throw new ProtocolError(
      `expected byte list element size, got ${elementSize}`,
    );
  }
  const startWord = pointerWord + 1 + offsetWords;
  const wordCount = Math.ceil(elementCount / WORD_BYTES);
  if (
    startWord < 0 || (startWord + wordCount) * WORD_BYTES > segment.byteLength
  ) {
    throw new ProtocolError("byte list pointer target out of range");
  }
  return {
    startWord,
    elementCount,
  };
}

function decodeStructListPointer(
  segment: Uint8Array,
  pointerWord: number,
): StructListRef | null {
  const word = readWord(segment, pointerWord);
  if (word === 0n) return null;
  const kind = Number(word & 0x3n);
  if (kind !== 1) {
    throw new ProtocolError(`expected list pointer, got kind=${kind}`);
  }
  const offsetWords = signed30((word >> 2n) & MASK_30);
  const elementSize = Number((word >> 32n) & 0x7n);
  if (elementSize !== 7) {
    throw new ProtocolError(
      `expected inline composite list pointer, got elementSize=${elementSize}`,
    );
  }
  const tagWord = pointerWord + 1 + offsetWords;
  const tag = readWord(segment, tagWord);
  const tagKind = Number(tag & 0x3n);
  if (tagKind !== 0) {
    throw new ProtocolError(`invalid inline composite tag kind=${tagKind}`);
  }
  const elementCount = Number((tag >> 2n) & MASK_30);
  const dataWordCount = Number((tag >> 32n) & 0xffffn);
  const pointerCount = Number((tag >> 48n) & 0xffffn);
  return {
    elementsStartWord: tagWord + 1,
    elementCount,
    dataWordCount,
    pointerCount,
  };
}

function decodeCapTableFromPayload(
  segment: Uint8Array,
  payloadPointerWord: number,
): RpcCapDescriptor[] {
  const capTable: RpcCapDescriptor[] = [];
  const capList = decodeStructListPointer(segment, payloadPointerWord);
  if (!capList) {
    return capTable;
  }

  const stride = capList.dataWordCount + capList.pointerCount;
  for (let i = 0; i < capList.elementCount; i += 1) {
    const itemStart = capList.elementsStartWord + (i * stride);
    const itemRef: StructRef = {
      startWord: itemStart,
      dataWordCount: capList.dataWordCount,
      pointerCount: capList.pointerCount,
    };
    capTable.push({
      tag: readU16InStruct(segment, itemRef, 0),
      id: readU32InStruct(segment, itemRef, 4),
    });
  }

  return capTable;
}

function readTextFromPointer(
  segment: Uint8Array,
  pointerWord: number,
): string | null {
  const list = decodeByteListPointer(segment, pointerWord);
  if (!list) return null;
  const start = list.startWord * WORD_BYTES;
  const end = start + list.elementCount;
  ensureRange(segment, start, list.elementCount, "readTextFromPointer");
  const bytes = segment.subarray(start, end);
  const payload = bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 0
    ? bytes.subarray(0, bytes.byteLength - 1)
    : bytes;
  return new TextDecoder().decode(payload);
}

function ensureU16(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new ProtocolError(`${name} must be a u16, got ${value}`);
  }
  return value;
}

function ensureU32(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new ProtocolError(`${name} must be a u32, got ${value}`);
  }
  return value;
}

function ensureU64(value: bigint, name: string): bigint {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new ProtocolError(`${name} must be a u64, got ${value}`);
  }
  return value;
}

function normalizeCallTarget(
  request: RpcCallFrameRequest,
): RpcCallTarget {
  if (request.target !== undefined) {
    if (request.target.tag === RPC_CALL_TARGET_TAG_IMPORTED_CAP) {
      return {
        tag: RPC_CALL_TARGET_TAG_IMPORTED_CAP,
        importedCap: ensureU32(
          request.target.importedCap,
          "target.importedCap",
        ),
      };
    }
    return {
      tag: RPC_CALL_TARGET_TAG_PROMISED_ANSWER,
      promisedAnswer: {
        questionId: ensureU32(
          request.target.promisedAnswer.questionId,
          "target.promisedAnswer.questionId",
        ),
        transform: request.target.promisedAnswer.transform?.map((op, index) =>
          normalizePromisedAnswerOp(
            op,
            `target.promisedAnswer.transform[${index}]`,
          )
        ),
      },
    };
  }

  if (request.targetImportedCap === undefined) {
    throw new ProtocolError(
      "encodeCallRequestFrame requires either target or targetImportedCap",
    );
  }
  return {
    tag: RPC_CALL_TARGET_TAG_IMPORTED_CAP,
    importedCap: ensureU32(request.targetImportedCap, "targetImportedCap"),
  };
}

function normalizePromisedAnswerOp(
  op: RpcPromisedAnswerOp,
  name: string,
): RpcPromisedAnswerOp {
  if (op.tag === RPC_PROMISED_ANSWER_OP_TAG_NOOP) {
    return { tag: RPC_PROMISED_ANSWER_OP_TAG_NOOP };
  }
  if (op.tag === RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD) {
    if (op.pointerIndex === undefined) {
      throw new ProtocolError(
        `${name}.pointerIndex is required for getPointerField`,
      );
    }
    return {
      tag: RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD,
      pointerIndex: ensureU16(op.pointerIndex, `${name}.pointerIndex`),
    };
  }
  throw new ProtocolError(`${name}.tag is unsupported: ${op.tag}`);
}

function encodePromisedAnswerTransform(
  builder: MessageBuilder,
  pointerWord: number,
  transform: RpcPromisedAnswerOp[] | undefined,
): void {
  const ops = transform ?? [];
  if (ops.length === 0) {
    builder.writeWord(pointerWord, 0n);
    return;
  }

  const tagWord = builder.allocWords(1 + ops.length);
  builder.setListPointer(pointerWord, tagWord, 7, ops.length);
  builder.writeWord(tagWord, inlineCompositeTag(ops.length, 1, 0));
  for (let i = 0; i < ops.length; i += 1) {
    const normalized = normalizePromisedAnswerOp(
      ops[i],
      `promisedAnswer.transform[${i}]`,
    );
    const elemWord = tagWord + 1 + i;
    builder.writeU16(
      elemWord,
      0,
      ensureU16(normalized.tag, "promisedAnswer op tag"),
    );
    if (normalized.tag === RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD) {
      builder.writeU16(
        elemWord,
        2,
        ensureU16(normalized.pointerIndex!, "promisedAnswer op pointerIndex"),
      );
    }
  }
}

function decodePromisedAnswerTransform(
  segment: Uint8Array,
  pointerWord: number,
): RpcPromisedAnswerOp[] {
  const list = decodeStructListPointer(segment, pointerWord);
  if (!list) return [];
  const stride = list.dataWordCount + list.pointerCount;
  const out: RpcPromisedAnswerOp[] = [];
  for (let i = 0; i < list.elementCount; i += 1) {
    const elemWord = list.elementsStartWord + (i * stride);
    const elemRef: StructRef = {
      startWord: elemWord,
      dataWordCount: list.dataWordCount,
      pointerCount: list.pointerCount,
    };
    const tag = readU16InStruct(segment, elemRef, 0);
    if (tag === RPC_PROMISED_ANSWER_OP_TAG_NOOP) {
      out.push({ tag: RPC_PROMISED_ANSWER_OP_TAG_NOOP });
      continue;
    }
    if (tag === RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD) {
      out.push({
        tag: RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD,
        pointerIndex: readU16InStruct(segment, elemRef, 2),
      });
      continue;
    }
    throw new ProtocolError(`unsupported promisedAnswer op tag: ${tag}`);
  }
  return out;
}

function decodeCallTarget(
  segment: Uint8Array,
  target: StructRef,
): RpcCallTarget {
  const targetTag = readU16InStruct(segment, target, 4);
  if (targetTag === RPC_CALL_TARGET_TAG_IMPORTED_CAP) {
    return {
      tag: RPC_CALL_TARGET_TAG_IMPORTED_CAP,
      importedCap: readU32InStruct(segment, target, 0),
    };
  }
  if (targetTag === RPC_CALL_TARGET_TAG_PROMISED_ANSWER) {
    const promisedRef = decodeStructPointer(
      segment,
      pointerWordIndex(target, 0),
    );
    if (!promisedRef) {
      throw new ProtocolError("call target promisedAnswer pointer is null");
    }
    return {
      tag: RPC_CALL_TARGET_TAG_PROMISED_ANSWER,
      promisedAnswer: {
        questionId: readU32InStruct(segment, promisedRef, 0),
        transform: decodePromisedAnswerTransform(
          segment,
          pointerWordIndex(promisedRef, 0),
        ),
      },
    };
  }
  throw new ProtocolError(`unsupported call target tag: ${targetTag}`);
}

function encodeSigned30(value: number): bigint {
  if (!Number.isInteger(value) || value < -(1 << 29) || value > (1 << 29) - 1) {
    throw new ProtocolError(`pointer offset out of signed30 range: ${value}`);
  }
  return BigInt(value < 0 ? value + (1 << 30) : value) & MASK_30;
}

function normalizePayloadContent(
  content: Uint8Array | undefined,
  fieldName: string,
): Uint8Array {
  if (content === undefined) {
    return EMPTY_STRUCT_MESSAGE;
  }
  if (content.byteLength === 0) {
    throw new ProtocolError(
      `${fieldName} must be a framed Cap'n Proto message`,
    );
  }
  return content;
}

function encodeCapTable(
  builder: MessageBuilder,
  listPointerWord: number,
  capTable: RpcCapDescriptor[] | undefined,
): void {
  const entries = capTable ?? [];
  const count = entries.length;
  const strideWords = 2; // CapDescriptor { data=1, ptr=1 }
  const tagWord = builder.allocWords(1 + (count * strideWords));
  builder.setListPointer(listPointerWord, tagWord, 7, count);
  builder.writeWord(tagWord, inlineCompositeTag(count, 1, 1));

  for (let i = 0; i < count; i += 1) {
    const entry = entries[i];
    const elemWord = tagWord + 1 + (i * strideWords);
    builder.writeU16(elemWord, 0, ensureU16(entry.tag, `capTable[${i}].tag`));
    builder.writeU32(elemWord, 4, ensureU32(entry.id, `capTable[${i}].id`));
  }
}

function inlineCompositeTag(
  elementCount: number,
  dataWordCount: number,
  pointerCount: number,
): bigint {
  const count = ensureU32(elementCount, "elementCount") & 0x3fff_ffff;
  const data = ensureU16(dataWordCount, "dataWordCount");
  const ptrs = ensureU16(pointerCount, "pointerCount");
  let tag = 0n;
  tag |= BigInt(count) << 2n;
  tag |= BigInt(data) << 32n;
  tag |= BigInt(ptrs) << 48n;
  return tag;
}

function encodeReturnFlags(
  builder: MessageBuilder,
  returnWord: number,
  releaseParamCaps: boolean,
  noFinishNeeded: boolean,
): void {
  let flags = 0;
  if (!releaseParamCaps) flags |= 0x1;
  if (noFinishNeeded) flags |= 0x2;
  builder.writeU32(returnWord, 4, flags);
}

function decodeReturnFlags(segment: Uint8Array, ret: StructRef): {
  releaseParamCaps: boolean;
  noFinishNeeded: boolean;
} {
  const flags = readU32InStruct(segment, ret, 4);
  return {
    releaseParamCaps: (flags & 0x1) === 0,
    noFinishNeeded: (flags & 0x2) !== 0,
  };
}

function writePayloadContentPointer(
  builder: MessageBuilder,
  contentPointerWord: number,
  content: Uint8Array | undefined,
  fieldName: string,
): void {
  const payload = normalizePayloadContent(content, fieldName);
  const segment = segmentFromFrame(payload);
  if (segment.byteLength % WORD_BYTES !== 0) {
    throw new ProtocolError(
      `${fieldName} segment must be word-aligned, got ${segment.byteLength}`,
    );
  }
  const sourceRoot = readWord(segment, 0);
  if (sourceRoot === 0n) {
    builder.writeWord(contentPointerWord, 0n);
    return;
  }
  const copiedStart = builder.allocWords(segment.byteLength / WORD_BYTES);
  builder.copyWords(copiedStart, segment);
  const rebasedRoot = rebaseCopiedRootPointer(
    sourceRoot,
    copiedStart,
    contentPointerWord,
    fieldName,
  );
  builder.writeWord(contentPointerWord, rebasedRoot);
}

class MessageBuilder {
  private bytes: Uint8Array;
  private words: number;

  constructor() {
    this.bytes = new Uint8Array(WORD_BYTES);
    this.words = 1; // reserve root pointer word
  }

  allocWords(count: number): number {
    if (!Number.isInteger(count) || count < 0) {
      throw new ProtocolError(
        `allocWords requires non-negative integer, got ${count}`,
      );
    }
    const start = this.words;
    this.words += count;
    this.ensureCapacity(this.words * WORD_BYTES);
    return start;
  }

  writeWord(wordIndex: number, value: bigint): void {
    this.requireWordRange(wordIndex, 1, "writeWord");
    this.view().setBigUint64(wordIndex * WORD_BYTES, value, true);
  }

  writeU16(wordIndex: number, byteOffset: number, value: number): void {
    this.requireByteInWordRange(wordIndex, byteOffset, 2, "writeU16");
    this.view().setUint16(wordIndex * WORD_BYTES + byteOffset, value, true);
  }

  writeU32(wordIndex: number, byteOffset: number, value: number): void {
    this.requireByteInWordRange(wordIndex, byteOffset, 4, "writeU32");
    this.view().setUint32(
      wordIndex * WORD_BYTES + byteOffset,
      value >>> 0,
      true,
    );
  }

  writeU64(wordIndex: number, byteOffset: number, value: bigint): void {
    this.requireByteInWordRange(wordIndex, byteOffset, 8, "writeU64");
    this.view().setBigUint64(wordIndex * WORD_BYTES + byteOffset, value, true);
  }

  writeBytes(wordIndex: number, byteOffset: number, value: Uint8Array): void {
    const absolute = wordIndex * WORD_BYTES + byteOffset;
    this.requireByteRange(absolute, value.byteLength, "writeBytes");
    this.bytes.set(value, absolute);
  }

  copyWords(wordIndex: number, value: Uint8Array): void {
    if (value.byteLength % WORD_BYTES !== 0) {
      throw new ProtocolError(
        `copyWords requires word-aligned input, got ${value.byteLength}`,
      );
    }
    const wordCount = value.byteLength / WORD_BYTES;
    this.requireWordRange(wordIndex, wordCount, "copyWords");
    this.bytes.set(value, wordIndex * WORD_BYTES);
  }

  setStructPointer(
    pointerWord: number,
    targetWord: number,
    dataWordCount: number,
    pointerCount: number,
  ): void {
    const offset = targetWord - (pointerWord + 1);
    let word = 0n;
    word |= encodeSigned30(offset) << 2n;
    word |= BigInt(dataWordCount & 0xffff) << 32n;
    word |= BigInt(pointerCount & 0xffff) << 48n;
    this.writeWord(pointerWord, word);
  }

  setListPointer(
    pointerWord: number,
    targetWord: number,
    elementSize: number,
    count: number,
  ): void {
    const offset = targetWord - (pointerWord + 1);
    let word = 1n;
    word |= encodeSigned30(offset) << 2n;
    word |= BigInt(elementSize & 0x7) << 32n;
    word |= BigInt(count & 0x1fff_ffff) << 35n;
    this.writeWord(pointerWord, word);
  }

  toMessageBytes(): Uint8Array {
    const segmentBytes = this.words * WORD_BYTES;
    const out = new Uint8Array(8 + segmentBytes);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0, true);
    view.setUint32(4, this.words, true);
    out.set(this.bytes.subarray(0, segmentBytes), 8);
    return out;
  }

  private ensureCapacity(requiredBytes: number): void {
    if (requiredBytes <= this.bytes.byteLength) return;
    let next = this.bytes.byteLength;
    while (next < requiredBytes) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.bytes);
    this.bytes = grown;
  }

  private view(): DataView {
    return new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    );
  }

  private requireWordRange(
    wordIndex: number,
    count: number,
    context: string,
  ): void {
    if (wordIndex < 0 || count < 0 || wordIndex + count > this.words) {
      throw new ProtocolError(
        `${context} out of range: word=${wordIndex} count=${count} words=${this.words}`,
      );
    }
  }

  private requireByteInWordRange(
    wordIndex: number,
    byteOffset: number,
    len: number,
    context: string,
  ): void {
    this.requireWordRange(wordIndex, 1, context);
    if (byteOffset < 0 || byteOffset + len > WORD_BYTES) {
      throw new ProtocolError(`${context} byte offset out of range`);
    }
  }

  private requireByteRange(
    byteOffset: number,
    len: number,
    context: string,
  ): void {
    const end = byteOffset + len;
    if (byteOffset < 0 || len < 0 || end > this.words * WORD_BYTES) {
      throw new ProtocolError(
        `${context} out of range: offset=${byteOffset} len=${len} bytes=${
          this.words * WORD_BYTES
        }`,
      );
    }
  }
}

/**
 * Decodes only the message tag from a Cap'n Proto RPC frame without fully
 * parsing the message body.
 *
 * @param frame - The raw frame bytes.
 * @returns The RPC message tag (e.g., {@link RPC_MESSAGE_TAG_CALL}).
 * @throws {ProtocolError} If the frame is too short or malformed.
 */
export function decodeRpcMessageTag(frame: Uint8Array): number {
  const segment = segmentFromFrame(frame);
  const root = decodeStructPointer(segment, 0);
  if (!root) throw new ProtocolError("rpc message root pointer is null");
  return readU16InStruct(segment, root, 0);
}

/**
 * Encodes a Bootstrap request into a Cap'n Proto RPC frame.
 *
 * @param request - The bootstrap request parameters.
 * @returns The serialized frame bytes.
 * @throws {ProtocolError} If the questionId is invalid.
 */
export function encodeBootstrapRequestFrame(
  request: RpcBootstrapRequest,
): Uint8Array {
  const questionId = ensureU32(request.questionId, "questionId");
  const builder = new MessageBuilder();

  const messageWord = builder.allocWords(2); // Message { data=1, ptrs=1 }
  builder.setStructPointer(0, messageWord, 1, 1);
  builder.writeU16(messageWord, 0, RPC_MESSAGE_TAG_BOOTSTRAP);

  const bootstrapWord = builder.allocWords(2); // Bootstrap { data=1, ptrs=1 }
  builder.setStructPointer(messageWord + 1, bootstrapWord, 1, 1);
  builder.writeU32(bootstrapWord, 0, questionId);

  return builder.toMessageBytes();
}

/**
 * Encodes a Call request into a Cap'n Proto RPC frame.
 *
 * @param request - The call request parameters including target, interface, method, and params.
 * @returns The serialized frame bytes.
 * @throws {ProtocolError} If any field value is out of range.
 */
export function encodeCallRequestFrame(
  request: RpcCallFrameRequest,
): Uint8Array {
  const questionId = ensureU32(request.questionId, "questionId");
  const interfaceId = ensureU64(request.interfaceId, "interfaceId");
  const methodId = ensureU16(request.methodId, "methodId");
  const target = normalizeCallTarget(request);

  const builder = new MessageBuilder();

  const messageWord = builder.allocWords(2); // Message { data=1, ptrs=1 }
  builder.setStructPointer(0, messageWord, 1, 1);
  builder.writeU16(messageWord, 0, RPC_MESSAGE_TAG_CALL);

  const callWord = builder.allocWords(6); // Call { data=3, ptrs=3 }
  builder.setStructPointer(messageWord + 1, callWord, 3, 3);
  builder.writeU32(callWord, 0, questionId);
  builder.writeU16(callWord, 4, methodId);
  builder.writeU16(callWord, 6, 0); // sendResultsTo=caller
  builder.writeU64(callWord + 1, 0, interfaceId);

  const targetWord = builder.allocWords(2); // MessageTarget { data=1, ptrs=1 }
  builder.setStructPointer(callWord + 3, targetWord, 1, 1);
  if (target.tag === RPC_CALL_TARGET_TAG_IMPORTED_CAP) {
    builder.writeU32(targetWord, 0, target.importedCap);
    builder.writeU16(targetWord, 4, RPC_CALL_TARGET_TAG_IMPORTED_CAP);
  } else {
    builder.writeU16(targetWord, 4, RPC_CALL_TARGET_TAG_PROMISED_ANSWER);
    const promisedWord = builder.allocWords(2); // PromisedAnswer { data=1, ptrs=1 }
    builder.setStructPointer(targetWord + 1, promisedWord, 1, 1);
    builder.writeU32(
      promisedWord,
      0,
      target.promisedAnswer.questionId,
    );
    encodePromisedAnswerTransform(
      builder,
      promisedWord + 1,
      target.promisedAnswer.transform,
    );
  }

  const payloadWord = builder.allocWords(2); // Payload { data=0, ptrs=2 }
  builder.setStructPointer(callWord + 4, payloadWord, 0, 2);

  writePayloadContentPointer(
    builder,
    payloadWord,
    request.paramsContent,
    "paramsContent",
  );

  // Keep an explicit cap-table list for deterministic frame layout.
  encodeCapTable(builder, payloadWord + 1, request.paramsCapTable);

  return builder.toMessageBytes();
}

/**
 * Encodes a Finish message into a Cap'n Proto RPC frame.
 *
 * @param request - The finish parameters.
 * @returns The serialized frame bytes.
 * @throws {ProtocolError} If the questionId is invalid.
 */
export function encodeFinishFrame(request: {
  questionId: number;
  releaseResultCaps?: boolean;
  requireEarlyCancellation?: boolean;
}): Uint8Array {
  const questionId = ensureU32(request.questionId, "questionId");
  const releaseResultCaps = request.releaseResultCaps ?? true;
  const requireEarlyCancellation = request.requireEarlyCancellation ?? false;

  const builder = new MessageBuilder();
  const messageWord = builder.allocWords(2); // Message { data=1, ptrs=1 }
  builder.setStructPointer(0, messageWord, 1, 1);
  builder.writeU16(messageWord, 0, RPC_MESSAGE_TAG_FINISH);

  const finishWord = builder.allocWords(1); // Finish { data=1, ptrs=0 }
  builder.setStructPointer(messageWord + 1, finishWord, 1, 0);
  builder.writeU32(finishWord, 0, questionId);

  let flags = 0;
  if (!releaseResultCaps) flags |= 0x1;
  if (!requireEarlyCancellation) flags |= 0x2;
  builder.writeU32(finishWord, 4, flags);

  return builder.toMessageBytes();
}

/**
 * Encodes a Release message into a Cap'n Proto RPC frame.
 *
 * @param request - The release parameters (capability ID and reference count).
 * @returns The serialized frame bytes.
 * @throws {ProtocolError} If the id or referenceCount is invalid.
 */
export function encodeReleaseFrame(request: RpcReleaseRequest): Uint8Array {
  const id = ensureU32(request.id, "id");
  const referenceCount = ensureU32(request.referenceCount, "referenceCount");

  const builder = new MessageBuilder();
  const messageWord = builder.allocWords(2); // Message { data=1, ptrs=1 }
  builder.setStructPointer(0, messageWord, 1, 1);
  builder.writeU16(messageWord, 0, RPC_MESSAGE_TAG_RELEASE);

  const releaseWord = builder.allocWords(1); // Release { data=1, ptrs=0 }
  builder.setStructPointer(messageWord + 1, releaseWord, 1, 0);
  builder.writeU32(releaseWord, 0, id);
  builder.writeU32(releaseWord, 4, referenceCount);

  return builder.toMessageBytes();
}

/**
 * Encodes a Return message with results into a Cap'n Proto RPC frame.
 *
 * @param request - The return parameters including content and capability table.
 * @returns The serialized frame bytes.
 * @throws {ProtocolError} If any field value is invalid.
 */
export function encodeReturnResultsFrame(
  request: RpcReturnResultsFrameRequest,
): Uint8Array {
  const answerId = ensureU32(request.answerId, "answerId");
  const releaseParamCaps = request.releaseParamCaps ?? true;
  const noFinishNeeded = request.noFinishNeeded ?? false;

  const builder = new MessageBuilder();
  const messageWord = builder.allocWords(2); // Message { data=1, ptrs=1 }
  builder.setStructPointer(0, messageWord, 1, 1);
  builder.writeU16(messageWord, 0, RPC_MESSAGE_TAG_RETURN);

  const returnWord = builder.allocWords(3); // Return { data=2, ptrs=1 }
  builder.setStructPointer(messageWord + 1, returnWord, 2, 1);
  builder.writeU32(returnWord, 0, answerId);
  encodeReturnFlags(builder, returnWord, releaseParamCaps, noFinishNeeded);
  builder.writeU16(returnWord, 6, RETURN_TAG_RESULTS);

  const payloadWord = builder.allocWords(2); // Payload { data=0, ptrs=2 }
  builder.setStructPointer(returnWord + 2, payloadWord, 0, 2);

  writePayloadContentPointer(builder, payloadWord, request.content, "content");
  encodeCapTable(builder, payloadWord + 1, request.capTable);

  return builder.toMessageBytes();
}

/**
 * Encodes a Return message with an exception into a Cap'n Proto RPC frame.
 *
 * @param request - The exception parameters including answer ID and reason string.
 * @returns The serialized frame bytes.
 * @throws {ProtocolError} If any field value is invalid.
 */
export function encodeReturnExceptionFrame(
  request: RpcReturnExceptionFrameRequest,
): Uint8Array {
  const answerId = ensureU32(request.answerId, "answerId");
  const releaseParamCaps = request.releaseParamCaps ?? true;
  const noFinishNeeded = request.noFinishNeeded ?? false;
  const reasonBytes = new TextEncoder().encode(request.reason);

  const builder = new MessageBuilder();
  const messageWord = builder.allocWords(2); // Message { data=1, ptrs=1 }
  builder.setStructPointer(0, messageWord, 1, 1);
  builder.writeU16(messageWord, 0, RPC_MESSAGE_TAG_RETURN);

  const returnWord = builder.allocWords(3); // Return { data=2, ptrs=1 }
  builder.setStructPointer(messageWord + 1, returnWord, 2, 1);
  builder.writeU32(returnWord, 0, answerId);
  encodeReturnFlags(builder, returnWord, releaseParamCaps, noFinishNeeded);
  builder.writeU16(returnWord, 6, RETURN_TAG_EXCEPTION);

  const exWord = builder.allocWords(3); // Exception { data=1, ptrs=2 }
  builder.setStructPointer(returnWord + 2, exWord, 1, 2);

  const textElementCount = reasonBytes.byteLength + 1; // NUL-terminated Text.
  const textWordCount = Math.ceil(textElementCount / WORD_BYTES);
  const textWord = builder.allocWords(textWordCount);
  builder.setListPointer(exWord + 1, textWord, 2, textElementCount);
  builder.writeBytes(textWord, 0, reasonBytes);

  return builder.toMessageBytes();
}

/**
 * Decodes a Cap'n Proto RPC Bootstrap request frame.
 *
 * @param frame - The raw frame bytes.
 * @returns The decoded bootstrap request.
 * @throws {ProtocolError} If the frame is not a valid bootstrap message.
 */
export function decodeBootstrapRequestFrame(
  frame: Uint8Array,
): RpcBootstrapRequest {
  const segment = segmentFromFrame(frame);
  const root = decodeStructPointer(segment, 0);
  if (!root) throw new ProtocolError("rpc message root pointer is null");
  if (readU16InStruct(segment, root, 0) !== RPC_MESSAGE_TAG_BOOTSTRAP) {
    throw new ProtocolError("rpc message is not bootstrap");
  }
  const bootstrap = decodeStructPointer(segment, pointerWordIndex(root, 0));
  if (!bootstrap) throw new ProtocolError("bootstrap payload pointer is null");
  return {
    questionId: readU32InStruct(segment, bootstrap, 0),
  };
}

/**
 * Decodes a Cap'n Proto RPC Call request frame.
 *
 * @param frame - The raw frame bytes.
 * @returns The decoded call request including target, params, and capability table.
 * @throws {ProtocolError} If the frame is not a valid call message.
 */
export function decodeCallRequestFrame(frame: Uint8Array): RpcCallRequest {
  const segment = segmentFromFrame(frame);
  const root = decodeStructPointer(segment, 0);
  if (!root) throw new ProtocolError("rpc message root pointer is null");
  if (readU16InStruct(segment, root, 0) !== RPC_MESSAGE_TAG_CALL) {
    throw new ProtocolError("rpc message is not call");
  }
  const call = decodeStructPointer(segment, pointerWordIndex(root, 0));
  if (!call) throw new ProtocolError("call payload pointer is null");
  const target = decodeStructPointer(segment, pointerWordIndex(call, 0));
  if (!target) throw new ProtocolError("call target pointer is null");
  const callTarget = decodeCallTarget(segment, target);

  let paramsContent = new Uint8Array(EMPTY_STRUCT_MESSAGE);
  let paramsCapTable: RpcCapDescriptor[] = [];
  const payload = decodeStructPointer(segment, pointerWordIndex(call, 1));
  if (payload) {
    paramsContent = new Uint8Array(
      extractPointerContentAsMessage(
        segment,
        pointerWordIndex(payload, 0),
        "decodeCallRequestFrame",
      ),
    );
    paramsCapTable = decodeCapTableFromPayload(
      segment,
      pointerWordIndex(payload, 1),
    );
  }

  const request: RpcCallRequest = {
    questionId: readU32InStruct(segment, call, 0),
    interfaceId: readU64InStruct(segment, call, 8),
    methodId: readU16InStruct(segment, call, 4),
    target: callTarget,
    paramsContent,
    paramsCapTable,
  };
  if (callTarget.tag === RPC_CALL_TARGET_TAG_IMPORTED_CAP) {
    request.targetImportedCap = callTarget.importedCap;
  }
  return request;
}

/**
 * Decodes a Cap'n Proto RPC Finish frame.
 *
 * @param frame - The raw frame bytes.
 * @returns The decoded finish request.
 * @throws {ProtocolError} If the frame is not a valid finish message.
 */
export function decodeFinishFrame(frame: Uint8Array): RpcFinishRequest {
  const segment = segmentFromFrame(frame);
  const root = decodeStructPointer(segment, 0);
  if (!root) throw new ProtocolError("rpc message root pointer is null");
  if (readU16InStruct(segment, root, 0) !== RPC_MESSAGE_TAG_FINISH) {
    throw new ProtocolError("rpc message is not finish");
  }
  const finish = decodeStructPointer(segment, pointerWordIndex(root, 0));
  if (!finish) throw new ProtocolError("finish payload pointer is null");
  const flags = readU32InStruct(segment, finish, 4);
  return {
    questionId: readU32InStruct(segment, finish, 0),
    releaseResultCaps: (flags & 0x1) === 0,
    requireEarlyCancellation: (flags & 0x2) === 0,
  };
}

/**
 * Decodes a Cap'n Proto RPC Release frame.
 *
 * @param frame - The raw frame bytes.
 * @returns The decoded release request.
 * @throws {ProtocolError} If the frame is not a valid release message.
 */
export function decodeReleaseFrame(frame: Uint8Array): RpcReleaseRequest {
  const segment = segmentFromFrame(frame);
  const root = decodeStructPointer(segment, 0);
  if (!root) throw new ProtocolError("rpc message root pointer is null");
  if (readU16InStruct(segment, root, 0) !== RPC_MESSAGE_TAG_RELEASE) {
    throw new ProtocolError("rpc message is not release");
  }
  const release = decodeStructPointer(segment, pointerWordIndex(root, 0));
  if (!release) throw new ProtocolError("release payload pointer is null");
  return {
    id: readU32InStruct(segment, release, 0),
    referenceCount: readU32InStruct(segment, release, 4),
  };
}

/**
 * Decodes a Cap'n Proto RPC Return frame.
 *
 * @param frame - The raw frame bytes.
 * @returns The decoded return message (either results or exception).
 * @throws {ProtocolError} If the frame is not a valid return message.
 */
export function decodeReturnFrame(frame: Uint8Array): RpcReturnMessage {
  const segment = segmentFromFrame(frame);
  const root = decodeStructPointer(segment, 0);
  if (!root) throw new ProtocolError("rpc message root pointer is null");
  if (readU16InStruct(segment, root, 0) !== RPC_MESSAGE_TAG_RETURN) {
    throw new ProtocolError("rpc message is not return");
  }
  const ret = decodeStructPointer(segment, pointerWordIndex(root, 0));
  if (!ret) throw new ProtocolError("return payload pointer is null");

  const answerId = readU32InStruct(segment, ret, 0);
  const tag = readU16InStruct(segment, ret, 6);
  const returnFlags = decodeReturnFlags(segment, ret);

  if (tag === RETURN_TAG_EXCEPTION) {
    const ex = decodeStructPointer(segment, pointerWordIndex(ret, 0));
    if (!ex) {
      throw new ProtocolError("return.exception payload pointer is null");
    }
    const reason = readTextFromPointer(segment, pointerWordIndex(ex, 0)) ?? "";
    return {
      kind: "exception",
      answerId,
      reason,
      releaseParamCaps: returnFlags.releaseParamCaps,
      noFinishNeeded: returnFlags.noFinishNeeded,
    };
  }

  if (tag === RETURN_TAG_RESULTS) {
    const payload = decodeStructPointer(segment, pointerWordIndex(ret, 0));
    const capTable: RpcCapDescriptor[] = [];
    let contentBytes = new Uint8Array(EMPTY_STRUCT_MESSAGE);

    if (payload) {
      contentBytes = new Uint8Array(
        extractPointerContentAsMessage(
          segment,
          pointerWordIndex(payload, 0),
          "decodeReturnFrame",
        ),
      );
      const payloadCapTable = decodeCapTableFromPayload(
        segment,
        pointerWordIndex(payload, 1),
      );
      capTable.push(...payloadCapTable);
    }

    return {
      kind: "results",
      answerId,
      contentBytes,
      capTable,
      releaseParamCaps: returnFlags.releaseParamCaps,
      noFinishNeeded: returnFlags.noFinishNeeded,
    };
  }

  throw new ProtocolError(`unsupported return tag: ${tag}`);
}

/**
 * Extracts the bootstrap capability index from a Return results message.
 *
 * Looks for the first sender-hosted or receiver-hosted capability descriptor
 * in the return message's capability table.
 *
 * @param message - The decoded return message from a bootstrap request.
 * @returns The capability index of the bootstrap capability.
 * @throws {ProtocolError} If the message is an exception or has no hosted capability.
 */
export function extractBootstrapCapabilityIndex(
  message: RpcReturnMessage,
): number {
  if (message.kind !== "results") {
    throw new ProtocolError(`bootstrap failed: ${message.reason}`);
  }
  const cap = message.capTable.find((item) =>
    item.tag === CAP_DESCRIPTOR_TAG_SENDER_HOSTED ||
    item.tag === CAP_DESCRIPTOR_TAG_RECEIVER_HOSTED
  );
  if (!cap) {
    throw new ProtocolError(
      "bootstrap result did not include a hosted capability",
    );
  }
  return cap.id;
}
