import {
  normalizeSessionError,
  ProtocolError,
  SessionError,
} from "./errors.ts";
import type { RpcSession } from "./session.ts";
import type { RpcTransport } from "./transport.ts";
import {
  decodeReturnFrame,
  encodeBootstrapRequestFrame,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  extractBootstrapCapabilityIndex,
  RPC_CALL_TARGET_TAG_IMPORTED_CAP,
  RPC_CALL_TARGET_TAG_PROMISED_ANSWER,
  RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD,
  type RpcCallTarget,
  type RpcCapDescriptor,
  type RpcPromisedAnswerOp,
} from "./rpc_wire.ts";

/**
 * Options for the Cap'n Proto RPC `finish` message, which signals to the server
 * that the client is done with a particular question.
 */
export interface RpcFinishOptions {
  /**
   * Whether to release all capabilities in the result's cap table.
   * Defaults to `true` when not specified.
   */
  releaseResultCaps?: boolean;
  /**
   * Whether the server should cancel the call if it has not yet started
   * processing it. Defaults to `false` when not specified.
   */
  requireEarlyCancellation?: boolean;
}

/**
 * Options that control the behavior of an RPC call made through
 * {@link SessionRpcClientTransport}.
 */
export interface RpcClientCallOptions {
  /** An {@link AbortSignal} that can be used to cancel the call. */
  signal?: AbortSignal;
  /** Maximum time in milliseconds to wait for a response before timing out. */
  timeoutMs?: number;
  /**
   * Callback invoked with the allocated question ID immediately after
   * the call frame is sent, before waiting for a response.
   */
  onQuestionId?: (questionId: number) => void;
  /**
   * Whether to automatically send a `finish` message after receiving the
   * response. Defaults to `true`. Set to `false` for pipelined calls where
   * you need the question to remain open.
   */
  autoFinish?: boolean;
  /** Options forwarded to the auto-finish message, if `autoFinish` is enabled. */
  finish?: RpcFinishOptions;
  /**
   * Capability descriptors to include in the params cap table, allowing
   * capabilities to be passed as call parameters.
   */
  paramsCapTable?: RpcCapDescriptor[];
  /**
   * Override the default call target. By default, calls target an imported
   * capability. Use this to target a promised answer for pipelined calls.
   */
  target?: RpcCallTarget;
}

/**
 * The result of an RPC call, containing the response payload and metadata.
 */
export interface RpcClientCallResult {
  /** The answer ID from the server's return message (matches the question ID). */
  answerId: number;
  /** The raw Cap'n Proto content bytes of the response struct. */
  contentBytes: Uint8Array;
  /** Capability descriptors exported in the response's cap table. */
  capTable: RpcCapDescriptor[];
  /** Whether the server has already released the params capabilities. */
  releaseParamCaps: boolean;
  /** Whether the server indicated that no `finish` message is needed. */
  noFinishNeeded: boolean;
}

/**
 * Represents a reference to the result of an in-flight RPC call.
 * Can be used to make pipelined calls on the promised result without
 * waiting for the original call to complete, eliminating network round-trips.
 *
 * This is the core primitive for Cap'n Proto Level 2 RPC (promise pipelining).
 */
export class RpcPipeline {
  readonly questionId: number;
  readonly #transform: RpcPromisedAnswerOp[];

  constructor(questionId: number, transform?: RpcPromisedAnswerOp[]) {
    this.questionId = questionId;
    this.#transform = transform ?? [];
  }

  /**
   * Create a new pipeline that selects a specific pointer field from
   * this pipeline's result. This is used when the result struct contains
   * multiple capability pointers and you need to select a specific one.
   */
  getPointerField(index: number): RpcPipeline {
    return new RpcPipeline(this.questionId, [
      ...this.#transform,
      {
        tag: RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD,
        pointerIndex: index,
      },
    ]);
  }

  /**
   * Build an RpcCallTarget that references this pipeline's promised answer.
   * This target can be passed as the `target` option to `callRaw` or `call`.
   */
  toCallTarget(): RpcCallTarget {
    return {
      tag: RPC_CALL_TARGET_TAG_PROMISED_ANSWER,
      promisedAnswer: {
        questionId: this.questionId,
        transform: this.#transform.length > 0
          ? [...this.#transform]
          : undefined,
      },
    };
  }
}

/**
 * Extended transport interface used by the client-side RPC harness. In addition
 * to the standard {@link RpcTransport} methods, it exposes methods to inject
 * inbound frames (simulating the remote peer) and to wait for outbound frames
 * produced by the local session.
 */
export interface RpcSessionHarnessTransport extends RpcTransport {
  /**
   * Inject a frame into the transport as if it were received from the remote peer.
   * @param frame - The raw Cap'n Proto frame bytes to deliver to the session.
   */
  emitInbound(frame: Uint8Array): Promise<void>;
  /**
   * Wait for the next outbound frame produced by the local session.
   * @param options - Optional signal and timeout controls.
   * @returns The next outbound Cap'n Proto frame.
   */
  nextOutboundFrame(options?: RpcClientCallOptions): Promise<Uint8Array>;
}

/**
 * Configuration options for creating a {@link SessionRpcClientTransport}.
 */
export interface SessionRpcClientTransportOptions {
  /** The Cap'n Proto interface ID for all calls made through this transport. */
  interfaceId: bigint | number;
  /** The starting question ID. Defaults to 1. */
  nextQuestionId?: number;
  /**
   * Whether to automatically start the underlying session on the first
   * operation. Defaults to `true`.
   */
  autoStart?: boolean;
}

/**
 * An in-memory implementation of {@link RpcSessionHarnessTransport} for testing.
 *
 * Outbound frames sent by the session are queued and can be retrieved via
 * {@link nextOutboundFrame}. Inbound frames are delivered to the session's
 * `onFrame` callback via {@link emitInbound}.
 *
 * This transport is primarily useful for unit and integration tests where
 * no real network connection is desired.
 */
export class InMemoryRpcHarnessTransport implements RpcSessionHarnessTransport {
  #onFrame: ((frame: Uint8Array) => void | Promise<void>) | null = null;
  #closed = false;
  #outboundQueue: Uint8Array[] = [];
  #waiters: Array<{
    resolve: (frame: Uint8Array) => void;
    reject: (error: unknown) => void;
  }> = [];

  start(
    onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): void {
    if (this.#closed) throw new SessionError("transport is closed");
    this.#onFrame = onFrame;
  }

  send(frame: Uint8Array): void {
    if (this.#closed) throw new SessionError("transport is closed");
    const copy = new Uint8Array(frame);
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve(copy);
      return;
    }
    this.#outboundQueue.push(copy);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onFrame = null;
    const error = new SessionError("transport is closed");
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  async emitInbound(frame: Uint8Array): Promise<void> {
    if (this.#closed) throw new SessionError("transport is closed");
    if (!this.#onFrame) throw new SessionError("transport is not started");
    await this.#onFrame(new Uint8Array(frame));
  }

  async nextOutboundFrame(
    options: RpcClientCallOptions = {},
  ): Promise<Uint8Array> {
    if (this.#outboundQueue.length > 0) {
      return new Uint8Array(this.#outboundQueue.shift()!);
    }
    if (this.#closed) {
      throw new SessionError("transport is closed");
    }

    return await new Promise<Uint8Array>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        cleanup();
        reject(new SessionError("rpc wait aborted"));
      };
      const cleanup = (): void => {
        if (timeout !== undefined) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const wrappedResolve = (frame: Uint8Array): void => {
        cleanup();
        resolve(frame);
      };
      const wrappedReject = (error: unknown): void => {
        cleanup();
        reject(error);
      };

      if (options.signal?.aborted) {
        wrappedReject(new SessionError("rpc wait aborted"));
        return;
      }
      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          wrappedReject(
            new SessionError(`rpc wait timed out after ${options.timeoutMs}ms`),
          );
        }, options.timeoutMs);
      }
      if (options.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.#waiters.push({
        resolve: wrappedResolve,
        reject: wrappedReject,
      });
    });
  }
}

/**
 * Client-side RPC transport that drives an {@link RpcSession} through a
 * {@link RpcSessionHarnessTransport}.
 *
 * Provides high-level methods for the Cap'n Proto RPC flow:
 * - {@link bootstrap} - Obtain the server's bootstrap capability.
 * - {@link call} - Send a call and return just the content bytes.
 * - {@link callRaw} - Send a call and return the full {@link RpcClientCallResult}.
 * - {@link callRawPipelined} - Send a call and immediately get a pipeline handle
 *   for promise pipelining (Level 2 RPC) without waiting for the response.
 * - {@link finish} - Tell the server a question is done.
 * - {@link release} - Release a capability reference.
 *
 * All operations are serialized through an internal queue to ensure that
 * outbound frames are sent and responses collected in the correct order.
 *
 * @example
 * ```ts
 * const transport = new InMemoryRpcHarnessTransport();
 * const session = new RpcSession(peer, transport);
 * const client = new SessionRpcClientTransport(session, transport, {
 *   interfaceId: 0xabcd1234n,
 * });
 * const cap = await client.bootstrap();
 * const result = await client.call(cap, 0, new Uint8Array());
 * ```
 */
export class SessionRpcClientTransport {
  /** The underlying RPC session driven by this client transport. */
  readonly session: RpcSession;
  /** The harness transport used to inject and collect frames. */
  readonly transport: RpcSessionHarnessTransport;

  #interfaceId: bigint;
  #nextQuestionId: number;
  #autoStart: boolean;
  #opChain: Promise<void> = Promise.resolve();

  constructor(
    session: RpcSession,
    transport: RpcSessionHarnessTransport,
    options: SessionRpcClientTransportOptions,
  ) {
    this.session = session;
    this.transport = transport;
    this.#interfaceId = typeof options.interfaceId === "bigint"
      ? options.interfaceId
      : BigInt(options.interfaceId);
    this.#nextQuestionId = options.nextQuestionId ?? 1;
    this.#autoStart = options.autoStart ?? true;
  }

  /**
   * Send a bootstrap request to obtain the server's root capability.
   *
   * @param options - Call options including timeout and abort signal.
   * @returns An object containing the `capabilityIndex` of the bootstrap capability.
   * @throws {ProtocolError} If the server returns an exception.
   */
  async bootstrap(
    options: RpcClientCallOptions = {},
  ): Promise<{ capabilityIndex: number }> {
    return await this.#enqueue(async () => {
      const questionId = this.#allocQuestionId();
      options.onQuestionId?.(questionId);
      const frame = encodeBootstrapRequestFrame({ questionId });
      const message = await this.#request(questionId, frame, options);
      if (message.kind === "exception") {
        throw new ProtocolError(`rpc bootstrap failed: ${message.reason}`);
      }

      if ((options.autoFinish ?? true) && !message.noFinishNeeded) {
        await this.#sendFinish(questionId, options.finish);
      }

      return {
        capabilityIndex: extractBootstrapCapabilityIndex(message),
      };
    });
  }

  /**
   * Send an RPC call and return just the response content bytes.
   *
   * This is a convenience wrapper around {@link callRaw} that discards
   * metadata (cap table, flags) and returns only the payload.
   *
   * @param capability - The target capability obtained from {@link bootstrap} or a cap table.
   * @param methodOrdinal - The zero-based method index within the interface.
   * @param params - The raw Cap'n Proto params struct bytes.
   * @param options - Call options including timeout and abort signal.
   * @returns The raw content bytes of the response struct.
   * @throws {ProtocolError} If the server returns an exception.
   */
  async call(
    capability: { capabilityIndex: number },
    methodOrdinal: number,
    params: Uint8Array,
    options: RpcClientCallOptions = {},
  ): Promise<Uint8Array> {
    const response = await this.callRaw(
      capability,
      methodOrdinal,
      params,
      options,
    );
    return response.contentBytes;
  }

  /**
   * Send an RPC call and return the full result including metadata.
   *
   * @param capability - The target capability obtained from {@link bootstrap} or a cap table.
   * @param methodOrdinal - The zero-based method index within the interface.
   * @param params - The raw Cap'n Proto params struct bytes.
   * @param options - Call options including timeout, abort signal, and cap table.
   * @returns The full call result including content bytes, cap table, and flags.
   * @throws {ProtocolError} If the server returns an exception.
   */
  async callRaw(
    capability: { capabilityIndex: number },
    methodOrdinal: number,
    params: Uint8Array,
    options: RpcClientCallOptions = {},
  ): Promise<RpcClientCallResult> {
    return await this.#enqueue(async () => {
      const questionId = this.#allocQuestionId();
      options.onQuestionId?.(questionId);
      const target = options.target ?? {
        tag: RPC_CALL_TARGET_TAG_IMPORTED_CAP,
        importedCap: capability.capabilityIndex,
      };
      const frame = encodeCallRequestFrame({
        questionId,
        interfaceId: this.#interfaceId,
        methodId: methodOrdinal,
        target,
        paramsContent: params,
        paramsCapTable: options.paramsCapTable,
      });
      const message = await this.#request(questionId, frame, options);
      if (message.kind === "exception") {
        throw new ProtocolError(`rpc call failed: ${message.reason}`);
      }

      if ((options.autoFinish ?? true) && !message.noFinishNeeded) {
        await this.#sendFinish(questionId, options.finish);
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
    });
  }

  /**
   * Send an RPC call and immediately return a pipeline handle that can be
   * used to make pipelined calls on the (not-yet-resolved) result, plus
   * a promise for the actual result.
   *
   * Unlike `callRaw`, this does NOT automatically send a finish frame.
   * The caller MUST eventually call `finish()` on the returned questionId
   * to clean up server-side state.
   *
   * This is the core method for promise pipelining (Level 2 RPC).
   */
  async callRawPipelined(
    capability: { capabilityIndex: number },
    methodOrdinal: number,
    params: Uint8Array,
    options: RpcClientCallOptions = {},
  ): Promise<{ pipeline: RpcPipeline; result: Promise<RpcClientCallResult> }> {
    return await this.#enqueue(async () => {
      const questionId = this.#allocQuestionId();
      options.onQuestionId?.(questionId);
      const target = options.target ?? {
        tag: RPC_CALL_TARGET_TAG_IMPORTED_CAP,
        importedCap: capability.capabilityIndex,
      };
      const frame = encodeCallRequestFrame({
        questionId,
        interfaceId: this.#interfaceId,
        methodId: methodOrdinal,
        target,
        paramsContent: params,
        paramsCapTable: options.paramsCapTable,
      });

      // Send the call frame but do NOT wait for the response yet.
      await this.#ensureStarted();
      await this.transport.emitInbound(frame);
      await this.session.flush();

      const pipeline = new RpcPipeline(questionId);

      // Create a promise that will collect the response asynchronously.
      const result = this.#collectResponse(questionId, options);

      return { pipeline, result };
    });
  }

  /**
   * Send a `finish` message to the server for a specific question, signaling
   * that the client is done with the answer.
   *
   * @param questionId - The question ID to finish.
   * @param options - Options controlling capability release behavior.
   */
  async finish(
    questionId: number,
    options: RpcFinishOptions = {},
  ): Promise<void> {
    await this.#enqueue(async () => {
      await this.#sendFinish(questionId, options);
    });
  }

  /**
   * Send a `release` message to the server, decrementing the reference count
   * for a previously imported capability.
   *
   * @param capability - The capability to release.
   * @param referenceCount - Number of references to release. Defaults to 1.
   */
  async release(
    capability: { capabilityIndex: number },
    referenceCount = 1,
  ): Promise<void> {
    await this.#enqueue(async () => {
      await this.#sendRelease(capability.capabilityIndex, referenceCount);
    });
  }

  #allocQuestionId(): number {
    const next = this.#nextQuestionId;
    this.#nextQuestionId += 1;
    return next;
  }

  async #ensureStarted(): Promise<void> {
    if (!this.#autoStart) return;
    if (this.session.started) return;
    await this.session.start();
  }

  async #request(
    questionId: number,
    frame: Uint8Array,
    options: RpcClientCallOptions,
  ) {
    await this.#ensureStarted();
    await this.transport.emitInbound(frame);
    await this.session.flush();

    const started = Date.now();
    while (true) {
      const remaining = options.timeoutMs === undefined
        ? undefined
        : Math.max(0, options.timeoutMs - (Date.now() - started));
      const outbound = await this.transport.nextOutboundFrame({
        signal: options.signal,
        timeoutMs: remaining,
      });
      let decoded;
      try {
        decoded = decodeReturnFrame(outbound);
      } catch {
        continue;
      }
      if (decoded.answerId !== questionId) {
        continue;
      }
      return decoded;
    }
  }

  /**
   * Collect the response for a previously-sent call frame.
   * Used by callRawPipelined to asynchronously gather the result
   * without blocking the op chain.
   */
  async #collectResponse(
    questionId: number,
    options: RpcClientCallOptions,
  ): Promise<RpcClientCallResult> {
    const started = Date.now();
    while (true) {
      const remaining = options.timeoutMs === undefined
        ? undefined
        : Math.max(0, options.timeoutMs - (Date.now() - started));
      const outbound = await this.transport.nextOutboundFrame({
        signal: options.signal,
        timeoutMs: remaining,
      });
      let decoded;
      try {
        decoded = decodeReturnFrame(outbound);
      } catch {
        continue;
      }
      if (decoded.answerId !== questionId) {
        continue;
      }
      if (decoded.kind === "exception") {
        throw new ProtocolError(`rpc call failed: ${decoded.reason}`);
      }
      return {
        answerId: decoded.answerId,
        contentBytes: new Uint8Array(decoded.contentBytes),
        capTable: decoded.capTable.map((entry) => ({
          tag: entry.tag,
          id: entry.id,
        })),
        releaseParamCaps: decoded.releaseParamCaps,
        noFinishNeeded: decoded.noFinishNeeded,
      };
    }
  }

  async #sendFinish(
    questionId: number,
    options: RpcFinishOptions = {},
  ): Promise<void> {
    await this.#ensureStarted();
    const frame = encodeFinishFrame({
      questionId,
      releaseResultCaps: options.releaseResultCaps ?? true,
      requireEarlyCancellation: options.requireEarlyCancellation ?? false,
    });
    await this.transport.emitInbound(frame);
    await this.session.flush();
  }

  async #sendRelease(
    capabilityId: number,
    referenceCount: number,
  ): Promise<void> {
    await this.#ensureStarted();
    const frame = encodeReleaseFrame({
      id: capabilityId,
      referenceCount,
    });
    await this.transport.emitInbound(frame);
    await this.session.flush();
  }

  async #enqueue<T>(op: () => Promise<T>): Promise<T> {
    const gate = this.#opChain;
    let release!: () => void;
    this.#opChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await gate;
    try {
      return await op();
    } catch (error) {
      throw normalizeSessionError(
        error,
        "rpc client transport operation failed",
      );
    } finally {
      release();
    }
  }
}
