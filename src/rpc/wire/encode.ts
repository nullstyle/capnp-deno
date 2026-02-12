/**
 * Encoding functions that serialize Cap'n Proto RPC messages into framed
 * byte sequences suitable for transmission over an {@link RpcTransport}.
 *
 * @module
 */

import { ProtocolError } from "../../errors.ts";
import { encodeAnyPointerMessageIntoBuilder } from "../../encoding/runtime.ts";

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
  BOOTSTRAP_DATA_WORD_COUNT,
  BOOTSTRAP_POINTER_COUNT,
  BOOTSTRAP_QUESTION_ID_BYTE_OFFSET,
  CALL_DATA_WORD_COUNT,
  CALL_INTERFACE_ID_BYTE_OFFSET,
  CALL_METHOD_ID_BYTE_OFFSET,
  CALL_PARAMS_POINTER_INDEX,
  CALL_POINTER_COUNT,
  CALL_QUESTION_ID_BYTE_OFFSET,
  CALL_SEND_RESULTS_TO_TAG_BYTE_OFFSET,
  CALL_SEND_RESULTS_TO_TAG_CALLER,
  CALL_TARGET_POINTER_INDEX,
  CAP_DESCRIPTOR_DATA_WORD_COUNT,
  CAP_DESCRIPTOR_ID_BYTE_OFFSET,
  CAP_DESCRIPTOR_POINTER_COUNT,
  CAP_DESCRIPTOR_TAG_BYTE_OFFSET,
  CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
  EMPTY_STRUCT_MESSAGE,
  EXCEPTION_DATA_WORD_COUNT,
  EXCEPTION_POINTER_COUNT,
  EXCEPTION_REASON_POINTER_INDEX,
  FINISH_DATA_WORD_COUNT,
  FINISH_FLAGS_BYTE_OFFSET,
  FINISH_POINTER_COUNT,
  FINISH_QUESTION_ID_BYTE_OFFSET,
  FINISH_RELEASE_RESULT_CAPS_FLAG_MASK,
  FINISH_REQUIRE_EARLY_CANCELLATION_WORKAROUND_FLAG_MASK,
  MESSAGE_DATA_WORD_COUNT,
  MESSAGE_POINTER_COUNT,
  MESSAGE_TARGET_DATA_WORD_COUNT,
  MESSAGE_TARGET_IMPORTED_CAP_BYTE_OFFSET,
  MESSAGE_TARGET_POINTER_COUNT,
  MESSAGE_TARGET_PROMISED_ANSWER_POINTER_INDEX,
  MESSAGE_TARGET_TAG_BYTE_OFFSET,
  MESSAGE_UNION_TAG_BYTE_OFFSET,
  MESSAGE_VARIANT_POINTER_INDEX,
  PAYLOAD_CAP_TABLE_POINTER_INDEX,
  PAYLOAD_CONTENT_POINTER_INDEX,
  PAYLOAD_DATA_WORD_COUNT,
  PAYLOAD_POINTER_COUNT,
  PROMISED_ANSWER_DATA_WORD_COUNT,
  PROMISED_ANSWER_OP_DATA_WORD_COUNT,
  PROMISED_ANSWER_OP_GET_POINTER_FIELD_BYTE_OFFSET,
  PROMISED_ANSWER_OP_POINTER_COUNT,
  PROMISED_ANSWER_OP_TAG_BYTE_OFFSET,
  PROMISED_ANSWER_POINTER_COUNT,
  PROMISED_ANSWER_QUESTION_ID_BYTE_OFFSET,
  PROMISED_ANSWER_TRANSFORM_POINTER_INDEX,
  RELEASE_DATA_WORD_COUNT,
  RELEASE_ID_BYTE_OFFSET,
  RELEASE_POINTER_COUNT,
  RELEASE_REFERENCE_COUNT_BYTE_OFFSET,
  RETURN_ANSWER_ID_BYTE_OFFSET,
  RETURN_DATA_WORD_COUNT,
  RETURN_FLAGS_BYTE_OFFSET,
  RETURN_NO_FINISH_NEEDED_FLAG_MASK,
  RETURN_POINTER_COUNT,
  RETURN_RELEASE_PARAM_CAPS_FLAG_MASK,
  RETURN_TAG_BYTE_OFFSET,
  RETURN_TAG_EXCEPTION,
  RETURN_TAG_RESULTS,
  RETURN_VARIANT_POINTER_INDEX,
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
import { encodeSigned30, ensureU16, ensureU32, ensureU64 } from "./segments.ts";

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

function pointerWordIndex(
  structWord: number,
  dataWordCount: number,
  pointerIndex: number,
): number {
  return structWord + dataWordCount + pointerIndex;
}

function encodeCapTable(
  builder: MessageBuilder,
  listPointerWord: number,
  capTable: RpcCapDescriptor[] | undefined,
): void {
  const entries = capTable ?? [];
  const count = entries.length;
  const strideWords = CAP_DESCRIPTOR_DATA_WORD_COUNT +
    CAP_DESCRIPTOR_POINTER_COUNT;
  const tagWord = builder.allocWords(1 + (count * strideWords));
  // For inline-composite lists, the list pointer count field stores the
  // payload word count (excluding the tag), not the element count.
  builder.setListPointer(listPointerWord, tagWord, 7, count * strideWords);
  builder.writeWord(
    tagWord,
    inlineCompositeTag(
      count,
      CAP_DESCRIPTOR_DATA_WORD_COUNT,
      CAP_DESCRIPTOR_POINTER_COUNT,
    ),
  );

  for (let i = 0; i < count; i += 1) {
    const entry = entries[i];
    const elemWord = tagWord + 1 + (i * strideWords);
    builder.writeU16(
      elemWord,
      CAP_DESCRIPTOR_TAG_BYTE_OFFSET,
      ensureU16(entry.tag, `capTable[${i}].tag`),
    );
    builder.writeU32(
      elemWord,
      CAP_DESCRIPTOR_ID_BYTE_OFFSET,
      ensureU32(entry.id, `capTable[${i}].id`),
    );
  }
}

function encodeReturnFlags(
  builder: MessageBuilder,
  returnWord: number,
  releaseParamCaps: boolean,
  noFinishNeeded: boolean,
): void {
  let flags = 0;
  if (!releaseParamCaps) flags |= RETURN_RELEASE_PARAM_CAPS_FLAG_MASK;
  if (noFinishNeeded) flags |= RETURN_NO_FINISH_NEEDED_FLAG_MASK;
  builder.writeU32(returnWord, RETURN_FLAGS_BYTE_OFFSET, flags);
}

function writePayloadContentPointer(
  builder: MessageBuilder,
  contentPointerWord: number,
  content: Uint8Array | undefined,
  fieldName: string,
): void {
  const payload = normalizePayloadContent(content, fieldName);
  try {
    encodeAnyPointerMessageIntoBuilder(builder, contentPointerWord, payload);
  } catch (error) {
    if (error instanceof Error) {
      throw new ProtocolError(
        `${fieldName} is not a valid framed Cap'n Proto message: ${error.message}`,
      );
    }
    throw error;
  }
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
  builder.writeWord(
    tagWord,
    inlineCompositeTag(
      ops.length,
      PROMISED_ANSWER_OP_DATA_WORD_COUNT,
      PROMISED_ANSWER_OP_POINTER_COUNT,
    ),
  );
  for (let i = 0; i < ops.length; i += 1) {
    const normalized = normalizePromisedAnswerOp(
      ops[i],
      `promisedAnswer.transform[${i}]`,
    );
    const elemWord = tagWord + 1 + i;
    builder.writeU16(
      elemWord,
      PROMISED_ANSWER_OP_TAG_BYTE_OFFSET,
      ensureU16(normalized.tag, "promisedAnswer op tag"),
    );
    if (normalized.tag === RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD) {
      builder.writeU16(
        elemWord,
        PROMISED_ANSWER_OP_GET_POINTER_FIELD_BYTE_OFFSET,
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

  const messageWord = builder.allocWords(
    MESSAGE_DATA_WORD_COUNT + MESSAGE_POINTER_COUNT,
  );
  builder.setStructPointer(
    0,
    messageWord,
    MESSAGE_DATA_WORD_COUNT,
    MESSAGE_POINTER_COUNT,
  );
  builder.writeU16(
    messageWord,
    MESSAGE_UNION_TAG_BYTE_OFFSET,
    RPC_MESSAGE_TAG_BOOTSTRAP,
  );

  const bootstrapWord = builder.allocWords(
    BOOTSTRAP_DATA_WORD_COUNT + BOOTSTRAP_POINTER_COUNT,
  );
  builder.setStructPointer(
    pointerWordIndex(
      messageWord,
      MESSAGE_DATA_WORD_COUNT,
      MESSAGE_VARIANT_POINTER_INDEX,
    ),
    bootstrapWord,
    BOOTSTRAP_DATA_WORD_COUNT,
    BOOTSTRAP_POINTER_COUNT,
  );
  builder.writeU32(
    bootstrapWord,
    BOOTSTRAP_QUESTION_ID_BYTE_OFFSET,
    questionId,
  );

  return builder.toMessageBytes();
}

/**
 * Encodes a Bootstrap response as a Return message with results containing
 * a single sender-hosted capability at the given index.
 *
 * This is the server-side counterpart to {@link encodeBootstrapRequestFrame}.
 * The response is a standard Return(results) frame whose payload content is
 * an empty struct and whose capability table has one sender-hosted entry.
 *
 * @param options - The answer ID and capability index to include.
 * @returns The serialized frame bytes.
 * @throws {ProtocolError} If the answerId or capabilityIndex is invalid.
 */
export function encodeBootstrapResponseFrame(options: {
  answerId: number;
  capabilityIndex: number;
}): Uint8Array {
  return encodeReturnResultsFrame({
    answerId: options.answerId,
    capTable: [{
      tag: CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
      id: ensureU32(options.capabilityIndex, "capabilityIndex"),
    }],
  });
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

  const messageWord = builder.allocWords(
    MESSAGE_DATA_WORD_COUNT + MESSAGE_POINTER_COUNT,
  );
  builder.setStructPointer(
    0,
    messageWord,
    MESSAGE_DATA_WORD_COUNT,
    MESSAGE_POINTER_COUNT,
  );
  builder.writeU16(
    messageWord,
    MESSAGE_UNION_TAG_BYTE_OFFSET,
    RPC_MESSAGE_TAG_CALL,
  );

  const callWord = builder.allocWords(
    CALL_DATA_WORD_COUNT + CALL_POINTER_COUNT,
  );
  builder.setStructPointer(
    pointerWordIndex(
      messageWord,
      MESSAGE_DATA_WORD_COUNT,
      MESSAGE_VARIANT_POINTER_INDEX,
    ),
    callWord,
    CALL_DATA_WORD_COUNT,
    CALL_POINTER_COUNT,
  );
  builder.writeU32(callWord, CALL_QUESTION_ID_BYTE_OFFSET, questionId);
  builder.writeU16(callWord, CALL_METHOD_ID_BYTE_OFFSET, methodId);
  builder.writeU16(
    callWord,
    CALL_SEND_RESULTS_TO_TAG_BYTE_OFFSET,
    CALL_SEND_RESULTS_TO_TAG_CALLER,
  );
  builder.writeU64(
    callWord + Math.floor(CALL_INTERFACE_ID_BYTE_OFFSET / WORD_BYTES),
    CALL_INTERFACE_ID_BYTE_OFFSET % WORD_BYTES,
    interfaceId,
  );

  const targetWord = builder.allocWords(
    MESSAGE_TARGET_DATA_WORD_COUNT + MESSAGE_TARGET_POINTER_COUNT,
  );
  builder.setStructPointer(
    pointerWordIndex(callWord, CALL_DATA_WORD_COUNT, CALL_TARGET_POINTER_INDEX),
    targetWord,
    MESSAGE_TARGET_DATA_WORD_COUNT,
    MESSAGE_TARGET_POINTER_COUNT,
  );
  if (target.tag === RPC_CALL_TARGET_TAG_IMPORTED_CAP) {
    builder.writeU32(
      targetWord,
      MESSAGE_TARGET_IMPORTED_CAP_BYTE_OFFSET,
      target.importedCap,
    );
    builder.writeU16(
      targetWord,
      MESSAGE_TARGET_TAG_BYTE_OFFSET,
      RPC_CALL_TARGET_TAG_IMPORTED_CAP,
    );
  } else {
    builder.writeU16(
      targetWord,
      MESSAGE_TARGET_TAG_BYTE_OFFSET,
      RPC_CALL_TARGET_TAG_PROMISED_ANSWER,
    );
    const promisedWord = builder.allocWords(
      PROMISED_ANSWER_DATA_WORD_COUNT + PROMISED_ANSWER_POINTER_COUNT,
    );
    builder.setStructPointer(
      pointerWordIndex(
        targetWord,
        MESSAGE_TARGET_DATA_WORD_COUNT,
        MESSAGE_TARGET_PROMISED_ANSWER_POINTER_INDEX,
      ),
      promisedWord,
      PROMISED_ANSWER_DATA_WORD_COUNT,
      PROMISED_ANSWER_POINTER_COUNT,
    );
    builder.writeU32(
      promisedWord,
      PROMISED_ANSWER_QUESTION_ID_BYTE_OFFSET,
      target.promisedAnswer.questionId,
    );
    encodePromisedAnswerTransform(
      builder,
      pointerWordIndex(
        promisedWord,
        PROMISED_ANSWER_DATA_WORD_COUNT,
        PROMISED_ANSWER_TRANSFORM_POINTER_INDEX,
      ),
      target.promisedAnswer.transform,
    );
  }

  const payloadWord = builder.allocWords(
    PAYLOAD_DATA_WORD_COUNT + PAYLOAD_POINTER_COUNT,
  );
  builder.setStructPointer(
    pointerWordIndex(callWord, CALL_DATA_WORD_COUNT, CALL_PARAMS_POINTER_INDEX),
    payloadWord,
    PAYLOAD_DATA_WORD_COUNT,
    PAYLOAD_POINTER_COUNT,
  );

  writePayloadContentPointer(
    builder,
    pointerWordIndex(
      payloadWord,
      PAYLOAD_DATA_WORD_COUNT,
      PAYLOAD_CONTENT_POINTER_INDEX,
    ),
    request.paramsContent,
    "paramsContent",
  );

  // Keep an explicit cap-table list for deterministic frame layout.
  encodeCapTable(
    builder,
    pointerWordIndex(
      payloadWord,
      PAYLOAD_DATA_WORD_COUNT,
      PAYLOAD_CAP_TABLE_POINTER_INDEX,
    ),
    request.paramsCapTable,
  );

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
  const messageWord = builder.allocWords(
    MESSAGE_DATA_WORD_COUNT + MESSAGE_POINTER_COUNT,
  );
  builder.setStructPointer(
    0,
    messageWord,
    MESSAGE_DATA_WORD_COUNT,
    MESSAGE_POINTER_COUNT,
  );
  builder.writeU16(
    messageWord,
    MESSAGE_UNION_TAG_BYTE_OFFSET,
    RPC_MESSAGE_TAG_FINISH,
  );

  const finishWord = builder.allocWords(
    FINISH_DATA_WORD_COUNT + FINISH_POINTER_COUNT,
  );
  builder.setStructPointer(
    pointerWordIndex(
      messageWord,
      MESSAGE_DATA_WORD_COUNT,
      MESSAGE_VARIANT_POINTER_INDEX,
    ),
    finishWord,
    FINISH_DATA_WORD_COUNT,
    FINISH_POINTER_COUNT,
  );
  builder.writeU32(finishWord, FINISH_QUESTION_ID_BYTE_OFFSET, questionId);

  let flags = 0;
  if (!releaseResultCaps) flags |= FINISH_RELEASE_RESULT_CAPS_FLAG_MASK;
  if (!requireEarlyCancellation) {
    flags |= FINISH_REQUIRE_EARLY_CANCELLATION_WORKAROUND_FLAG_MASK;
  }
  builder.writeU32(finishWord, FINISH_FLAGS_BYTE_OFFSET, flags);

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
  const messageWord = builder.allocWords(
    MESSAGE_DATA_WORD_COUNT + MESSAGE_POINTER_COUNT,
  );
  builder.setStructPointer(
    0,
    messageWord,
    MESSAGE_DATA_WORD_COUNT,
    MESSAGE_POINTER_COUNT,
  );
  builder.writeU16(
    messageWord,
    MESSAGE_UNION_TAG_BYTE_OFFSET,
    RPC_MESSAGE_TAG_RELEASE,
  );

  const releaseWord = builder.allocWords(
    RELEASE_DATA_WORD_COUNT + RELEASE_POINTER_COUNT,
  );
  builder.setStructPointer(
    pointerWordIndex(
      messageWord,
      MESSAGE_DATA_WORD_COUNT,
      MESSAGE_VARIANT_POINTER_INDEX,
    ),
    releaseWord,
    RELEASE_DATA_WORD_COUNT,
    RELEASE_POINTER_COUNT,
  );
  builder.writeU32(releaseWord, RELEASE_ID_BYTE_OFFSET, id);
  builder.writeU32(
    releaseWord,
    RELEASE_REFERENCE_COUNT_BYTE_OFFSET,
    referenceCount,
  );

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
  const messageWord = builder.allocWords(
    MESSAGE_DATA_WORD_COUNT + MESSAGE_POINTER_COUNT,
  );
  builder.setStructPointer(
    0,
    messageWord,
    MESSAGE_DATA_WORD_COUNT,
    MESSAGE_POINTER_COUNT,
  );
  builder.writeU16(
    messageWord,
    MESSAGE_UNION_TAG_BYTE_OFFSET,
    RPC_MESSAGE_TAG_RETURN,
  );

  const returnWord = builder.allocWords(
    RETURN_DATA_WORD_COUNT + RETURN_POINTER_COUNT,
  );
  builder.setStructPointer(
    pointerWordIndex(
      messageWord,
      MESSAGE_DATA_WORD_COUNT,
      MESSAGE_VARIANT_POINTER_INDEX,
    ),
    returnWord,
    RETURN_DATA_WORD_COUNT,
    RETURN_POINTER_COUNT,
  );
  builder.writeU32(returnWord, RETURN_ANSWER_ID_BYTE_OFFSET, answerId);
  encodeReturnFlags(builder, returnWord, releaseParamCaps, noFinishNeeded);
  builder.writeU16(returnWord, RETURN_TAG_BYTE_OFFSET, RETURN_TAG_RESULTS);

  const payloadWord = builder.allocWords(
    PAYLOAD_DATA_WORD_COUNT + PAYLOAD_POINTER_COUNT,
  );
  builder.setStructPointer(
    pointerWordIndex(
      returnWord,
      RETURN_DATA_WORD_COUNT,
      RETURN_VARIANT_POINTER_INDEX,
    ),
    payloadWord,
    PAYLOAD_DATA_WORD_COUNT,
    PAYLOAD_POINTER_COUNT,
  );

  writePayloadContentPointer(
    builder,
    pointerWordIndex(
      payloadWord,
      PAYLOAD_DATA_WORD_COUNT,
      PAYLOAD_CONTENT_POINTER_INDEX,
    ),
    request.content,
    "content",
  );
  encodeCapTable(
    builder,
    pointerWordIndex(
      payloadWord,
      PAYLOAD_DATA_WORD_COUNT,
      PAYLOAD_CAP_TABLE_POINTER_INDEX,
    ),
    request.capTable,
  );

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
  const messageWord = builder.allocWords(
    MESSAGE_DATA_WORD_COUNT + MESSAGE_POINTER_COUNT,
  );
  builder.setStructPointer(
    0,
    messageWord,
    MESSAGE_DATA_WORD_COUNT,
    MESSAGE_POINTER_COUNT,
  );
  builder.writeU16(
    messageWord,
    MESSAGE_UNION_TAG_BYTE_OFFSET,
    RPC_MESSAGE_TAG_RETURN,
  );

  const returnWord = builder.allocWords(
    RETURN_DATA_WORD_COUNT + RETURN_POINTER_COUNT,
  );
  builder.setStructPointer(
    pointerWordIndex(
      messageWord,
      MESSAGE_DATA_WORD_COUNT,
      MESSAGE_VARIANT_POINTER_INDEX,
    ),
    returnWord,
    RETURN_DATA_WORD_COUNT,
    RETURN_POINTER_COUNT,
  );
  builder.writeU32(returnWord, RETURN_ANSWER_ID_BYTE_OFFSET, answerId);
  encodeReturnFlags(builder, returnWord, releaseParamCaps, noFinishNeeded);
  builder.writeU16(returnWord, RETURN_TAG_BYTE_OFFSET, RETURN_TAG_EXCEPTION);

  const exWord = builder.allocWords(
    EXCEPTION_DATA_WORD_COUNT + EXCEPTION_POINTER_COUNT,
  );
  builder.setStructPointer(
    pointerWordIndex(
      returnWord,
      RETURN_DATA_WORD_COUNT,
      RETURN_VARIANT_POINTER_INDEX,
    ),
    exWord,
    EXCEPTION_DATA_WORD_COUNT,
    EXCEPTION_POINTER_COUNT,
  );

  const textElementCount = reasonBytes.byteLength + 1; // NUL-terminated Text.
  const textWordCount = Math.ceil(textElementCount / WORD_BYTES);
  const textWord = builder.allocWords(textWordCount);
  builder.setListPointer(
    pointerWordIndex(
      exWord,
      EXCEPTION_DATA_WORD_COUNT,
      EXCEPTION_REASON_POINTER_INDEX,
    ),
    textWord,
    2,
    textElementCount,
  );
  builder.writeBytes(textWord, 0, reasonBytes);

  return builder.toMessageBytes();
}
