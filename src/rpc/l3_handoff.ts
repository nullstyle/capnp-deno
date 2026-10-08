/**
 * Experimental Level-3 three-party capability handoff over the WASM peer.
 *
 * @module
 *
 * These wrappers expose the wasm module's L3 origination surface (feature
 * bit 10, capnp-zig v0.22.0) behind narrow, opt-in helpers. The embedder is
 * the vat network: {@link mintHandoffTokens} mints the opaque
 * `ThirdPartyToAwait` / `ThirdPartyToContact` blobs, and the completion
 * presented to {@link acceptProvision} is whatever the introducer recorded
 * for the contact token. Nothing here is a Stable API: names, shapes, and
 * semantics may move on any minor bump until the cross-implementation matrix
 * passes.
 */

import { ProtocolError } from "../errors.ts";
import { MessageBuilder } from "../encoding/runtime_message.ts";
import type { WasmPeer } from "../wasm/peer.ts";
import { decodeReturnFrame } from "./wire/decode.ts";
import { extractBootstrapCapabilityIndex } from "./wire/router.ts";
import type { WasmL3Event } from "../wasm/abi.ts";

/** L3 event kind: a Return for an originated Accept question. */
export const L3_EVENT_ACCEPT_RETURN = 1;
/** L3 event kind: a Return for an adopted pending third-party await. */
export const L3_EVENT_AWAIT_RETURN = 2;
/** L3 event kind: an exception the peer synthesized for a handoff Return. */
export const L3_EVENT_RETURN_EXCEPTION = 3;

/**
 * The opaque blobs of one three-party handoff introduction.
 *
 * `toAwait` is the serialized root any-pointer message embedded in the
 * Provide; `contact` is the opaque bytes the recipient needs to redeem the
 * capability (passed back to the introducer when resolving the connection).
 */
export interface HandoffTokens {
  toAwait: Uint8Array;
  contact: Uint8Array;
}

/**
 * Mint the blob pair for one handoff introduction.
 *
 * The default introducer: both blobs derive from one random 16-byte nonce,
 * so `toContact`→completion lookups key on the same secret. Applications
 * that need cross-process introductions can substitute their own minter and
 * their own completion registry; the runtime treats all three blobs as
 * opaque.
 *
 * @returns The minted token pair.
 * @example
 * ```ts
 * const tokens = mintHandoffTokens();
 * const handle = provideCapability(capHostPeer, recipientPeer, capIndex, {
 *   recipient: tokens.toAwait,
 *   contact: tokens.contact,
 * });
 * ```
 */
export function mintHandoffTokens(): HandoffTokens {
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  return {
    toAwait: handoffCompletionFromContact(nonce),
    contact: new Uint8Array(nonce),
  };
}

/**
 * Resolve a ThirdPartyToContact into the ThirdPartyCompletion message to
 * present in the Accept — the recipient-side half of the default
 * introducer. `mintHandoffTokens` derives both blobs from one nonce and
 * serializes them with this exact construction, so the completion produced
 * here is byte-identical to the toAwait the introducer embedded in the
 * Provide.
 *
 * @param contact - The opaque contact bytes from a decoded
 *   `thirdPartyHosted` descriptor.
 * @returns The serialized ThirdPartyCompletion root message.
 * @example
 * ```ts
 * const completion = handoffCompletionFromContact(descriptor.contact);
 * const accepted = await acceptProvision(peer, completion);
 * ```
 */
export function handoffCompletionFromContact(
  contact: Uint8Array,
): Uint8Array {
  const builder = new MessageBuilder();
  builder.writeDataPointer(0, contact);
  return builder.toMessageBytes();
}

/**
 * A handle on an originated three-party handoff.
 *
 * The Provide question stays held open until the recipient releases the
 * vine; the ids are for diagnostics and for explicit control through the
 * peer's ordinary lifecycle exports.
 */
export interface HandoffProvideHandle {
  /** The held-open Provide question id on the cap-host peer. */
  questionId: number;
  /** The vine export id minted on the recipient-side peer. */
  vineId: number;
}

/** Options for {@link provideCapability}. */
export interface ProvideCapabilityOptions {
  /**
   * The serialized ThirdPartyToAwait message (from
   * {@link mintHandoffTokens}). Defaults to a freshly minted token.
   */
  recipient?: Uint8Array;
  /**
   * The opaque ThirdPartyToContact bytes. Defaults to the contact bytes of a
   * freshly minted token pair; pass explicitly when reusing an existing pair.
   */
  contact?: Uint8Array;
}

/**
 * Originate a three-party handoff (Experimental): hand the capability at
 * import `capabilityIndex` of `capHostPeer` — the connection to the host of
 * the provided cap — to a third party reachable through `recipientPeer`.
 *
 * Both peers must come from the same WASM module instance. Delivering the
 * vine descriptor to the recipient (a `thirdPartyHosted` capability table
 * entry carrying `vineId` and the contact bytes) is the caller's next step;
 * the TypeScript wire codec does not yet emit that descriptor tag.
 *
 * @param capHostPeer - Peer connected to the host of the provided cap.
 * @param recipientPeer - Peer connected to the recipient vat.
 * @param capabilityIndex - Import index of the capability on `capHostPeer`.
 * @param options - Token overrides.
 * @returns The Provide handle (question and vine ids).
 * @throws {ProtocolError} If the peers do not share a module or the module lacks feature bit 10.
 * @example
 * ```ts
 * const tokens = mintHandoffTokens();
 * const handle = provideCapability(peer, recipientPeer, 0, {
 *   recipient: tokens.toAwait,
 *   contact: tokens.contact,
 * });
 * ```
 */
export function provideCapability(
  capHostPeer: WasmPeer,
  recipientPeer: WasmPeer,
  capabilityIndex: number,
  options: ProvideCapabilityOptions = {},
): HandoffProvideHandle {
  assertSameModule(capHostPeer, recipientPeer);
  const tokens =
    options.recipient !== undefined || options.contact !== undefined
      ? {
        toAwait: options.recipient ?? new Uint8Array(0),
        contact: options.contact ?? new Uint8Array(0),
      }
      : mintHandoffTokens();
  const { questionId, vineId } = capHostPeer.abi.sendProvide(
    capHostPeer.handle,
    recipientPeer.handle,
    capabilityIndex,
    tokens.toAwait,
    tokens.contact,
  );
  return { questionId, vineId };
}

/** The capability picked up by {@link acceptProvision}. */
export interface AcceptedCapability {
  /**
   * The import index of the accepted capability on the accepting peer's
   * connection; target it in later calls like any received capability.
   */
  capabilityIndex: number;
}

/** Options for {@link acceptProvision}. */
export interface AcceptProvisionOptions {
  /** Optional embargo bytes forwarded verbatim in the Accept. */
  embargo?: Uint8Array;
  /**
   * Aborts the wait. Closing the peer stops event delivery, so pass a signal
   * whenever the surrounding scope can end before the Return arrives.
   */
  signal?: AbortSignal;
  /** Invoked with the Accept question id before the wait begins. */
  onQuestionId?: (questionId: number) => void;
}

/**
 * Pick up a capability a third party provided (Experimental): send an Accept
 * on `peer` and resolve when its Return arrives as an L3 event. The resolved
 * `capabilityIndex` targets the accepted capability on this connection.
 *
 * @param peer - Peer whose connection reaches the host of the provided cap.
 * @param provision - The serialized ThirdPartyCompletion message.
 * @param options - Embargo and cancellation.
 * @returns The accepted capability placement.
 * @throws {ProtocolError} If the Accept fails, the Return is an exception, or the wait is aborted.
 * @example
 * ```ts
 * const accepted = await acceptProvision(peer, completionMessage);
 * client.call({ capabilityIndex: accepted.capabilityIndex }, methodId, params);
 * ```
 */
export function acceptProvision(
  peer: WasmPeer,
  provision: Uint8Array,
  options: AcceptProvisionOptions = {},
): Promise<AcceptedCapability> {
  const questionId = peer.abi.sendAccept(
    peer.handle,
    provision,
    options.embargo,
  );
  options.onQuestionId?.(questionId);
  return waitForL3Return(peer, L3_EVENT_ACCEPT_RETURN, questionId, options);
}

/** Peers with a pending {@link registerThirdPartyAwait} (single-flight). */
const pendingAwaits = new WeakSet<WasmPeer>();

/**
 * Register a pending third-party await (Experimental): park a question that
 * completes when a ThirdPartyAnswer matching `completion` arrives followed
 * by its Return. Only one await may be outstanding per peer at a time; the
 * await event does not carry the adopted question id, so resolutions are
 * matched in registration order.
 *
 * @param peer - The awaiting peer.
 * @param completion - The serialized ThirdPartyCompletion message.
 * @param options - Cancellation.
 * @returns The capability carried by the awaited Return.
 * @throws {ProtocolError} If registration fails, another await is outstanding, or the wait is aborted.
 */
export function registerThirdPartyAwait(
  peer: WasmPeer,
  completion: Uint8Array,
  options: { signal?: AbortSignal } = {},
): Promise<AcceptedCapability> {
  if (pendingAwaits.has(peer)) {
    throw new ProtocolError(
      "a pending third-party await is already outstanding on this peer",
      { metadata: { phase: "l3_await" } },
    );
  }
  peer.abi.registerPendingThirdPartyAwait(peer.handle, completion);
  pendingAwaits.add(peer);
  const wait = waitForL3Return(peer, L3_EVENT_AWAIT_RETURN, undefined, options);
  wait.finally(() => pendingAwaits.delete(peer)).catch(() => {});
  return wait;
}

function waitForL3Return(
  peer: WasmPeer,
  kind: number,
  questionId: number | undefined,
  options: { signal?: AbortSignal },
): Promise<AcceptedCapability> {
  return new Promise<AcceptedCapability>((resolve, reject) => {
    const settle = (fn: () => void) => {
      unsubscribe();
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      settle(() =>
        reject(
          new ProtocolError("l3 handoff wait aborted", {
            metadata: { phase: "l3_wait", questionId },
          }),
        )
      );
    };
    const onEvent = (event: WasmL3Event) => {
      if (questionId !== undefined && event.questionId !== questionId) return;
      if (event.kind === L3_EVENT_RETURN_EXCEPTION) {
        settle(() =>
          reject(
            new ProtocolError(
              `l3 handoff failed: ${new TextDecoder().decode(event.payload)}`,
              { metadata: { phase: "l3_return", questionId } },
            ),
          )
        );
        return;
      }
      if (event.kind !== kind) return;
      try {
        const message = decodeReturnFrame(event.payload);
        settle(() =>
          resolve({
            capabilityIndex: extractBootstrapCapabilityIndex(message),
          })
        );
      } catch (error) {
        settle(() => reject(error));
      }
    };
    const unsubscribe = peer.addL3EventListener(onEvent);
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function assertSameModule(a: WasmPeer, b: WasmPeer): void {
  if (a.abi.exports !== b.abi.exports) {
    throw new ProtocolError(
      "l3 handoff requires peers from the same wasm module instance",
      { metadata: { phase: "l3_provide" } },
    );
  }
}

/**
 * Callee side of a redirected return (Experimental): send a ThirdPartyAnswer
 * carrying `completion` on `peer`.
 *
 * @param peer - Peer whose connection reaches the results recipient.
 * @param completion - The serialized ThirdPartyCompletion message.
 * @returns The callee-allocated answer id (bit 30 set, bit 31 clear).
 * @throws {ProtocolError} If the module lacks feature bit 10 or the send fails.
 */
export function sendThirdPartyAnswer(
  peer: WasmPeer,
  completion: Uint8Array,
): number {
  return peer.abi.sendThirdPartyAnswer(peer.handle, completion);
}
