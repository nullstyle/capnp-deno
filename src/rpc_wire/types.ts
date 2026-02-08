/**
 * Shared interfaces, type aliases, and constants for the Cap'n Proto RPC wire format.
 *
 * This module is dependency-free within rpc_wire/ and provides the canonical
 * type definitions consumed by encoding, decoding, and routing modules.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WORD_BYTES = 8;
export const MASK_29 = 0x1fff_ffffn;
export const MASK_30 = 0x3fff_ffffn;
export const POINTER_OFFSET_MASK = MASK_30 << 2n;
export const FAR_POINTER_HOP_LIMIT = 8;

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

export const RETURN_TAG_RESULTS = 0;
export const RETURN_TAG_EXCEPTION = 1;

export const CAP_DESCRIPTOR_TAG_SENDER_HOSTED = 1;
export const CAP_DESCRIPTOR_TAG_RECEIVER_HOSTED = 3;

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

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Internal struct / pointer reference types
// ---------------------------------------------------------------------------

export interface StructRef {
  segmentId: number;
  startWord: number;
  dataWordCount: number;
  pointerCount: number;
}

export interface ByteListRef {
  segmentId: number;
  startWord: number;
  elementCount: number;
}

export interface StructListRef {
  segmentId: number;
  elementsStartWord: number;
  elementCount: number;
  dataWordCount: number;
  pointerCount: number;
}

/**
 * Parsed representation of a multi-segment Cap'n Proto frame.
 * Provides per-segment DataViews and word-level read access with
 * bounds checking and far pointer resolution.
 */
export interface SegmentTable {
  readonly segments: Uint8Array[];
  readonly views: DataView[];
}

/**
 * Result of resolving a pointer through any far pointer indirection.
 * After resolution, segmentId/pointerWord point at the effective pointer
 * word and `word` holds its content (a struct or list pointer, not far).
 *
 * For a double-far pointer the effective pointer word is a synthetic
 * location in the target segment; `word` is the tag word from the
 * landing pad, and the struct/list data starts at `pointerWord` in
 * `segmentId`.
 */
export interface ResolvedPointer {
  segmentId: number;
  pointerWord: number;
  word: bigint;
}

export interface PointerLocation {
  segmentId: number;
  wordIndex: number;
}
