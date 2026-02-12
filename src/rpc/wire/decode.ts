/**
 * Decoding functions that deserialize raw Cap'n Proto RPC frames into
 * typed request / response objects.
 *
 * @module
 */

import { ProtocolError } from "../../errors.ts";
import {
  decodeAnyPointerMessageFromReader,
  MessageReader as RuntimeMessageReader,
} from "../../encoding/runtime.ts";
import type {
  PointerLocation,
  RpcBootstrapRequest,
  RpcCallRequest,
  RpcCallTarget,
  RpcCapDescriptor,
  RpcFinishRequest,
  RpcPromisedAnswerOp,
  RpcReleaseRequest,
  RpcReturnMessage,
  SegmentTable,
  StructRef,
} from "./types.ts";
import {
  BOOTSTRAP_QUESTION_ID_BYTE_OFFSET,
  CALL_INTERFACE_ID_BYTE_OFFSET,
  CALL_METHOD_ID_BYTE_OFFSET,
  CALL_PARAMS_POINTER_INDEX,
  CALL_QUESTION_ID_BYTE_OFFSET,
  CALL_TARGET_POINTER_INDEX,
  CAP_DESCRIPTOR_ID_BYTE_OFFSET,
  CAP_DESCRIPTOR_TAG_BYTE_OFFSET,
  EMPTY_STRUCT_MESSAGE,
  EXCEPTION_REASON_POINTER_INDEX,
  FINISH_FLAGS_BYTE_OFFSET,
  FINISH_QUESTION_ID_BYTE_OFFSET,
  FINISH_RELEASE_RESULT_CAPS_FLAG_MASK,
  FINISH_REQUIRE_EARLY_CANCELLATION_WORKAROUND_FLAG_MASK,
  MESSAGE_TARGET_IMPORTED_CAP_BYTE_OFFSET,
  MESSAGE_TARGET_PROMISED_ANSWER_POINTER_INDEX,
  MESSAGE_TARGET_TAG_BYTE_OFFSET,
  MESSAGE_UNION_TAG_BYTE_OFFSET,
  MESSAGE_VARIANT_POINTER_INDEX,
  PAYLOAD_CAP_TABLE_POINTER_INDEX,
  PAYLOAD_CONTENT_POINTER_INDEX,
  PROMISED_ANSWER_OP_GET_POINTER_FIELD_BYTE_OFFSET,
  PROMISED_ANSWER_OP_TAG_BYTE_OFFSET,
  PROMISED_ANSWER_QUESTION_ID_BYTE_OFFSET,
  PROMISED_ANSWER_TRANSFORM_POINTER_INDEX,
  RELEASE_ID_BYTE_OFFSET,
  RELEASE_REFERENCE_COUNT_BYTE_OFFSET,
  RETURN_ANSWER_ID_BYTE_OFFSET,
  RETURN_FLAGS_BYTE_OFFSET,
  RETURN_NO_FINISH_NEEDED_FLAG_MASK,
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
} from "./types.ts";
import {
  readU16InStruct,
  readU32InStruct,
  readU64InStruct,
  segmentsFromFrame,
} from "./segments.ts";
import {
  decodeStructListPointer,
  decodeStructPointer,
  pointerWordIndex,
  readTextFromPointer,
} from "./pointers.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function asProtocolError(
  error: unknown,
  context: string,
): ProtocolError {
  if (error instanceof ProtocolError) {
    return error;
  }
  if (error instanceof Error) {
    return new ProtocolError(`${context}: ${error.message}`, { cause: error });
  }
  return new ProtocolError(`${context}: ${String(error)}`, { cause: error });
}

function decodeCapTableFromPayload(
  table: SegmentTable,
  payloadPointerLoc: PointerLocation,
): RpcCapDescriptor[] {
  const capTable: RpcCapDescriptor[] = [];
  const capList = decodeStructListPointer(table, payloadPointerLoc);
  if (!capList) {
    return capTable;
  }

  const stride = capList.dataWordCount + capList.pointerCount;
  const itemRef: StructRef = {
    segmentId: capList.segmentId,
    startWord: 0,
    dataWordCount: capList.dataWordCount,
    pointerCount: capList.pointerCount,
  };
  for (let i = 0; i < capList.elementCount; i += 1) {
    itemRef.startWord = capList.elementsStartWord + (i * stride);
    capTable.push({
      tag: readU16InStruct(table, itemRef, CAP_DESCRIPTOR_TAG_BYTE_OFFSET),
      id: readU32InStruct(table, itemRef, CAP_DESCRIPTOR_ID_BYTE_OFFSET),
    });
  }

  return capTable;
}

function decodePromisedAnswerTransform(
  table: SegmentTable,
  loc: PointerLocation,
): RpcPromisedAnswerOp[] {
  const list = decodeStructListPointer(table, loc);
  if (!list) return [];
  const stride = list.dataWordCount + list.pointerCount;
  const out: RpcPromisedAnswerOp[] = [];
  for (let i = 0; i < list.elementCount; i += 1) {
    const elemWord = list.elementsStartWord + (i * stride);
    const elemRef: StructRef = {
      segmentId: list.segmentId,
      startWord: elemWord,
      dataWordCount: list.dataWordCount,
      pointerCount: list.pointerCount,
    };
    const tag = readU16InStruct(
      table,
      elemRef,
      PROMISED_ANSWER_OP_TAG_BYTE_OFFSET,
    );
    if (tag === RPC_PROMISED_ANSWER_OP_TAG_NOOP) {
      out.push({ tag: RPC_PROMISED_ANSWER_OP_TAG_NOOP });
      continue;
    }
    if (tag === RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD) {
      out.push({
        tag: RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD,
        pointerIndex: readU16InStruct(
          table,
          elemRef,
          PROMISED_ANSWER_OP_GET_POINTER_FIELD_BYTE_OFFSET,
        ),
      });
      continue;
    }
    throw new ProtocolError(`unsupported promisedAnswer op tag: ${tag}`);
  }
  return out;
}

function decodeCallTarget(
  table: SegmentTable,
  target: StructRef,
): RpcCallTarget {
  const targetTag = readU16InStruct(
    table,
    target,
    MESSAGE_TARGET_TAG_BYTE_OFFSET,
  );
  if (targetTag === RPC_CALL_TARGET_TAG_IMPORTED_CAP) {
    return {
      tag: RPC_CALL_TARGET_TAG_IMPORTED_CAP,
      importedCap: readU32InStruct(
        table,
        target,
        MESSAGE_TARGET_IMPORTED_CAP_BYTE_OFFSET,
      ),
    };
  }
  if (targetTag === RPC_CALL_TARGET_TAG_PROMISED_ANSWER) {
    const promisedRef = decodeStructPointer(
      table,
      pointerWordIndex(target, MESSAGE_TARGET_PROMISED_ANSWER_POINTER_INDEX),
    );
    if (!promisedRef) {
      throw new ProtocolError("call target promisedAnswer pointer is null");
    }
    return {
      tag: RPC_CALL_TARGET_TAG_PROMISED_ANSWER,
      promisedAnswer: {
        questionId: readU32InStruct(
          table,
          promisedRef,
          PROMISED_ANSWER_QUESTION_ID_BYTE_OFFSET,
        ),
        transform: decodePromisedAnswerTransform(
          table,
          pointerWordIndex(
            promisedRef,
            PROMISED_ANSWER_TRANSFORM_POINTER_INDEX,
          ),
        ),
      },
    };
  }
  throw new ProtocolError(`unsupported call target tag: ${targetTag}`);
}

function decodeReturnFlags(table: SegmentTable, ret: StructRef): {
  releaseParamCaps: boolean;
  noFinishNeeded: boolean;
} {
  const flags = readU32InStruct(table, ret, RETURN_FLAGS_BYTE_OFFSET);
  return {
    releaseParamCaps: (flags & RETURN_RELEASE_PARAM_CAPS_FLAG_MASK) === 0,
    noFinishNeeded: (flags & RETURN_NO_FINISH_NEEDED_FLAG_MASK) !== 0,
  };
}

// ---------------------------------------------------------------------------
// Public decode functions
// ---------------------------------------------------------------------------

/**
 * Decodes only the message tag from a Cap'n Proto RPC frame without fully
 * parsing the message body.
 *
 * @param frame - The raw frame bytes.
 * @returns The RPC message tag (e.g., {@link RPC_MESSAGE_TAG_CALL}).
 * @throws {ProtocolError} If the frame is too short or malformed.
 */
export function decodeRpcMessageTag(frame: Uint8Array): number {
  const table = segmentsFromFrame(frame);
  const root = decodeStructPointer(table, { segmentId: 0, wordIndex: 0 });
  if (!root) throw new ProtocolError("rpc message root pointer is null");
  return readU16InStruct(table, root, MESSAGE_UNION_TAG_BYTE_OFFSET);
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
  const table = segmentsFromFrame(frame);
  const root = decodeStructPointer(table, { segmentId: 0, wordIndex: 0 });
  if (!root) throw new ProtocolError("rpc message root pointer is null");
  if (
    readU16InStruct(table, root, MESSAGE_UNION_TAG_BYTE_OFFSET) !==
      RPC_MESSAGE_TAG_BOOTSTRAP
  ) {
    throw new ProtocolError("rpc message is not bootstrap");
  }
  const bootstrap = decodeStructPointer(
    table,
    pointerWordIndex(root, MESSAGE_VARIANT_POINTER_INDEX),
  );
  if (!bootstrap) throw new ProtocolError("bootstrap payload pointer is null");
  return {
    questionId: readU32InStruct(
      table,
      bootstrap,
      BOOTSTRAP_QUESTION_ID_BYTE_OFFSET,
    ),
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
  const table = segmentsFromFrame(frame);
  const runtimeReader = new RuntimeMessageReader(frame);
  const root = decodeStructPointer(table, { segmentId: 0, wordIndex: 0 });
  if (!root) throw new ProtocolError("rpc message root pointer is null");
  if (
    readU16InStruct(table, root, MESSAGE_UNION_TAG_BYTE_OFFSET) !==
      RPC_MESSAGE_TAG_CALL
  ) {
    throw new ProtocolError("rpc message is not call");
  }
  const call = decodeStructPointer(
    table,
    pointerWordIndex(root, MESSAGE_VARIANT_POINTER_INDEX),
  );
  if (!call) throw new ProtocolError("call payload pointer is null");
  const target = decodeStructPointer(
    table,
    pointerWordIndex(call, CALL_TARGET_POINTER_INDEX),
  );
  if (!target) throw new ProtocolError("call target pointer is null");
  const callTarget = decodeCallTarget(table, target);

  let paramsContent = new Uint8Array(EMPTY_STRUCT_MESSAGE);
  let paramsCapTable: RpcCapDescriptor[] = [];
  const payload = decodeStructPointer(
    table,
    pointerWordIndex(call, CALL_PARAMS_POINTER_INDEX),
  );
  if (payload) {
    const contentPointer = pointerWordIndex(
      payload,
      PAYLOAD_CONTENT_POINTER_INDEX,
    );
    try {
      paramsContent = new Uint8Array(
        decodeAnyPointerMessageFromReader(
          runtimeReader,
          contentPointer.segmentId,
          contentPointer.wordIndex,
        ),
      );
    } catch (error) {
      throw asProtocolError(error, "invalid call params content pointer");
    }
    paramsCapTable = decodeCapTableFromPayload(
      table,
      pointerWordIndex(payload, PAYLOAD_CAP_TABLE_POINTER_INDEX),
    );
  }

  const request: RpcCallRequest = {
    questionId: readU32InStruct(table, call, CALL_QUESTION_ID_BYTE_OFFSET),
    interfaceId: readU64InStruct(table, call, CALL_INTERFACE_ID_BYTE_OFFSET),
    methodId: readU16InStruct(table, call, CALL_METHOD_ID_BYTE_OFFSET),
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
  const table = segmentsFromFrame(frame);
  const root = decodeStructPointer(table, { segmentId: 0, wordIndex: 0 });
  if (!root) throw new ProtocolError("rpc message root pointer is null");
  if (
    readU16InStruct(table, root, MESSAGE_UNION_TAG_BYTE_OFFSET) !==
      RPC_MESSAGE_TAG_FINISH
  ) {
    throw new ProtocolError("rpc message is not finish");
  }
  const finish = decodeStructPointer(
    table,
    pointerWordIndex(root, MESSAGE_VARIANT_POINTER_INDEX),
  );
  if (!finish) throw new ProtocolError("finish payload pointer is null");
  const flags = readU32InStruct(table, finish, FINISH_FLAGS_BYTE_OFFSET);
  return {
    questionId: readU32InStruct(table, finish, FINISH_QUESTION_ID_BYTE_OFFSET),
    releaseResultCaps: (flags & FINISH_RELEASE_RESULT_CAPS_FLAG_MASK) === 0,
    requireEarlyCancellation:
      (flags & FINISH_REQUIRE_EARLY_CANCELLATION_WORKAROUND_FLAG_MASK) === 0,
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
  const table = segmentsFromFrame(frame);
  const root = decodeStructPointer(table, { segmentId: 0, wordIndex: 0 });
  if (!root) throw new ProtocolError("rpc message root pointer is null");
  if (
    readU16InStruct(table, root, MESSAGE_UNION_TAG_BYTE_OFFSET) !==
      RPC_MESSAGE_TAG_RELEASE
  ) {
    throw new ProtocolError("rpc message is not release");
  }
  const release = decodeStructPointer(
    table,
    pointerWordIndex(root, MESSAGE_VARIANT_POINTER_INDEX),
  );
  if (!release) throw new ProtocolError("release payload pointer is null");
  return {
    id: readU32InStruct(table, release, RELEASE_ID_BYTE_OFFSET),
    referenceCount: readU32InStruct(
      table,
      release,
      RELEASE_REFERENCE_COUNT_BYTE_OFFSET,
    ),
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
  const table = segmentsFromFrame(frame);
  const runtimeReader = new RuntimeMessageReader(frame);
  const root = decodeStructPointer(table, { segmentId: 0, wordIndex: 0 });
  if (!root) throw new ProtocolError("rpc message root pointer is null");
  if (
    readU16InStruct(table, root, MESSAGE_UNION_TAG_BYTE_OFFSET) !==
      RPC_MESSAGE_TAG_RETURN
  ) {
    throw new ProtocolError("rpc message is not return");
  }
  const ret = decodeStructPointer(
    table,
    pointerWordIndex(root, MESSAGE_VARIANT_POINTER_INDEX),
  );
  if (!ret) throw new ProtocolError("return payload pointer is null");

  const answerId = readU32InStruct(table, ret, RETURN_ANSWER_ID_BYTE_OFFSET);
  const tag = readU16InStruct(table, ret, RETURN_TAG_BYTE_OFFSET);
  const returnFlags = decodeReturnFlags(table, ret);

  if (tag === RETURN_TAG_EXCEPTION) {
    const ex = decodeStructPointer(
      table,
      pointerWordIndex(ret, RETURN_VARIANT_POINTER_INDEX),
    );
    if (!ex) {
      throw new ProtocolError("return.exception payload pointer is null");
    }
    const reason = readTextFromPointer(
      table,
      pointerWordIndex(ex, EXCEPTION_REASON_POINTER_INDEX),
    ) ?? "";
    return {
      kind: "exception",
      answerId,
      reason,
      releaseParamCaps: returnFlags.releaseParamCaps,
      noFinishNeeded: returnFlags.noFinishNeeded,
    };
  }

  if (tag === RETURN_TAG_RESULTS) {
    const payload = decodeStructPointer(
      table,
      pointerWordIndex(ret, RETURN_VARIANT_POINTER_INDEX),
    );
    const capTable: RpcCapDescriptor[] = [];
    let contentBytes = new Uint8Array(EMPTY_STRUCT_MESSAGE);

    if (payload) {
      const contentPointer = pointerWordIndex(
        payload,
        PAYLOAD_CONTENT_POINTER_INDEX,
      );
      try {
        contentBytes = new Uint8Array(
          decodeAnyPointerMessageFromReader(
            runtimeReader,
            contentPointer.segmentId,
            contentPointer.wordIndex,
          ),
        );
      } catch (error) {
        throw asProtocolError(error, "invalid return results content pointer");
      }
      const payloadCapTable = decodeCapTableFromPayload(
        table,
        pointerWordIndex(payload, PAYLOAD_CAP_TABLE_POINTER_INDEX),
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
