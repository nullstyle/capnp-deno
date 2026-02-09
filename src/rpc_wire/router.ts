/**
 * High-level RPC message decoding and dispatch.
 *
 * Provides {@link decodeRpcMessage} for turning a raw frame into a
 * discriminated union, and {@link dispatchRpcMessage} for exhaustive
 * handler-based dispatch.
 *
 * @module
 */

import { ProtocolError } from "../errors.ts";
import type {
  RpcBootstrapRequest,
  RpcCallRequest,
  RpcCapDescriptor,
  RpcFinishRequest,
  RpcReleaseRequest,
  RpcReturnMessage,
} from "./types.ts";
import {
  CAP_DESCRIPTOR_TAG_RECEIVER_HOSTED,
  CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
  RPC_MESSAGE_TAG_BOOTSTRAP,
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_DISEMBARGO,
  RPC_MESSAGE_TAG_FINISH,
  RPC_MESSAGE_TAG_RELEASE,
  RPC_MESSAGE_TAG_RESOLVE,
  RPC_MESSAGE_TAG_RETURN,
} from "./types.ts";
import {
  decodeBootstrapRequestFrame,
  decodeCallRequestFrame,
  decodeFinishFrame,
  decodeReleaseFrame,
  decodeReturnFrame,
  decodeRpcMessageTag,
} from "./decode.ts";

// ---------------------------------------------------------------------------
// RpcMessage discriminated union
// ---------------------------------------------------------------------------

/** String tag for a bootstrap RPC message in the discriminated union. */
export type RpcMessageTagBootstrap = "bootstrap";
/** String tag for a call RPC message in the discriminated union. */
export type RpcMessageTagCall = "call";
/** String tag for a return RPC message in the discriminated union. */
export type RpcMessageTagReturn = "return";
/** String tag for a finish RPC message in the discriminated union. */
export type RpcMessageTagFinish = "finish";
/** String tag for a release RPC message in the discriminated union. */
export type RpcMessageTagRelease = "release";

/**
 * Discriminated union of all Cap'n Proto RPC message types.
 *
 * The `tag` field is a human-readable string discriminator that enables
 * exhaustive type-narrowing in switch statements and pattern matching.
 * The `data` field contains the fully decoded message payload.
 */
/** String tag for an opaque Resolve message (forwarded without full decode). */
export type RpcMessageTagResolve = "resolve";
/** String tag for an opaque Disembargo message (forwarded without full decode). */
export type RpcMessageTagDisembargo = "disembargo";

export type RpcMessage =
  | { tag: RpcMessageTagBootstrap; data: RpcBootstrapRequest }
  | { tag: RpcMessageTagCall; data: RpcCallRequest }
  | { tag: RpcMessageTagReturn; data: RpcReturnMessage }
  | { tag: RpcMessageTagFinish; data: RpcFinishRequest }
  | { tag: RpcMessageTagRelease; data: RpcReleaseRequest }
  | { tag: RpcMessageTagResolve; data: Uint8Array }
  | { tag: RpcMessageTagDisembargo; data: Uint8Array };

/**
 * Handler interface for exhaustive RPC message dispatch.
 *
 * Each property is a callback that handles one variant of the
 * {@link RpcMessage} discriminated union. The type parameter `T`
 * is the return type of every handler, ensuring uniform results.
 */
export interface RpcMessageHandlers<T> {
  /** Called when the message is a Bootstrap request. */
  bootstrap(data: RpcBootstrapRequest): T;
  /** Called when the message is a Call request. */
  call(data: RpcCallRequest): T;
  /** Called when the message is a Return message. */
  return(data: RpcReturnMessage): T;
  /** Called when the message is a Finish message. */
  finish(data: RpcFinishRequest): T;
  /** Called when the message is a Release message. */
  release(data: RpcReleaseRequest): T;
  /** Called when the message is a Resolve message (opaque frame). */
  resolve?(data: Uint8Array): T;
  /** Called when the message is a Disembargo message (opaque frame). */
  disembargo?(data: Uint8Array): T;
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Decodes a raw Cap'n Proto RPC frame into a type-safe discriminated union.
 *
 * Unlike {@link decodeRpcMessageTag} (which returns only the numeric tag),
 * this function fully decodes the frame body and returns an {@link RpcMessage}
 * whose `tag` field enables exhaustive type-narrowing.
 *
 * @param frame - The raw frame bytes.
 * @returns A discriminated union with `tag` and `data` fields.
 * @throws {ProtocolError} If the frame is malformed or has an unknown tag.
 */
export function decodeRpcMessage(frame: Uint8Array): RpcMessage {
  const numericTag = decodeRpcMessageTag(frame);
  switch (numericTag) {
    case RPC_MESSAGE_TAG_BOOTSTRAP:
      return { tag: "bootstrap", data: decodeBootstrapRequestFrame(frame) };
    case RPC_MESSAGE_TAG_CALL:
      return { tag: "call", data: decodeCallRequestFrame(frame) };
    case RPC_MESSAGE_TAG_RETURN:
      return { tag: "return", data: decodeReturnFrame(frame) };
    case RPC_MESSAGE_TAG_FINISH:
      return { tag: "finish", data: decodeFinishFrame(frame) };
    case RPC_MESSAGE_TAG_RELEASE:
      return { tag: "release", data: decodeReleaseFrame(frame) };
    case RPC_MESSAGE_TAG_RESOLVE:
      return { tag: "resolve", data: frame };
    case RPC_MESSAGE_TAG_DISEMBARGO:
      return { tag: "disembargo", data: frame };
    default:
      throw new ProtocolError(`unknown rpc message tag: ${numericTag}`);
  }
}

/**
 * Dispatches a decoded {@link RpcMessage} to the appropriate handler in
 * the provided {@link RpcMessageHandlers} object.
 *
 * This function performs exhaustive dispatch: every message variant is
 * covered, and the TypeScript compiler will error if a new variant is
 * added to {@link RpcMessage} without a corresponding handler.
 *
 * @param message - The decoded RPC message to dispatch.
 * @param handlers - An object with one handler per message variant.
 * @returns The value returned by the matched handler.
 * @throws {ProtocolError} If the message tag is unrecognized (should be
 *   unreachable if the message was produced by {@link decodeRpcMessage}).
 */
export function dispatchRpcMessage<T>(
  message: RpcMessage,
  handlers: RpcMessageHandlers<T>,
): T {
  switch (message.tag) {
    case "bootstrap":
      return handlers.bootstrap(message.data);
    case "call":
      return handlers.call(message.data);
    case "return":
      return handlers.return(message.data);
    case "finish":
      return handlers.finish(message.data);
    case "release":
      return handlers.release(message.data);
    case "resolve":
      if (handlers.resolve) return handlers.resolve(message.data);
      return undefined as T;
    case "disembargo":
      if (handlers.disembargo) return handlers.disembargo(message.data);
      return undefined as T;
    default: {
      const _exhaustive: never = message;
      throw new ProtocolError(
        `unknown rpc message tag: ${(_exhaustive as RpcMessage).tag}`,
      );
    }
  }
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
  const cap = message.capTable.find((item: RpcCapDescriptor) =>
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
