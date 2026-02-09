/**
 * Server-side outbound call facility.
 *
 * Enables a server to make RPC calls on imported capabilities (capabilities
 * received as parameters from a client). This is required for bidirectional
 * RPC patterns like the Arena `collaborate` scenario, where the server calls
 * back into a client-provided `Collaborator` capability.
 *
 * The WASM peer has no `originateCall` ABI, so outbound calls from the
 * server must bypass the peer entirely:
 * - {@link ServerCallInterceptTransport} intercepts Return frames for
 *   server-originated questions before they reach the WASM peer.
 * - {@link ServerOutboundClient} encodes Call frames and sends them
 *   directly on the wire, waiting for intercepted Returns.
 *
 * @module
 */

import { ProtocolError, SessionError } from "./errors.ts";
import type {
  RpcClientCallOptions,
  RpcClientCallResult,
  RpcFinishOptions,
} from "./rpc_client.ts";
import {
  decodeReturnFrame,
  decodeRpcMessageTag,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  RPC_CALL_TARGET_TAG_IMPORTED_CAP,
  RPC_MESSAGE_TAG_RETURN,
  type RpcReturnMessage,
} from "./rpc_wire.ts";
import type { RpcTransport } from "./transport.ts";

/**
 * Default starting question ID for server-originated outbound calls.
 * Uses a high offset to avoid collision with the WASM peer's internal
 * question ID space.
 */
const DEFAULT_SERVER_QUESTION_START = 0x4000_0000;

interface PendingQuestion {
  resolve: (message: RpcReturnMessage) => void;
  reject: (error: unknown) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

/**
 * Transport wrapper that intercepts Return frames for server-originated
 * outbound calls before they reach the WASM peer.
 *
 * This transport sits between the real network transport and the
 * session's transport layer. When a Return frame arrives whose answerId
 * matches a registered server question, the frame is routed to the
 * {@link ServerOutboundClient} instead of being forwarded to the session.
 */
export class ServerCallInterceptTransport implements RpcTransport {
  readonly #inner: RpcTransport;
  readonly #pendingQuestions = new Map<number, PendingQuestion>();
  #closed = false;

  constructor(inner: RpcTransport) {
    this.#inner = inner;
  }

  /**
   * Register a question ID for interception.
   * Returns a promise that resolves when the matching Return frame arrives.
   */
  registerQuestion(
    questionId: number,
    timeoutMs?: number,
  ): Promise<RpcReturnMessage> {
    return new Promise<RpcReturnMessage>((resolve, reject) => {
      const pending: PendingQuestion = { resolve, reject };
      if (
        timeoutMs !== undefined && timeoutMs > 0 && Number.isFinite(timeoutMs)
      ) {
        pending.timeout = setTimeout(() => {
          this.#pendingQuestions.delete(questionId);
          reject(
            new SessionError(
              `server outbound call timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }
      this.#pendingQuestions.set(questionId, pending);
    });
  }

  /** Unregister a question ID (e.g. on send failure). */
  unregisterQuestion(questionId: number): void {
    const pending = this.#pendingQuestions.get(questionId);
    if (pending) {
      if (pending.timeout) clearTimeout(pending.timeout);
      this.#pendingQuestions.delete(questionId);
    }
  }

  async start(
    onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): Promise<void> {
    await this.#inner.start(async (frame) => {
      if (this.#tryInterceptReturn(frame)) return;
      await onFrame(frame);
    });
  }

  async send(frame: Uint8Array): Promise<void> {
    if (this.#closed) throw new SessionError("transport is closed");
    await this.#inner.send(frame);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const error = new SessionError("transport is closed");
    for (const [, pending] of this.#pendingQuestions) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pendingQuestions.clear();
    await this.#inner.close();
  }

  #tryInterceptReturn(frame: Uint8Array): boolean {
    if (this.#pendingQuestions.size === 0) return false;
    try {
      const tag = decodeRpcMessageTag(frame);
      if (tag !== RPC_MESSAGE_TAG_RETURN) return false;
      const ret = decodeReturnFrame(frame);
      const pending = this.#pendingQuestions.get(ret.answerId);
      if (!pending) return false;
      if (pending.timeout) clearTimeout(pending.timeout);
      this.#pendingQuestions.delete(ret.answerId);
      pending.resolve(ret);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Client for making outbound RPC calls from the server side.
 *
 * Bypasses the WASM peer entirely: Call frames are encoded and sent
 * directly on the wire via the {@link ServerCallInterceptTransport},
 * and Return frames are intercepted before reaching the peer.
 *
 * The `call` and `callRaw` method signatures are compatible with
 * {@link SessionRpcClientTransport}, so generated client stubs can
 * use either transport interchangeably.
 *
 * @example
 * ```ts
 * const runtime = await RpcServerRuntime.create(transport, bridge);
 * // In a server handler:
 * async dispatch(methodId, params, ctx) {
 *   const capIndex = ctx.paramsCapTable[0].id;
 *   const result = await runtime.outboundClient.call(
 *     { capabilityIndex: capIndex },
 *     0,  // method ordinal
 *     payload,
 *     { interfaceId: CollaboratorInterfaceId },
 *   );
 *   return result;
 * }
 * ```
 */
export class ServerOutboundClient {
  readonly #transport: ServerCallInterceptTransport;
  #nextQuestionId: number;

  constructor(
    transport: ServerCallInterceptTransport,
    startQuestionId = DEFAULT_SERVER_QUESTION_START,
  ) {
    this.#transport = transport;
    this.#nextQuestionId = startQuestionId;
  }

  /**
   * Send an RPC call and return the full result including metadata.
   *
   * Unlike the client-side transport, `interfaceId` MUST be provided
   * in `options` since there is no default interface for server outbound calls.
   */
  async callRaw(
    capability: { capabilityIndex: number },
    methodId: number,
    params: Uint8Array,
    options: RpcClientCallOptions = {},
  ): Promise<RpcClientCallResult> {
    const questionId = this.#nextQuestionId++;
    const interfaceId = options.interfaceId;
    if (interfaceId === undefined) {
      throw new ProtocolError(
        "interfaceId is required for server outbound calls",
      );
    }

    const target = options.target ?? ({
      tag: RPC_CALL_TARGET_TAG_IMPORTED_CAP,
      importedCap: capability.capabilityIndex,
    } as const);

    const frame = encodeCallRequestFrame({
      questionId,
      interfaceId,
      methodId,
      target,
      paramsContent: params,
      paramsCapTable: options.paramsCapTable,
    });

    const returnPromise = this.#transport.registerQuestion(
      questionId,
      options.timeoutMs,
    );

    try {
      await this.#transport.send(frame);
    } catch (error) {
      this.#transport.unregisterQuestion(questionId);
      throw error;
    }

    let message: RpcReturnMessage;
    try {
      message = await returnPromise;
    } catch (error) {
      // Best-effort finish on timeout/failure.
      if ((options.autoFinish ?? true)) {
        await this.#trySendFinish(questionId, options.finish);
      }
      throw error;
    }

    if (message.kind === "exception") {
      throw new ProtocolError(`rpc call failed: ${message.reason}`);
    }

    // Auto-finish unless the server says no finish needed.
    if ((options.autoFinish ?? true) && !message.noFinishNeeded) {
      await this.#trySendFinish(questionId, options.finish);
    }

    return {
      answerId: message.answerId,
      contentBytes: new Uint8Array(message.contentBytes),
      capTable: message.capTable.map((entry) => ({
        tag: entry.tag,
        id: entry.id,
      })),
      releaseParamCaps: message.releaseParamCaps,
      noFinishNeeded: message.noFinishNeeded,
    };
  }

  /**
   * Send an RPC call and return just the response content bytes.
   */
  async call(
    capability: { capabilityIndex: number },
    methodId: number,
    params: Uint8Array,
    options: RpcClientCallOptions = {},
  ): Promise<Uint8Array> {
    const result = await this.callRaw(capability, methodId, params, options);
    return result.contentBytes;
  }

  /**
   * Send a Release message to decrement a capability's reference count.
   */
  async release(
    capability: { capabilityIndex: number },
    referenceCount = 1,
  ): Promise<void> {
    const frame = encodeReleaseFrame({
      id: capability.capabilityIndex,
      referenceCount,
    });
    await this.#transport.send(frame);
  }

  /**
   * Send a Finish message for a specific question.
   */
  async finish(
    questionId: number,
    options: RpcFinishOptions = {},
  ): Promise<void> {
    const frame = encodeFinishFrame({
      questionId,
      releaseResultCaps: options.releaseResultCaps ?? true,
      requireEarlyCancellation: options.requireEarlyCancellation ?? false,
    });
    await this.#transport.send(frame);
  }

  async #trySendFinish(
    questionId: number,
    options?: RpcFinishOptions,
  ): Promise<void> {
    try {
      await this.finish(questionId, options);
    } catch {
      // Best-effort cleanup only.
    }
  }
}
