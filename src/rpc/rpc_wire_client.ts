/**
 * Wire-level RPC client over a started transport.
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

import { annotateCapnpError, ProtocolError, SessionError } from "../errors.ts";
import {
  emitObservabilityEvent,
  type RpcObservability,
} from "../observability/observability.ts";
import type {
  RpcClientCallOptions,
  RpcClientCallResult,
  RpcFinishOptions,
} from "./session/client.ts";
import {
  type CapabilityPointer,
  RpcServerBridge,
  type RpcServerDispatch,
} from "./server/bridge.ts";
import {
  CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
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
  type RpcCapDescriptor,
  type RpcReturnMessage,
} from "./wire.ts";
import type { RpcTransport } from "./transports/internal/transport.ts";
import {
  subscribeTransportClose,
  TransportCloseSignal,
} from "./transports/internal/transport_internal.ts";

interface PendingReturnWaiter {
  settled: boolean;
  resolve: (message: RpcReturnMessage) => void;
  reject: (error: unknown) => void;
  timeout?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Options for {@link RpcWireClient}.
 */
export interface RpcWireClientOptions {
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
   * Maximum cap-bearing questions awaiting a terminal Return, including
   * canceled waiters. Defaults to 4096; must be a positive integer. At the
   * limit, new param-cap calls and callback exports are rejected until a
   * terminal Return frees a slot. Existing grants are never evicted.
   */
  maxOutstandingParamCapQuestions?: number;
  /**
   * Optional callback for inbound non-Return frames observed by this client.
   */
  onUnexpectedFrame?: (
    frame: Uint8Array,
    tag: number,
  ) => void | Promise<void>;
  /**
   * Optional observability hook for diagnostics and tracing.
   */
  observability?: RpcObservability;
}

/**
 * Operational snapshot for {@link RpcWireClient}.
 */
export interface RpcWireClientStats {
  /** Whether the client or its underlying transport has closed. */
  readonly closed: boolean;
  /** Number of in-flight Bootstrap/Call questions waiting for Return frames. */
  readonly pendingReturns: number;
  /** Number of local callback capabilities currently exported by the client. */
  readonly exportedCapabilities: number;
  /** Question ID that will be assigned to the next Bootstrap/Call request. */
  readonly nextQuestionId: number;
  /** Default wait timeout in milliseconds, or `null` when calls wait indefinitely. */
  readonly defaultTimeoutMs: number | null;
}

/**
 * Cap'n Proto RPC client adapter over a started {@link RpcTransport}.
 *
 * This adapter sends Bootstrap/Call/Finish/Release frames directly and waits
 * for matching Return frames by question ID.
 */
export class RpcWireClient {
  /** Underlying started network transport. */
  readonly transport: RpcTransport;

  readonly #interfaceId: bigint | undefined;
  #nextQuestionId: number;
  readonly #defaultTimeoutMs: number | undefined;
  readonly #maxOutstandingParamCapQuestions: number;
  readonly #onUnexpectedFrame: RpcWireClientOptions["onUnexpectedFrame"];
  readonly #observability: RpcObservability | undefined;

  #closed = false;
  readonly #closeSignal = new TransportCloseSignal();
  readonly #whenClosed = new Promise<void>((resolve) => {
    this.#closeSignal.subscribe(resolve);
  });
  #unsubscribeClose: (() => void) | undefined;
  #startError: unknown = null;
  #startPromise: Promise<void>;
  #pendingReturns = new Map<number, PendingReturnWaiter>();
  #localBridge: RpcServerBridge | null = null;
  /**
   * Questions whose Return carried capability-table entries. The caller
   * received live capability references for these, so a later
   * {@link finish} must not spend the wire references by default. Entries
   * are removed when the question is finished (or the client closes).
   */
  #questionsWithResultCaps = new Set<number>();
  // Wire grants outlive canceled waiters until a terminal Return or close.
  #questionParamCapGrants = new Map<number, Map<number, number>>();

  constructor(
    transport: RpcTransport,
    options: RpcWireClientOptions = {},
  ) {
    this.transport = transport;
    this.#interfaceId = options.interfaceId;
    this.#nextQuestionId = options.nextQuestionId ?? 1;
    this.#defaultTimeoutMs = options.defaultTimeoutMs;
    this.#maxOutstandingParamCapQuestions =
      options.maxOutstandingParamCapQuestions ?? 4096;
    if (
      !Number.isSafeInteger(this.#maxOutstandingParamCapQuestions) ||
      this.#maxOutstandingParamCapQuestions <= 0
    ) {
      throw new SessionError(
        "maxOutstandingParamCapQuestions must be a positive safe integer",
      );
    }
    this.#onUnexpectedFrame = options.onUnexpectedFrame;
    this.#observability = options.observability;

    this.#unsubscribeClose = subscribeTransportClose(
      this.transport,
      () => this.#markClosed(),
    );

    let started: void | Promise<void>;
    try {
      started = this.#closed
        ? undefined
        : this.transport.start((frame) => this.#onFrame(frame));
    } catch (error) {
      this.#unsubscribeClose();
      this.#unsubscribeClose = undefined;
      throw error;
    }
    this.#startPromise = Promise.race([started, this.#whenClosed]).catch(
      (error) => {
        this.#unsubscribeClose?.();
        this.#unsubscribeClose = undefined;
        this.#startError = error;
        emitObservabilityEvent(this.#observability, {
          name: "rpc.wire_client.start_error",
          error,
        });
        this.#rejectAllPending(
          new SessionError("rpc wire client failed to start", {
            cause: error,
            metadata: { phase: "transport" },
          }),
        );
      },
    );
  }

  /**
   * Current client lifecycle and in-flight request counters.
   *
   * @returns A point-in-time stats snapshot suitable for logs and health checks.
   *
   * @example
   * ```ts
   * const stats = client.stats;
   * console.log(stats.pendingReturns, stats.exportedCapabilities);
   * ```
   */
  get stats(): RpcWireClientStats {
    return {
      closed: this.#closed,
      pendingReturns: this.#pendingReturns.size,
      exportedCapabilities: this.exportedCapabilityCount,
      nextQuestionId: this.#nextQuestionId,
      defaultTimeoutMs: this.#defaultTimeoutMs ?? null,
    };
  }

  /**
   * Number of in-flight calls currently waiting for Return frames.
   *
   * @returns Current pending return waiter count.
   */
  get pendingReturnCount(): number {
    return this.#pendingReturns.size;
  }

  /**
   * Number of local callback capabilities exported by this client.
   *
   * @returns Current exported local capability count.
   */
  get exportedCapabilityCount(): number {
    return this.#localBridge?.capabilityCount ?? 0;
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
    if (response.kind !== "results") {
      throw new ProtocolError(`rpc bootstrap failed: ${response.reason}`, {
        metadata: {
          phase: "bootstrap",
          questionId,
          answerId: response.answerId,
          messageName: "Return",
        },
      });
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
   * Parameter capability grants settle on the peer's terminal Return, even
   * after a timeout or abort. A retaining peer releases them explicitly.
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
        "interfaceId is required for rpc wire client calls when no default interfaceId is configured",
      );
    }

    if (
      options.paramsCapTable?.some((entry) =>
        entry.tag === CAP_DESCRIPTOR_TAG_SENDER_HOSTED
      )
    ) {
      this.#checkParamCapAdmission();
    }

    const questionId = this.#allocQuestionId();
    options.onQuestionId?.(questionId);

    const target = options.target ?? {
      tag: RPC_CALL_TARGET_TAG_IMPORTED_CAP,
      importedCap: capability.capabilityIndex,
    };

    const frame = encodeCallRequestFrame({
      questionId,
      interfaceId,
      methodId,
      target,
      paramsContent: params,
      paramsCapTable: options.paramsCapTable,
    });
    this.#recordParamCapGrants(questionId, options.paramsCapTable);
    const response = await this.#requestReturn(
      questionId,
      frame,
      options,
    );
    if (response.kind !== "results") {
      throw new ProtocolError(`rpc call failed: ${response.reason}`, {
        metadata: {
          phase: "client_call",
          questionId,
          answerId: response.answerId,
          interfaceId,
          methodId,
          capabilityIndex: capability.capabilityIndex,
          messageName: "Return",
        },
      });
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
   *
   * When `options.releaseResultCaps` is not specified, the default depends
   * on the question's Return: if it carried capability-table entries the
   * finish retains them (`releaseResultCaps: false`) because the caller
   * holds live references that release themselves on close; cap-free
   * returns release (`true`). An explicit option always wins. Generated
   * stubs rely on this default when they auto-finish after a call whose
   * results carried capabilities.
   */
  async finish(
    questionId: number,
    options: RpcFinishOptions = {},
  ): Promise<void> {
    await this.#ensureReady();
    const returnedCaps = this.#questionsWithResultCaps.delete(questionId);
    await this.transport.send(encodeFinishFrame({
      questionId,
      releaseResultCaps: options.releaseResultCaps ?? !returnedCaps,
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
   * Release a local export before any question owns its reference.
   * @param capability - Locally exported capability.
   * @param referenceCount - Number of local references to release.
   * @returns Nothing; no remote Release frame is sent.
   * @example
   * ```ts
   * client.releaseExportedCapability(unusedCallback);
   * ```
   */
  releaseExportedCapability(
    capability: CapabilityPointer,
    referenceCount = 1,
  ): void {
    this.#localBridge?.releaseCapability(capability, referenceCount);
  }

  /**
   * Export a local server dispatch so the remote peer can call it back.
   */
  exportCapability(
    dispatch: RpcServerDispatch,
    options: { capabilityIndex?: number; referenceCount?: number } = {},
  ): CapabilityPointer {
    if (this.#closed) {
      throw new SessionError("rpc wire client is closed");
    }
    this.#checkParamCapAdmission();
    if (!this.#localBridge) {
      this.#localBridge = new RpcServerBridge({
        observability: this.#observability,
      });
    }
    const capability = this.#localBridge.exportCapability(dispatch, options);
    emitObservabilityEvent(this.#observability, {
      name: "rpc.wire_client.capability_export",
      attributes: {
        "rpc.capability_id": capability.capabilityIndex,
        "rpc.interface_id": dispatch.interfaceId,
      },
    });
    return capability;
  }

  /**
   * Close the transport and reject any pending waits.
   */
  async close(): Promise<void> {
    this.#markClosed();
    await this.transport.close();
  }

  #markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeSignal.close();
    this.#unsubscribeClose?.();
    this.#unsubscribeClose = undefined;
    this.#rejectAllPending(new SessionError("rpc wire client is closed"));
    this.#questionsWithResultCaps.clear();
    this.#questionParamCapGrants.clear();
    this.#localBridge?.close();
    this.#localBridge = null;
  }

  async #onFrame(frame: Uint8Array): Promise<void> {
    let tag: number;
    try {
      tag = decodeRpcMessageTag(frame);
    } catch {
      emitObservabilityEvent(this.#observability, {
        name: "rpc.wire_client.frame_decode_error",
        attributes: { "rpc.frame_bytes": frame.byteLength },
        error: new ProtocolError("failed to decode inbound frame tag", {
          metadata: {
            phase: "frame_decode",
            frameBytes: frame.byteLength,
          },
        }),
      });
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
              metadata: {
                phase: "dispatch",
                messageTag: tag,
                messageName: "Call",
                frameBytes: frame.byteLength,
              },
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
          metadata: {
            phase: "frame_decode",
            messageTag: tag,
            messageName: "Return",
            frameBytes: frame.byteLength,
          },
        }),
      );
      return;
    }

    // An aborted waiter is gone, but its transmitted param grants still
    // belong to this question. Settle before looking up the live waiter.
    this.#settleParamCapGrants(decoded.answerId, decoded.releaseParamCaps);
    const waiter = this.#pendingReturns.get(decoded.answerId);
    if (!waiter) return;
    if (
      !waiter.settled && decoded.kind === "results" &&
      decoded.capTable.length > 0
    ) {
      // The caller is about to receive live capability references from this
      // Return; remember that so finish() retains them by default.
      this.#questionsWithResultCaps.add(decoded.answerId);
    }
    this.#settleWaiter(decoded.answerId, waiter, decoded);
  }

  #recordParamCapGrants(
    questionId: number,
    capTable: RpcCapDescriptor[] | undefined,
  ): void {
    let grants: Map<number, number> | undefined;
    for (const descriptor of capTable ?? []) {
      if (descriptor.tag !== CAP_DESCRIPTOR_TAG_SENDER_HOSTED) continue;
      grants ??= new Map<number, number>();
      grants.set(descriptor.id, (grants.get(descriptor.id) ?? 0) + 1);
    }
    if (grants) this.#questionParamCapGrants.set(questionId, grants);
  }

  #checkParamCapAdmission(): void {
    if (
      this.#questionParamCapGrants.size >= this.#maxOutstandingParamCapQuestions
    ) {
      throw new SessionError(
        `outstanding param-cap question limit of ${this.#maxOutstandingParamCapQuestions} reached`,
      );
    }
  }

  #settleParamCapGrants(questionId: number, release: boolean): void {
    const grants = this.#questionParamCapGrants.get(questionId);
    // Retire bookkeeping on either terminal flag so replays cannot spend
    // another grant. releaseParamCaps=false leaves the peer's explicit
    // Release path solely responsible for dropping the references.
    this.#questionParamCapGrants.delete(questionId);
    if (!release || !grants || !this.#localBridge) return;
    for (const [capabilityIndex, referenceCount] of grants) {
      try {
        this.#localBridge.releaseCapability(capabilityIndex, referenceCount);
      } catch (error) {
        emitObservabilityEvent(this.#observability, {
          name: "rpc.wire_client.param_cap_settle_error",
          error,
          attributes: {
            "rpc.question_id": questionId,
            "rpc.capability_id": capabilityIndex,
            "rpc.reference_count": referenceCount,
          },
        });
      }
    }
  }

  async #ensureReady(): Promise<void> {
    if (this.#closed) {
      throw new SessionError("rpc wire client is closed");
    }
    await this.#startPromise;
    if (this.#closed) {
      throw new SessionError("rpc wire client is closed");
    }
    if (this.#startError !== null) {
      throw new SessionError("rpc wire client failed to start", {
        cause: this.#startError,
        metadata: { phase: "transport" },
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
    if (
      this.#pendingReturns.has(questionId) ||
      this.#questionParamCapGrants.has(questionId)
    ) {
      throw new SessionError(
        `questionId ${questionId} is still awaiting a terminal Return`,
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
    if (this.#closed) {
      this.#questionParamCapGrants.delete(questionId);
      throw new SessionError("rpc wire client is closed");
    }
    const wait = this.#waitForReturn(questionId, options);
    // Cancellation can reject before send completes. Keep the rejection
    // handled while preserving Finish for a successfully written request.
    void wait.catch(() => {});
    let stopWaitingForClose: (() => void) | undefined;
    const closed = new Promise<never>((_, reject) => {
      stopWaitingForClose = this.#closeSignal.subscribe(() =>
        reject(new SessionError("rpc wire client is closed"))
      );
    });
    let frameSent = false;
    let handoffStarted = false;
    try {
      await Promise.race([
        Promise.resolve().then(() => {
          if (this.#closed) throw new SessionError("rpc wire client is closed");
          handoffStarted = true;
          return this.transport.send(frame);
        }),
        // EOF must reject even while transport write cleanup lags. Ordinary
        // cancellation waits for send completion so it can send early Finish.
        closed,
      ]);
      frameSent = true;
    } catch (error) {
      // A rejected write may already have delivered the Call. Once handed
      // to the transport, its grants need a terminal Return or client close.
      if (!handoffStarted) this.#questionParamCapGrants.delete(questionId);
      const pending = this.#pendingReturns.get(questionId);
      if (pending) {
        this.#settleWaiter(questionId, pending, error);
      }
      // Ensure the waiter promise does not leak as an unhandled rejection when
      // send fails before we can await `wait`.
      await wait.catch(() => {});
      throw annotateCapnpError(error, {
        phase: "transport",
        questionId,
        frameBytes: frame.byteLength,
      }, "rpc wire client send failed");
    } finally {
      stopWaitingForClose?.();
    }
    try {
      return await wait;
    } catch (error) {
      if (frameSent && (options.autoFinish ?? true)) {
        await this.#tryFinishAfterWaitFailure(questionId, options.finish);
      }
      throw annotateCapnpError(error, {
        phase: "client_wait",
        questionId,
      });
    }
  }

  async #tryFinishAfterWaitFailure(
    questionId: number,
    options: RpcFinishOptions = {},
  ): Promise<void> {
    try {
      await this.finish(questionId, {
        releaseResultCaps: options.releaseResultCaps,
        requireEarlyCancellation: options.requireEarlyCancellation ?? true,
      });
    } catch {
      // Best-effort cleanup only; preserve the original request failure.
    }
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
        reject(
          new SessionError("rpc wait aborted", {
            metadata: { phase: "client_wait", questionId },
          }),
        );
        return;
      }

      if (timeoutMs !== undefined) {
        waiter.timeout = setTimeout(() => {
          this.#settleWaiter(
            questionId,
            waiter,
            new SessionError(`rpc wait timed out after ${timeoutMs}ms`, {
              metadata: { phase: "client_wait", questionId },
            }),
          );
        }, timeoutMs);
      }

      if (options.signal) {
        waiter.signal = options.signal;
        waiter.onAbort = () => {
          this.#settleWaiter(
            questionId,
            waiter,
            new SessionError("rpc wait aborted", {
              metadata: { phase: "client_wait", questionId },
            }),
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
