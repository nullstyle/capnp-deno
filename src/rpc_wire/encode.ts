/**
 * Encoding functions that serialize Cap'n Proto RPC messages into framed
 * byte sequences suitable for transmission over an {@link RpcTransport}.
 *
 * @module
 */

import { ProtocolError } from "../errors.ts";

// Cached TextEncoder instance to avoid repeated allocation on the encode path.
const TEXT_ENCODER = new TextEncoder();

import type {
  RpcBootstrapRequest,
  RpcCallFrameRequest,
  RpcCallTarget,
  RpcCapDescriptor,
  RpcPromisedAnswerOp,
  RpcReleaseRequest,
  RpcReturnExceptionFrameRequest,
  RpcReturnResultsFrameRequest,
} from "./types.ts";
import {
  EMPTY_STRUCT_MESSAGE,
  RETURN_TAG_EXCEPTION,
  RETURN_TAG_RESULTS,
  RPC_CALL_TARGET_TAG_IMPORTED_CAP,
  RPC_CALL_TARGET_TAG_PROMISED_ANSWER,
  RPC_MESSAGE_TAG_BOOTSTRAP,
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_FINISH,
  RPC_MESSAGE_TAG_RELEASE,
  RPC_MESSAGE_TAG_RETURN,
  RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD,
  RPC_PROMISED_ANSWER_OP_TAG_NOOP,
  WORD_BYTES,
} from "./types.ts";
import {
  encodeSigned30,
  ensureU16,
  ensureU32,
  ensureU64,
  readWord,
  segmentsFromFrame,
} from "./segments.ts";
import {
  extractPointerContentAsMessage,
  rebaseCopiedRootPointer,
} from "./pointers.ts";

// ---------------------------------------------------------------------------
// MessageBuilder
// ---------------------------------------------------------------------------

export class MessageBuilder {
  private bytes: Uint8Array;
  private words: number;
  private cachedView: DataView | null = null;

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
    this.cachedView = null;
  }

  private view(): DataView {
    if (this.cachedView === null) {
      this.cachedView = new DataView(
        this.bytes.buffer,
        this.bytes.byteOffset,
        this.bytes.byteLength,
      );
    }
    return this.cachedView;
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

// ---------------------------------------------------------------------------
// Internal encoding helpers
// ---------------------------------------------------------------------------

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

function writePayloadContentPointer(
  builder: MessageBuilder,
  contentPointerWord: number,
  content: Uint8Array | undefined,
  fieldName: string,
): void {
  const payload = normalizePayloadContent(content, fieldName);

  // Parse the content as a (potentially multi-segment) frame and flatten
  // it into a single-segment message via deep copy.  This resolves any
  // far pointers in the content so the resulting segment is self-contained.
  const table = segmentsFromFrame(payload);
  const flatMessage = extractPointerContentAsMessage(
    table,
    { segmentId: 0, wordIndex: 0 },
    fieldName,
  );

  // Read the root pointer from the flat single-segment message.
  // The flat message has an 8-byte header followed by segment data.
  const flatSegment = flatMessage.subarray(8);
  if (flatSegment.byteLength === 0) {
    builder.writeWord(contentPointerWord, 0n);
    return;
  }
  const flatRoot = readWord(flatSegment, 0);
  if (flatRoot === 0n) {
    builder.writeWord(contentPointerWord, 0n);
    return;
  }

  // Copy the entire flat segment into the builder and rebase the root pointer.
  const copiedStart = builder.allocWords(flatSegment.byteLength / WORD_BYTES);
  builder.copyWords(copiedStart, flatSegment);
  const rebasedRoot = rebaseCopiedRootPointer(
    flatRoot,
    copiedStart,
    contentPointerWord,
    fieldName,
  );
  builder.writeWord(contentPointerWord, rebasedRoot);
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

// ---------------------------------------------------------------------------
// Public encode functions
// ---------------------------------------------------------------------------

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
  const reasonBytes = TEXT_ENCODER.encode(request.reason);

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
