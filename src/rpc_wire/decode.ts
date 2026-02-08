/**
 * Decoding functions that deserialize raw Cap'n Proto RPC frames into
 * typed request / response objects.
 *
 * @module
 */

import { ProtocolError } from "../errors.ts";
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
  extractPointerContentAsMessage,
  pointerWordIndex,
  readTextFromPointer,
} from "./pointers.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
  for (let i = 0; i < capList.elementCount; i += 1) {
    const itemStart = capList.elementsStartWord + (i * stride);
    const itemRef: StructRef = {
      segmentId: capList.segmentId,
      startWord: itemStart,
      dataWordCount: capList.dataWordCount,
      pointerCount: capList.pointerCount,
    };
    capTable.push({
      tag: readU16InStruct(table, itemRef, 0),
      id: readU32InStruct(table, itemRef, 4),
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
    const tag = readU16InStruct(table, elemRef, 0);
    if (tag === RPC_PROMISED_ANSWER_OP_TAG_NOOP) {
      out.push({ tag: RPC_PROMISED_ANSWER_OP_TAG_NOOP });
      continue;
    }
    if (tag === RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD) {
      out.push({
        tag: RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD,
        pointerIndex: readU16InStruct(table, elemRef, 2),
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
  const targetTag = readU16InStruct(table, target, 4);
  if (targetTag === RPC_CALL_TARGET_TAG_IMPORTED_CAP) {
    return {
      tag: RPC_CALL_TARGET_TAG_IMPORTED_CAP,
      importedCap: readU32InStruct(table, target, 0),
    };
  }
  if (targetTag === RPC_CALL_TARGET_TAG_PROMISED_ANSWER) {
    const promisedRef = decodeStructPointer(
      table,
      pointerWordIndex(target, 0),
    );
    if (!promisedRef) {
      throw new ProtocolError("call target promisedAnswer pointer is null");
    }
    return {
      tag: RPC_CALL_TARGET_TAG_PROMISED_ANSWER,
      promisedAnswer: {
        questionId: readU32InStruct(table, promisedRef, 0),
        transform: decodePromisedAnswerTransform(
          table,
          pointerWordIndex(promisedRef, 0),
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
  const flags = readU32InStruct(table, ret, 4);
  return {
    releaseParamCaps: (flags & 0x1) === 0,
    noFinishNeeded: (flags & 0x2) !== 0,
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
  return readU16InStruct(table, root, 0);
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
  if (readU16InStruct(table, root, 0) !== RPC_MESSAGE_TAG_BOOTSTRAP) {
    throw new ProtocolError("rpc message is not bootstrap");
  }
  const bootstrap = decodeStructPointer(table, pointerWordIndex(root, 0));
  if (!bootstrap) throw new ProtocolError("bootstrap payload pointer is null");
  return {
    questionId: readU32InStruct(table, bootstrap, 0),
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
  const root = decodeStructPointer(table, { segmentId: 0, wordIndex: 0 });
  if (!root) throw new ProtocolError("rpc message root pointer is null");
  if (readU16InStruct(table, root, 0) !== RPC_MESSAGE_TAG_CALL) {
    throw new ProtocolError("rpc message is not call");
  }
  const call = decodeStructPointer(table, pointerWordIndex(root, 0));
  if (!call) throw new ProtocolError("call payload pointer is null");
  const target = decodeStructPointer(table, pointerWordIndex(call, 0));
  if (!target) throw new ProtocolError("call target pointer is null");
  const callTarget = decodeCallTarget(table, target);

  let paramsContent = new Uint8Array(EMPTY_STRUCT_MESSAGE);
  let paramsCapTable: RpcCapDescriptor[] = [];
  const payload = decodeStructPointer(table, pointerWordIndex(call, 1));
  if (payload) {
    paramsContent = new Uint8Array(
      extractPointerContentAsMessage(
        table,
        pointerWordIndex(payload, 0),
        "decodeCallRequestFrame",
      ),
    );
    paramsCapTable = decodeCapTableFromPayload(
      table,
      pointerWordIndex(payload, 1),
    );
  }

  const request: RpcCallRequest = {
    questionId: readU32InStruct(table, call, 0),
    interfaceId: readU64InStruct(table, call, 8),
    methodId: readU16InStruct(table, call, 4),
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
  if (readU16InStruct(table, root, 0) !== RPC_MESSAGE_TAG_FINISH) {
    throw new ProtocolError("rpc message is not finish");
  }
  const finish = decodeStructPointer(table, pointerWordIndex(root, 0));
  if (!finish) throw new ProtocolError("finish payload pointer is null");
  const flags = readU32InStruct(table, finish, 4);
  return {
    questionId: readU32InStruct(table, finish, 0),
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
  const table = segmentsFromFrame(frame);
  const root = decodeStructPointer(table, { segmentId: 0, wordIndex: 0 });
  if (!root) throw new ProtocolError("rpc message root pointer is null");
  if (readU16InStruct(table, root, 0) !== RPC_MESSAGE_TAG_RELEASE) {
    throw new ProtocolError("rpc message is not release");
  }
  const release = decodeStructPointer(table, pointerWordIndex(root, 0));
  if (!release) throw new ProtocolError("release payload pointer is null");
  return {
    id: readU32InStruct(table, release, 0),
    referenceCount: readU32InStruct(table, release, 4),
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
  const root = decodeStructPointer(table, { segmentId: 0, wordIndex: 0 });
  if (!root) throw new ProtocolError("rpc message root pointer is null");
  if (readU16InStruct(table, root, 0) !== RPC_MESSAGE_TAG_RETURN) {
    throw new ProtocolError("rpc message is not return");
  }
  const ret = decodeStructPointer(table, pointerWordIndex(root, 0));
  if (!ret) throw new ProtocolError("return payload pointer is null");

  const answerId = readU32InStruct(table, ret, 0);
  const tag = readU16InStruct(table, ret, 6);
  const returnFlags = decodeReturnFlags(table, ret);

  if (tag === RETURN_TAG_EXCEPTION) {
    const ex = decodeStructPointer(table, pointerWordIndex(ret, 0));
    if (!ex) {
      throw new ProtocolError("return.exception payload pointer is null");
    }
    const reason = readTextFromPointer(table, pointerWordIndex(ex, 0)) ?? "";
    return {
      kind: "exception",
      answerId,
      reason,
      releaseParamCaps: returnFlags.releaseParamCaps,
      noFinishNeeded: returnFlags.noFinishNeeded,
    };
  }

  if (tag === RETURN_TAG_RESULTS) {
    const payload = decodeStructPointer(table, pointerWordIndex(ret, 0));
    const capTable: RpcCapDescriptor[] = [];
    let contentBytes = new Uint8Array(EMPTY_STRUCT_MESSAGE);

    if (payload) {
      contentBytes = new Uint8Array(
        extractPointerContentAsMessage(
          table,
          pointerWordIndex(payload, 0),
          "decodeReturnFrame",
        ),
      );
      const payloadCapTable = decodeCapTableFromPayload(
        table,
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
