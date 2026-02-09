/**
 * Cap'n Proto RPC wire format: encoding, decoding, pointer resolution,
 * segment handling, and message routing.
 *
 * Re-exports every public symbol from the focused sub-modules so that
 * downstream code can import from a single entry point.
 *
 * @module
 */

// types -------------------------------------------------------------------
export {
  CAP_DESCRIPTOR_TAG_RECEIVER_HOSTED,
  CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
  EMPTY_STRUCT_MESSAGE,
  FAR_POINTER_HOP_LIMIT,
  MASK_29,
  MASK_30,
  POINTER_OFFSET_MASK,
  RETURN_TAG_EXCEPTION,
  RETURN_TAG_RESULTS,
  RPC_CALL_TARGET_TAG_IMPORTED_CAP,
  RPC_CALL_TARGET_TAG_PROMISED_ANSWER,
  RPC_MESSAGE_TAG_BOOTSTRAP,
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_DISEMBARGO,
  RPC_MESSAGE_TAG_FINISH,
  RPC_MESSAGE_TAG_RELEASE,
  RPC_MESSAGE_TAG_RESOLVE,
  RPC_MESSAGE_TAG_RETURN,
  RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD,
  RPC_PROMISED_ANSWER_OP_TAG_NOOP,
  WORD_BYTES,
} from "./types.ts";
export type {
  ByteListRef,
  PointerLocation,
  ResolvedPointer,
  RpcBootstrapRequest,
  RpcCallFrameRequest,
  RpcCallRequest,
  RpcCallTarget,
  RpcCapDescriptor,
  RpcFinishRequest,
  RpcPromisedAnswerOp,
  RpcPromisedAnswerTarget,
  RpcReleaseRequest,
  RpcReturnException,
  RpcReturnExceptionFrameRequest,
  RpcReturnMessage,
  RpcReturnResults,
  RpcReturnResultsFrameRequest,
  SegmentTable,
  StructListRef,
  StructRef,
} from "./types.ts";

// segments ----------------------------------------------------------------
export {
  encodeSigned30,
  ensureRange,
  ensureSegmentRange,
  ensureU16,
  ensureU32,
  ensureU64,
  frameFromSegment,
  readU16InStruct,
  readU32InStruct,
  readU64InStruct,
  readWord,
  readWordFromTable,
  segmentFromFrame,
  segmentsFromFrame,
  signed30,
  writeWord,
} from "./segments.ts";

// pointers ----------------------------------------------------------------
export {
  decodeByteListPointer,
  decodeStructListPointer,
  decodeStructPointer,
  extractPointerContentAsMessage,
  pointerWordIndex,
  readTextFromPointer,
  rebaseCopiedRootPointer,
  rebasePointerWord,
  resolvePointer,
} from "./pointers.ts";

// encode ------------------------------------------------------------------
export {
  encodeBootstrapRequestFrame,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  encodeReturnExceptionFrame,
  encodeReturnResultsFrame,
  MessageBuilder,
} from "./encode.ts";

// decode ------------------------------------------------------------------
export {
  decodeBootstrapRequestFrame,
  decodeCallRequestFrame,
  decodeFinishFrame,
  decodeReleaseFrame,
  decodeReturnFrame,
  decodeRpcMessageTag,
} from "./decode.ts";

// router ------------------------------------------------------------------
export {
  decodeRpcMessage,
  dispatchRpcMessage,
  extractBootstrapCapabilityIndex,
} from "./router.ts";
export type {
  RpcMessage,
  RpcMessageHandlers,
  RpcMessageTagBootstrap,
  RpcMessageTagCall,
  RpcMessageTagFinish,
  RpcMessageTagDisembargo,
  RpcMessageTagRelease,
  RpcMessageTagResolve,
  RpcMessageTagReturn,
} from "./router.ts";
