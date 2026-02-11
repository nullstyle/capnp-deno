/**
 * TCP-backed raw RPC client transport.
 *
 * Provides a lightweight client-side adapter that speaks Cap'n Proto RPC
 * wire frames directly over a started {@link RpcTransport}. This adapter is
 * intended for network clients that do not run a local WASM peer.
 *
 * It is structurally compatible with generated `RpcBootstrapClientTransport`
 * interfaces.
 *
 * @module
 */

import { ProtocolError, SessionError } from "../../errors.ts";
import type {
  RpcClientCallOptions,
  RpcClientCallResult,
  RpcFinishOptions,
} from "../client.ts";
import {
  type CapabilityPointer,
  RpcServerBridge,
  type RpcServerDispatch,
} from "../server.ts";
import {
  decodeReturnFrame,
  decodeRpcMessageTag,
  encodeBootstrapRequestFrame,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  extractBootstrapCapabilityIndex,
  RPC_CALL_TARGET_TAG_IMPORTED_CAP,
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_FINISH,
  RPC_MESSAGE_TAG_RELEASE,
  RPC_MESSAGE_TAG_RETURN,
  type RpcReturnMessage,
} from "../wire.ts";
import type { RpcTransport } from "../transport.ts";
import { TcpTransport, type TcpTransportOptions } from "./tcp.ts";

interface PendingReturnWaiter {
  settled: boolean;
  resolve: (message: RpcReturnMessage) => void;
  reject: (error: unknown) => void;
  timeout?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Options for {@link TcpRpcClientTransport}.
 */
export interface TcpRpcClientTransportOptions {
  /**
   * Default interface ID for call/callRaw when per-call `options.interfaceId`
   * is omitted.
   */
  interfaceId?: bigint;
  /** Initial question ID. Defaults to `1`. */
  nextQuestionId?: number;
  /**
   * Default timeout for waiting on Return frames when per-call `timeoutMs` is
   * omitted.
   */
  defaultTimeoutMs?: number;
  /**
   * Optional callback for inbound non-Return frames observed by this client.
   */
  onUnexpectedFrame?: (
    frame: Uint8Array,
    tag: number,
  ) => void | Promise<void>;
}

/**
 * Options for {@link TcpRpcClientTransport.connect}.
 */
export interface TcpRpcClientConnectOptions
  extends TcpRpcClientTransportOptions {
  /** Low-level TCP transport options forwarded to {@link TcpTransport.connect}. */
  transport?: TcpTransportOptions;
}

/**
 * Cap'n Proto RPC client adapter over a network {@link RpcTransport}.
 *
 * This adapter sends Bootstrap/Call/Finish/Release frames directly and waits
 * for matching Return frames by question ID.
 */
export class TcpRpcClientTransport {
  /** Underlying started network transport. */
  readonly transport: RpcTransport;

  readonly #interfaceId: bigint | undefined;
  #nextQuestionId: number;
  readonly #defaultTimeoutMs: number | undefined;
  readonly #onUnexpectedFrame:
    TcpRpcClientTransportOptions["onUnexpectedFrame"];

  #closed = false;
  #startError: unknown = null;
  #startPromise: Promise<void>;
  #pendingReturns = new Map<number, PendingReturnWaiter>();
  #localBridge: RpcServerBridge | null = null;

  constructor(
    transport: RpcTransport,
    options: TcpRpcClientTransportOptions = {},
  ) {
    this.transport = transport;
    this.#interfaceId = options.interfaceId;
    this.#nextQuestionId = options.nextQuestionId ?? 1;
    this.#defaultTimeoutMs = options.defaultTimeoutMs;
    this.#onUnexpectedFrame = options.onUnexpectedFrame;

    this.#startPromise = Promise.resolve(
      this.transport.start((frame) => this.#onFrame(frame)),
    ).catch((error) => {
      this.#startError = error;
      this.#rejectAllPending(
        new SessionError("tcp rpc client transport failed to start", {
          cause: error,
        }),
      );
    });
  }

  /**
   * Connect to a TCP server and create a started {@link TcpRpcClientTransport}.
   */
  static async connect(
    hostname: string,
    port: number,
    options: TcpRpcClientConnectOptions = {},
  ): Promise<TcpRpcClientTransport> {
    const { transport, ...clientOptions } = options;
    const tcp = await TcpTransport.connect(hostname, port, transport);
    return new TcpRpcClientTransport(tcp, clientOptions);
  }

  /**
   * Send bootstrap and return the server's root capability pointer.
   */
  async bootstrap(
    options: RpcClientCallOptions = {},
  ): Promise<CapabilityPointer> {
    await this.#ensureReady();

    const questionId = this.#allocQuestionId();
    options.onQuestionId?.(questionId);

    const response = await this.#requestReturn(
      questionId,
      encodeBootstrapRequestFrame({ questionId }),
      options,
    );
    if (response.kind === "exception") {
      throw new ProtocolError(`rpc bootstrap failed: ${response.reason}`);
    }

    if ((options.autoFinish ?? true) && !response.noFinishNeeded) {
      await this.finish(questionId, {
        releaseResultCaps: options.finish?.releaseResultCaps ?? false,
        requireEarlyCancellation: options.finish?.requireEarlyCancellation,
      });
    }

    return { capabilityIndex: extractBootstrapCapabilityIndex(response) };
  }

  /**
   * Send a call and return only content bytes.
   */
  async call(
    capability: CapabilityPointer,
    methodId: number,
    params: Uint8Array,
    options: RpcClientCallOptions = {},
  ): Promise<Uint8Array> {
    const response = await this.callRaw(capability, methodId, params, options);
    return response.contentBytes;
  }

  /**
   * Send a call and return content plus cap-table metadata.
   *
   * This adapter intentionally does not auto-finish calls. Generated stubs
   * handle finish semantics by invoking `finish()` when available.
   */
  async callRaw(
    capability: CapabilityPointer,
    methodId: number,
    params: Uint8Array,
    options: RpcClientCallOptions = {},
  ): Promise<RpcClientCallResult> {
    await this.#ensureReady();

    const interfaceId = options.interfaceId ?? this.#interfaceId;
    if (interfaceId === undefined) {
      throw new ProtocolError(
        "interfaceId is required for tcp rpc calls when no default interfaceId is configured",
      );
    }

    const questionId = this.#allocQuestionId();
    options.onQuestionId?.(questionId);

    const target = options.target ?? {
      tag: RPC_CALL_TARGET_TAG_IMPORTED_CAP,
      importedCap: capability.capabilityIndex,
    };

    const response = await this.#requestReturn(
      questionId,
      encodeCallRequestFrame({
        questionId,
        interfaceId,
        methodId,
        target,
        paramsContent: params,
        paramsCapTable: options.paramsCapTable,
      }),
      options,
    );
    if (response.kind === "exception") {
      throw new ProtocolError(`rpc call failed: ${response.reason}`);
    }

    return {
      answerId: response.answerId,
      contentBytes: response.contentBytes,
      capTable: response.capTable.map((entry) => ({
        tag: entry.tag,
        id: entry.id,
      })),
      releaseParamCaps: response.releaseParamCaps,
      noFinishNeeded: response.noFinishNeeded,
    };
  }

  /**
   * Send a finish message for a question.
   */
  async finish(
    questionId: number,
    options: RpcFinishOptions = {},
  ): Promise<void> {
    await this.#ensureReady();
    await this.transport.send(encodeFinishFrame({
      questionId,
      releaseResultCaps: options.releaseResultCaps ?? true,
      requireEarlyCancellation: options.requireEarlyCancellation ?? false,
    }));
  }

  /**
   * Release a capability reference.
   */
  async release(
    capability: CapabilityPointer,
    referenceCount = 1,
  ): Promise<void> {
    await this.#ensureReady();
    await this.transport.send(encodeReleaseFrame({
      id: capability.capabilityIndex,
      referenceCount,
    }));
  }

  /**
   * Export a local server dispatch so the remote peer can call it back.
   */
  exportCapability(
    dispatch: RpcServerDispatch,
    options: { capabilityIndex?: number; referenceCount?: number } = {},
  ): CapabilityPointer {
    if (!this.#localBridge) {
      this.#localBridge = new RpcServerBridge();
    }
    return this.#localBridge.exportCapability(dispatch, options);
  }

  /**
   * Close the transport and reject any pending waits.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectAllPending(
      new SessionError("tcp rpc client transport is closed"),
    );
    await this.transport.close();
  }

  async #onFrame(frame: Uint8Array): Promise<void> {
    let tag: number;
    try {
      tag = decodeRpcMessageTag(frame);
    } catch {
      return;
    }

    if (tag !== RPC_MESSAGE_TAG_RETURN) {
      if (
        this.#localBridge &&
        (tag === RPC_MESSAGE_TAG_CALL || tag === RPC_MESSAGE_TAG_RELEASE ||
          tag === RPC_MESSAGE_TAG_FINISH)
      ) {
        try {
          const response = await this.#localBridge.handleFrame(frame);
          if (response) {
            await this.transport.send(response);
          }
        } catch (error) {
          this.#rejectAllPending(
            new ProtocolError("failed to handle inbound callback frame", {
              cause: error,
            }),
          );
        }
        return;
      }

      if (this.#onUnexpectedFrame) {
        try {
          await this.#onUnexpectedFrame(frame, tag);
        } catch {
          // no-op
        }
      }
      return;
    }

    let decoded: RpcReturnMessage;
    try {
      decoded = decodeReturnFrame(frame);
    } catch (error) {
      this.#rejectAllPending(
        new ProtocolError("failed to decode inbound return frame", {
          cause: error,
        }),
      );
      return;
    }

    const waiter = this.#pendingReturns.get(decoded.answerId);
    if (!waiter) return;
    this.#settleWaiter(decoded.answerId, waiter, decoded);
  }

  async #ensureReady(): Promise<void> {
    if (this.#closed) {
      throw new SessionError("tcp rpc client transport is closed");
    }
    await this.#startPromise;
    if (this.#startError !== null) {
      throw new SessionError("tcp rpc client transport failed to start", {
        cause: this.#startError,
      });
    }
  }

  #allocQuestionId(): number {
    const questionId = this.#nextQuestionId;
    if (
      !Number.isInteger(questionId) ||
      questionId <= 0 ||
      questionId > 0xffff_ffff
    ) {
      throw new SessionError(
        `questionId must be within 1..4294967295, got ${String(questionId)}`,
      );
    }
    this.#nextQuestionId = questionId + 1;
    return questionId;
  }

  async #requestReturn(
    questionId: number,
    frame: Uint8Array,
    options: RpcClientCallOptions,
  ): Promise<RpcReturnMessage> {
    const wait = this.#waitForReturn(questionId, options);
    try {
      await this.transport.send(frame);
    } catch (error) {
      const pending = this.#pendingReturns.get(questionId);
      if (pending) {
        this.#settleWaiter(questionId, pending, error);
      }
      throw error;
    }
    return await wait;
  }

  #waitForReturn(
    questionId: number,
    options: RpcClientCallOptions,
  ): Promise<RpcReturnMessage> {
    if (this.#pendingReturns.has(questionId)) {
      throw new SessionError(`duplicate pending questionId ${questionId}`);
    }

    return new Promise<RpcReturnMessage>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
      const waiter: PendingReturnWaiter = {
        settled: false,
        resolve,
        reject,
      };

      if (options.signal?.aborted) {
        waiter.settled = true;
        reject(new SessionError("rpc wait aborted"));
        return;
      }

      if (timeoutMs !== undefined) {
        waiter.timeout = setTimeout(() => {
          this.#settleWaiter(
            questionId,
            waiter,
            new SessionError(`rpc wait timed out after ${timeoutMs}ms`),
          );
        }, timeoutMs);
      }

      if (options.signal) {
        waiter.signal = options.signal;
        waiter.onAbort = () => {
          this.#settleWaiter(
            questionId,
            waiter,
            new SessionError("rpc wait aborted"),
          );
        };
        waiter.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }

      this.#pendingReturns.set(questionId, waiter);
    });
  }

  #settleWaiter(
    questionId: number,
    waiter: PendingReturnWaiter,
    outcome: RpcReturnMessage | unknown,
  ): void {
    if (waiter.settled) return;
    waiter.settled = true;
    this.#pendingReturns.delete(questionId);
    this.#clearWaiter(waiter);

    if (
      outcome !== null &&
      typeof outcome === "object" &&
      "answerId" in outcome &&
      "kind" in outcome
    ) {
      waiter.resolve(outcome as RpcReturnMessage);
      return;
    }
    waiter.reject(outcome);
  }

  #clearWaiter(waiter: PendingReturnWaiter): void {
    if (waiter.timeout !== undefined) {
      clearTimeout(waiter.timeout);
    }
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  #rejectAllPending(error: unknown): void {
    for (const [questionId, waiter] of this.#pendingReturns) {
      this.#settleWaiter(questionId, waiter, error);
    }
  }
}
