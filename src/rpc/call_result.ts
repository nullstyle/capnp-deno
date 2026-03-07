/**
 * Shared helpers for normalizing decoded RPC return messages.
 *
 * @module
 */

import { ProtocolError } from "../errors.ts";
import type {
  RpcCapDescriptor,
  RpcReturnMessage,
  RpcReturnResults,
} from "./wire.ts";

export interface RpcCallResultData {
  answerId: number;
  contentBytes: Uint8Array;
  capTable: RpcCapDescriptor[];
  releaseParamCaps: boolean;
  noFinishNeeded: boolean;
}

export function requireRpcReturnResults(
  message: RpcReturnMessage,
): RpcReturnResults {
  if (message.kind === "exception") {
    throw new ProtocolError(`rpc call failed: ${message.reason}`);
  }
  return message;
}

export function toRpcCallResult(
  message: RpcReturnResults,
  contentBytes = message.contentBytes,
): RpcCallResultData {
  return {
    answerId: message.answerId,
    contentBytes,
    capTable: message.capTable.map(copyRpcCapDescriptor),
    releaseParamCaps: message.releaseParamCaps,
    noFinishNeeded: message.noFinishNeeded,
  };
}

function copyRpcCapDescriptor(entry: RpcCapDescriptor): RpcCapDescriptor {
  return {
    tag: entry.tag,
    id: entry.id,
  };
}
