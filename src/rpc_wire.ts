/**
 * Cap'n Proto RPC wire format.
 *
 * This file is a backward-compatible barrel that re-exports every public
 * symbol from the focused sub-modules under `src/rpc_wire/`. Existing
 * imports from `"./rpc_wire.ts"` or `"../src/rpc_wire.ts"` continue to
 * work without any changes.
 *
 * @module
 */

export {
  // types / constants
  CAP_DESCRIPTOR_TAG_RECEIVER_HOSTED,
  CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
  // decode
  decodeBootstrapRequestFrame,
  // pointers
  decodeByteListPointer,
  decodeCallRequestFrame,
  decodeFinishFrame,
  decodeReleaseFrame,
  decodeReturnFrame,
  // router
  decodeRpcMessage,
  decodeRpcMessageTag,
  decodeStructListPointer,
  decodeStructPointer,
  dispatchRpcMessage,
  EMPTY_STRUCT_MESSAGE,
  // encode
  encodeBootstrapRequestFrame,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  encodeReturnExceptionFrame,
  encodeReturnResultsFrame,
  // segments
  encodeSigned30,
  ensureRange,
  ensureSegmentRange,
  ensureU16,
  ensureU32,
  ensureU64,
  extractBootstrapCapabilityIndex,
  extractPointerContentAsMessage,
  FAR_POINTER_HOP_LIMIT,
  frameFromSegment,
  MASK_29,
  MASK_30,
  MessageBuilder,
  POINTER_OFFSET_MASK,
  pointerWordIndex,
  readTextFromPointer,
  readU16InStruct,
  readU32InStruct,
  readU64InStruct,
  readWord,
  readWordFromTable,
  rebaseCopiedRootPointer,
  rebasePointerWord,
  resolvePointer,
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
  segmentFromFrame,
  segmentsFromFrame,
  signed30,
  WORD_BYTES,
  writeWord,
} from "./rpc_wire/mod.ts";

export type {
  // types
  ByteListRef,
  PointerLocation,
  ResolvedPointer,
  RpcBootstrapRequest,
  RpcCallFrameRequest,
  RpcCallRequest,
  RpcCallTarget,
  RpcCapDescriptor,
  RpcFinishRequest,
  // router
  RpcMessage,
  RpcMessageHandlers,
  RpcMessageTagBootstrap,
  RpcMessageTagCall,
  RpcMessageTagFinish,
  RpcMessageTagDisembargo,
  RpcMessageTagRelease,
  RpcMessageTagResolve,
  RpcMessageTagReturn,
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
} from "./rpc_wire/mod.ts";
