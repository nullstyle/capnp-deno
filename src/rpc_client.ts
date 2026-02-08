import {
  normalizeSessionError,
  ProtocolError,
  SessionError,
} from "./errors.ts";
import { RpcSession, type RpcSessionOptions } from "./session.ts";
import type { RpcTransport } from "./transport.ts";
import type { RpcRuntimeModuleOptions } from "./runtime_module.ts";
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
  type RpcReturnMessage,
} from "./rpc_wire.ts";

/**
 * Context object passed to client middleware hooks.
 *
 * Contains metadata about the current outbound call and a mutable `state` map
 * that middleware can use to pass data between hooks or to downstream middleware.
 */
export interface ClientMiddlewareContext {
  /** The question ID allocated for this call. */
  readonly questionId: number;
  /** The Cap'n Proto interface ID for this call. */
  readonly interfaceId: bigint;
  /** The method ordinal within the interface. */
  readonly methodId: number;
  /**
   * The capability index of the call target. For imported-cap targets this
   * is the index in the capability table; for promised-answer targets this
   * is the question ID of the promise being pipelined.
   */
  readonly capabilityIndex: number;
  /**
   * Mutable key-value map that middleware can use to pass data between hooks
   * and to downstream middleware in the chain.
   */
  readonly state: Map<string, unknown>;
}

/**
 * Interceptor that can inspect and transform client-side RPC calls at
 * various lifecycle stages. Implement one or more hooks to add cross-cutting
 * behavior such as logging, tracing, metrics, or request rewriting.
 *
 * All hooks are optional. Both sync and async returns are supported.
 *
 * Middleware hooks:
 * - `onCall`: Called before a call frame is sent to the server.
 * - `onResponse`: Called when a successful response is received.
 * - `onError`: Called when a call fails with an error or server exception.
 *
 * @example
 * ```ts
 * const logger: RpcClientMiddleware = {
 *   onCall(ctx) {
 *     console.log(`call method=${ctx.methodId} iface=${ctx.interfaceId}`);
 *   },
 *   onResponse(result, ctx) {
 *     console.log(`response for question=${ctx.questionId}`);
 *     return result;
 *   },
 * };
 * const client = new SessionRpcClientTransport(session, transport, {
 *   interfaceId: 0x1234n,
 *   middleware: [logger],
 * });
 * ```
 */
export interface RpcClientMiddleware {
  /**
   * Called before a call frame is sent to the server.
   *
   * @param context - The call context with question ID, interface, method, and target info.
   */
  onCall?: (
    context: ClientMiddlewareContext,
  ) => void | Promise<void>;

  /**
   * Called when a successful response is received from the server.
   *
   * @param result - The raw content bytes of the response.
   * @param context - The call context.
   * @returns The (possibly transformed) response bytes, or `null` to keep the
   *   original. Both sync and async returns are accepted.
   */
  onResponse?: (
    result: Uint8Array,
    context: ClientMiddlewareContext,
  ) => Uint8Array | null | Promise<Uint8Array | null>;

  /**
   * Called when a call fails with an error or the server returns an exception.
   *
   * @param error - The error that occurred.
   * @param context - The call context.
   */
  onError?: (
    error: unknown,
    context: ClientMiddlewareContext,
  ) => void | Promise<void>;
}

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
   * response. Defaults to `true`.
   *
   * **Conditional behavior**: Even when `true`, a `finish` message is sent
   * only if the server's return message has `noFinishNeeded === false`. If the
   * server sets `noFinishNeeded` to `true`, it has already released the answer
   * table entry on its side and no `finish` is needed. In other words,
   * `autoFinish: true` means "finish *if the server requires it*", not
   * "finish unconditionally".
   *
   * **Applies to**: {@link SessionRpcClientTransport.bootstrap},
   * {@link SessionRpcClientTransport.call}, and
   * {@link SessionRpcClientTransport.callRaw} only.
   *
   * **Does NOT apply to**: {@link SessionRpcClientTransport.callRawPipelined},
   * which **never** auto-finishes regardless of this setting. Pipelining
   * requires the question to remain open so that downstream calls can
   * reference it by question ID. You MUST manually call
   * {@link SessionRpcClientTransport.finish} when done with the pipeline.
   *
   * **Consequence of disabling**: If you set `autoFinish: false` and never
   * call {@link SessionRpcClientTransport.finish}, the server's answer table
   * entry for this question can persist indefinitely, causing a resource
   * leak. This includes timeout/abort paths, where `autoFinish: true`
   * performs best-effort cleanup by sending `finish`.
   *
   * @default true
   * @see {@link SessionRpcClientTransport.finish} to manually finish a question.
   * @see {@link SessionRpcClientTransport.callRawPipelined} for the pipelined call path.
   * @see {@link RpcClientCallResult.noFinishNeeded} for the server-side flag that gates auto-finish.
   */
  autoFinish?: boolean;
  /**
   * Options forwarded to auto-finish behavior when `autoFinish` is enabled:
   * - normal response path (when `noFinishNeeded` is `false`), and
   * - wait-failure cleanup path (timeout/abort after sending the call frame).
   *
   * Has no effect when `autoFinish` is `false` or when using
   * {@link SessionRpcClientTransport.callRawPipelined}.
   *
   * @see {@link RpcFinishOptions} for available options.
   */
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
  /**
   * Whether the server indicated that no `finish` message is needed.
   *
   * When `true`, the server has already released the answer table entry and
   * does not expect a `finish` message. When `false`, the client should send
   * a `finish` (either automatically via {@link RpcClientCallOptions.autoFinish}
   * or manually via {@link SessionRpcClientTransport.finish}) to allow the
   * server to clean up.
   *
   * @see {@link RpcClientCallOptions.autoFinish} which uses this flag to decide
   *   whether to send `finish` automatically.
   */
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
  /**
   * Default timeout in milliseconds applied to all calls (bootstrap, call,
   * callRaw, callRawPipelined) when the per-call `timeoutMs` option is not
   * specified. When both this and a per-call `timeoutMs` are omitted, calls
   * wait indefinitely for a response.
   */
  defaultTimeoutMs?: number;
  /**
   * Optional array of middleware interceptors. Middleware hooks are executed
   * in array order for `onCall`, and in array order for `onResponse` and
   * `onError`. All hooks run for every call/response/error even if an
   * earlier middleware transforms the response.
   */
  middleware?: RpcClientMiddleware[];
}

/**
 * Options for creating a {@link SessionRpcClientTransport} via
 * {@link SessionRpcClientTransport.create}.
 */
export interface SessionRpcClientTransportCreateOptions
  extends SessionRpcClientTransportOptions {
  /** Options forwarded to the internally-created {@link RpcSession}. */
  session?: RpcSessionOptions;
  /** Optional runtime-module loading overrides for the internal session. */
  runtimeModule?: RpcRuntimeModuleOptions;
  /** Whether to start the internal session before returning. Defaults to `false`. */
  startSession?: boolean;
}

interface PendingReturnWaiter {
  resolve: (message: RpcReturnMessage) => void;
  reject: (error: unknown) => void;
  timeout?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
}

interface PendingOutboundFrameWaiter {
  resolve: (frame: Uint8Array) => void;
  reject: (error: unknown) => void;
  settled: boolean;
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
 *
 * **Ownership model**: {@link send} is the only method that defensively copies
 * its input, because the caller (the session) may reuse the buffer.  After that
 * single copy the frame is owned by the transport.  {@link emitInbound} passes
 * the caller-provided buffer straight through — the caller is expected to not
 * mutate it afterwards.  {@link nextOutboundFrame} transfers ownership of the
 * already-copied buffer to the caller without an additional copy.
 */
export class InMemoryRpcHarnessTransport implements RpcSessionHarnessTransport {
  #onFrame: ((frame: Uint8Array) => void | Promise<void>) | null = null;
  #closed = false;
  #outboundQueue: Uint8Array[] = [];
  #waiters: PendingOutboundFrameWaiter[] = [];

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
    await this.#onFrame(frame);
  }

  async nextOutboundFrame(
    options: RpcClientCallOptions = {},
  ): Promise<Uint8Array> {
    if (this.#outboundQueue.length > 0) {
      return this.#outboundQueue.shift()!;
    }
    if (this.#closed) {
      throw new SessionError("transport is closed");
    }

    return await new Promise<Uint8Array>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const waiter: PendingOutboundFrameWaiter = {
        settled: false,
        resolve: (frame: Uint8Array): void => {
          if (waiter.settled) return;
          waiter.settled = true;
          this.#removeOutboundFrameWaiter(waiter);
          cleanup();
          resolve(frame);
        },
        reject: (error: unknown): void => {
          if (waiter.settled) return;
          waiter.settled = true;
          this.#removeOutboundFrameWaiter(waiter);
          cleanup();
          reject(error);
        },
      };
      const onAbort = (): void => {
        waiter.reject(new SessionError("rpc wait aborted"));
      };
      const cleanup = (): void => {
        if (timeout !== undefined) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      };

      if (options.signal?.aborted) {
        waiter.reject(new SessionError("rpc wait aborted"));
        return;
      }
      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          waiter.reject(
            new SessionError(`rpc wait timed out after ${options.timeoutMs}ms`),
          );
        }, options.timeoutMs);
      }
      if (options.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.#waiters.push(waiter);
    });
  }

  #removeOutboundFrameWaiter(waiter: PendingOutboundFrameWaiter): void {
    const index = this.#waiters.indexOf(waiter);
    if (index >= 0) {
      this.#waiters.splice(index, 1);
    }
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
  #defaultTimeoutMs: number | undefined;
  #middleware: RpcClientMiddleware[];
  #opChain: Promise<void> = Promise.resolve();
  #expectedReturns: Set<number> = new Set();
  #pendingReturns: Map<number, PendingReturnWaiter[]> = new Map();
  #queuedReturns: Map<number, RpcReturnMessage[]> = new Map();
  #responsePump: Promise<void> | null = null;
  #responsePumpAbort: AbortController | null = null;

  /**
   * Create a client transport with an internally-created session.
   *
   * This helper avoids direct WASM peer setup in app code.
   */
  static async create(
    transport: RpcSessionHarnessTransport,
    options: SessionRpcClientTransportCreateOptions,
  ): Promise<SessionRpcClientTransport> {
    const { session, runtimeModule, startSession, ...clientOptions } = options;
    const rpcSession = await RpcSession.create(transport, {
      ...(session ?? {}),
      runtimeModule,
      autoStart: startSession ?? false,
    });
    return new SessionRpcClientTransport(rpcSession, transport, clientOptions);
  }

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
    this.#defaultTimeoutMs = options.defaultTimeoutMs;
    this.#middleware = options.middleware ?? [];
  }

  /**
   * Send a bootstrap request to obtain the server's root capability.
   *
   * Respects the `autoFinish` option (defaults to `true`). When enabled, a
   * `finish` message is sent automatically after the bootstrap response,
   * unless the server's return has `noFinishNeeded === true`.
   *
   * @param options - Call options including timeout and abort signal.
   * @returns An object containing the `capabilityIndex` of the bootstrap capability.
   * @throws {ProtocolError} If the server returns an exception.
   * @see {@link RpcClientCallOptions.autoFinish} for auto-finish semantics.
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
   * Auto-finish behavior is inherited from the `options.autoFinish` setting
   * (defaults to `true`). See {@link RpcClientCallOptions.autoFinish} for
   * details on when a `finish` message is actually sent.
   *
   * @param capability - The target capability obtained from {@link bootstrap} or a cap table.
   * @param methodId - The zero-based method index within the interface.
   * @param params - The raw Cap'n Proto params struct bytes.
   * @param options - Call options including timeout and abort signal.
   * @returns The raw content bytes of the response struct.
   * @throws {ProtocolError} If the server returns an exception.
   * @see {@link callRaw} for the full-result variant.
   * @see {@link callRawPipelined} for the pipelined variant (requires manual {@link finish}).
   */
  async call(
    capability: { capabilityIndex: number },
    methodId: number,
    params: Uint8Array,
    options: RpcClientCallOptions = {},
  ): Promise<Uint8Array> {
    const response = await this.callRaw(
      capability,
      methodId,
      params,
      options,
    );
    return response.contentBytes;
  }

  /**
   * Send an RPC call and return the full result including metadata.
   *
   * When `options.autoFinish` is `true` (the default), a `finish` message is
   * sent automatically after receiving the response -- but only if the server's
   * return message has `noFinishNeeded === false`. If the server already set
   * `noFinishNeeded` to `true`, no `finish` is sent because the server has
   * already released the answer table entry.
   *
   * If you set `autoFinish: false`, you take responsibility for calling
   * {@link finish} yourself. Failing to do so will leak the server's answer
   * table entry for this question indefinitely, including timeout/abort paths.
   *
   * @param capability - The target capability obtained from {@link bootstrap} or a cap table.
   * @param methodId - The zero-based method index within the interface.
   * @param params - The raw Cap'n Proto params struct bytes.
   * @param options - Call options including timeout, abort signal, and cap table.
   * @returns The full call result including content bytes, cap table, and flags.
   * @throws {ProtocolError} If the server returns an exception.
   * @see {@link call} for the convenience variant that returns only content bytes.
   * @see {@link callRawPipelined} for the pipelined variant (requires manual {@link finish}).
   * @see {@link RpcClientCallOptions.autoFinish} for full auto-finish semantics.
   */
  async callRaw(
    capability: { capabilityIndex: number },
    methodId: number,
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

      const mwCtx = this.#middleware.length > 0
        ? this.#buildMiddlewareContext(questionId, methodId, target)
        : undefined;

      if (mwCtx) {
        await this.#runOnCall(mwCtx);
      }

      const frame = encodeCallRequestFrame({
        questionId,
        interfaceId: this.#interfaceId,
        methodId: methodId,
        target,
        paramsContent: params,
        paramsCapTable: options.paramsCapTable,
      });

      let message;
      try {
        message = await this.#request(questionId, frame, options);
      } catch (error) {
        if (mwCtx) {
          await this.#runOnError(error, mwCtx);
        }
        throw error;
      }

      if (message.kind === "exception") {
        const err = new ProtocolError(`rpc call failed: ${message.reason}`);
        if (mwCtx) {
          await this.#runOnError(err, mwCtx);
        }
        throw err;
      }

      if ((options.autoFinish ?? true) && !message.noFinishNeeded) {
        await this.#sendFinish(questionId, options.finish);
      }

      let contentBytes = new Uint8Array(message.contentBytes);
      if (mwCtx) {
        contentBytes = await this.#runOnResponse(contentBytes, mwCtx);
      }

      return {
        answerId: message.answerId,
        contentBytes,
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
   * **No auto-finish**: Unlike {@link call} and {@link callRaw}, this method
   * **never** sends a `finish` message automatically, regardless of the
   * `autoFinish` option. The `autoFinish` setting in
   * {@link RpcClientCallOptions} is completely ignored by this method. This is
   * necessary because promise pipelining requires the question to remain open
   * so that downstream pipelined calls can reference it by question ID.
   *
   * **Caller responsibility**: You MUST eventually call {@link finish} with
   * the returned `pipeline.questionId` once you are done with both the
   * pipeline and the result. Failing to do so will leak the server's answer
   * table entry for this question indefinitely.
   *
   * This is the core method for promise pipelining (Level 2 RPC).
   *
   * @param capability - The target capability obtained from {@link bootstrap} or a cap table.
   * @param methodId - The zero-based method index within the interface.
   * @param params - The raw Cap'n Proto params struct bytes.
   * @param options - Call options including timeout and abort signal. Note that
   *   `autoFinish` is ignored by this method.
   * @returns An object with a `pipeline` for making pipelined calls and a
   *   `result` promise that resolves to the full {@link RpcClientCallResult}.
   * @throws {ProtocolError} If the server returns an exception (via the `result` promise).
   * @see {@link callRaw} for the non-pipelined variant with auto-finish support.
   * @see {@link finish} to release the question when done with the pipeline.
   * @see {@link RpcPipeline} for how to make pipelined calls on the result.
   */
  async callRawPipelined(
    capability: { capabilityIndex: number },
    methodId: number,
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

      const mwCtx = this.#middleware.length > 0
        ? this.#buildMiddlewareContext(questionId, methodId, target)
        : undefined;

      if (mwCtx) {
        await this.#runOnCall(mwCtx);
      }

      const frame = encodeCallRequestFrame({
        questionId,
        interfaceId: this.#interfaceId,
        methodId: methodId,
        target,
        paramsContent: params,
        paramsCapTable: options.paramsCapTable,
      });

      // Send the call frame but do NOT wait for the response yet.
      this.#markReturnExpected(questionId);
      try {
        await this.#ensureStarted();
        await this.transport.emitInbound(frame);
        await this.session.flush();
      } catch (error) {
        this.#abandonExpectedReturn(questionId);
        throw error;
      }

      const pipeline = new RpcPipeline(questionId);

      // Create a promise that will collect the response asynchronously,
      // running middleware hooks on the result.
      const result = this.#collectResponse(questionId, options, mwCtx);

      return { pipeline, result };
    });
  }

  /**
   * Send a `finish` message to the server for a specific question, signaling
   * that the client is done with the answer and allowing the server to free
   * the corresponding answer table entry.
   *
   * You typically do not need to call this directly when using {@link call} or
   * {@link callRaw} with the default `autoFinish: true` setting, because those
   * methods send `finish` automatically (conditioned on the server's
   * `noFinishNeeded` flag).
   *
   * You MUST call this method manually when:
   * - Using {@link callRawPipelined}, which never auto-finishes.
   * - Using {@link callRaw} with `autoFinish: false`.
   *
   * @param questionId - The question ID to finish.
   * @param options - Options controlling capability release behavior.
   * @see {@link callRawPipelined} which requires manual finish.
   * @see {@link RpcClientCallOptions.autoFinish} for auto-finish semantics.
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

  #buildMiddlewareContext(
    questionId: number,
    methodId: number,
    target: RpcCallTarget,
  ): ClientMiddlewareContext {
    const capabilityIndex = target.tag === RPC_CALL_TARGET_TAG_IMPORTED_CAP
      ? target.importedCap
      : target.promisedAnswer.questionId;
    return {
      questionId,
      interfaceId: this.#interfaceId,
      methodId,
      capabilityIndex,
      state: new Map(),
    };
  }

  async #runOnCall(ctx: ClientMiddlewareContext): Promise<void> {
    for (const mw of this.#middleware) {
      if (mw.onCall) {
        await mw.onCall(ctx);
      }
    }
  }

  async #runOnResponse(
    contentBytes: Uint8Array,
    ctx: ClientMiddlewareContext,
  ): Promise<Uint8Array<ArrayBuffer>> {
    let result: Uint8Array<ArrayBuffer> = new Uint8Array(contentBytes);
    for (const mw of this.#middleware) {
      if (mw.onResponse) {
        const transformed = await mw.onResponse(result, ctx);
        if (transformed !== null) {
          result = new Uint8Array(transformed);
        }
      }
    }
    return result;
  }

  async #runOnError(
    error: unknown,
    ctx: ClientMiddlewareContext,
  ): Promise<void> {
    for (const mw of this.#middleware) {
      if (mw.onError) {
        await mw.onError(error, ctx);
      }
    }
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
  ): Promise<RpcReturnMessage> {
    this.#markReturnExpected(questionId);
    let frameSent = false;
    try {
      await this.#ensureStarted();
      await this.transport.emitInbound(frame);
      frameSent = true;
      await this.session.flush();
      return await this.#awaitReturn(questionId, options);
    } catch (error) {
      this.#abandonExpectedReturn(questionId);
      if (frameSent && (options.autoFinish ?? true)) {
        await this.#tryFinishAfterWaitFailure(questionId, options.finish);
      }
      throw error;
    }
  }

  async #tryFinishAfterWaitFailure(
    questionId: number,
    options: RpcFinishOptions = {},
  ): Promise<void> {
    try {
      await this.#sendFinish(questionId, {
        releaseResultCaps: options.releaseResultCaps,
        requireEarlyCancellation: options.requireEarlyCancellation ?? true,
      });
    } catch {
      // Best-effort cleanup only; preserve the original request failure.
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
    mwCtx?: ClientMiddlewareContext,
  ): Promise<RpcClientCallResult> {
    let decoded: RpcReturnMessage;
    try {
      decoded = await this.#awaitReturn(questionId, options);
    } catch (error) {
      if (mwCtx) {
        await this.#runOnError(error, mwCtx);
      }
      throw error;
    }

    if (decoded.kind === "exception") {
      const err = new ProtocolError(`rpc call failed: ${decoded.reason}`);
      if (mwCtx) {
        await this.#runOnError(err, mwCtx);
      }
      throw err;
    }

    let contentBytes = new Uint8Array(decoded.contentBytes);
    if (mwCtx) {
      contentBytes = await this.#runOnResponse(contentBytes, mwCtx);
    }

    return {
      answerId: decoded.answerId,
      contentBytes,
      capTable: decoded.capTable.map((entry) => ({
        tag: entry.tag,
        id: entry.id,
      })),
      releaseParamCaps: decoded.releaseParamCaps,
      noFinishNeeded: decoded.noFinishNeeded,
    };
  }

  async #awaitReturn(
    questionId: number,
    options: RpcClientCallOptions,
  ): Promise<RpcReturnMessage> {
    if (!this.#expectedReturns.has(questionId)) {
      throw new SessionError(
        `rpc wait rejected: question ${questionId} is not awaiting a return`,
      );
    }
    const queued = this.#takeQueuedReturn(questionId);
    if (queued) {
      this.#markReturnObserved(questionId);
      return queued;
    }

    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;

    return await new Promise<RpcReturnMessage>((resolve, reject) => {
      const waiter: PendingReturnWaiter = {
        resolve,
        reject,
        settled: false,
      };

      const rejectAndRemove = (error: unknown): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        this.#clearPendingReturnWaiter(waiter);
        this.#removePendingReturnWaiter(questionId, waiter);
        this.#abandonExpectedReturnIfUnobserved(questionId);
        reject(error);
      };

      if (options.signal?.aborted) {
        this.#abandonExpectedReturn(questionId);
        reject(new SessionError("rpc wait aborted"));
        return;
      }

      if (timeoutMs !== undefined) {
        waiter.timeout = setTimeout(() => {
          rejectAndRemove(
            new SessionError(`rpc wait timed out after ${timeoutMs}ms`),
          );
        }, timeoutMs);
      }

      if (options.signal) {
        waiter.signal = options.signal;
        waiter.onAbort = () => {
          rejectAndRemove(new SessionError("rpc wait aborted"));
        };
        options.signal.addEventListener("abort", waiter.onAbort, {
          once: true,
        });
      }

      const existing = this.#pendingReturns.get(questionId);
      if (existing) {
        existing.push(waiter);
      } else {
        this.#pendingReturns.set(questionId, [waiter]);
      }
      this.#ensureResponsePump();
    });
  }

  #takeQueuedReturn(questionId: number): RpcReturnMessage | undefined {
    const queued = this.#queuedReturns.get(questionId);
    if (!queued || queued.length === 0) return undefined;
    const next = queued.shift()!;
    if (queued.length === 0) {
      this.#queuedReturns.delete(questionId);
    }
    return next;
  }

  #queueReturn(message: RpcReturnMessage): void {
    if (!this.#expectedReturns.has(message.answerId)) {
      return;
    }
    const queued = this.#queuedReturns.get(message.answerId);
    if (queued) {
      // A question should produce a single return; keep at most one queued frame.
      return;
    }
    this.#queuedReturns.set(message.answerId, [message]);
  }

  #removePendingReturnWaiter(
    questionId: number,
    waiter: PendingReturnWaiter,
  ): void {
    const pending = this.#pendingReturns.get(questionId);
    if (!pending) return;
    const index = pending.indexOf(waiter);
    if (index >= 0) {
      pending.splice(index, 1);
    }
    if (pending.length === 0) {
      this.#pendingReturns.delete(questionId);
      this.#abortResponsePumpReadIfIdle();
    }
  }

  #clearPendingReturnWaiter(waiter: PendingReturnWaiter): void {
    if (waiter.timeout !== undefined) {
      clearTimeout(waiter.timeout);
      waiter.timeout = undefined;
    }
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.onAbort = undefined;
      waiter.signal = undefined;
    }
  }

  #hasPendingReturnWaiters(): boolean {
    return this.#pendingReturns.size > 0;
  }

  #markReturnExpected(questionId: number): void {
    this.#expectedReturns.add(questionId);
  }

  #markReturnObserved(questionId: number): void {
    this.#expectedReturns.delete(questionId);
    this.#queuedReturns.delete(questionId);
  }

  #abandonExpectedReturn(questionId: number): void {
    this.#markReturnObserved(questionId);
  }

  #abandonExpectedReturnIfUnobserved(questionId: number): void {
    const pending = this.#pendingReturns.get(questionId);
    if (pending && pending.length > 0) return;
    this.#abandonExpectedReturn(questionId);
  }

  #resolvePendingReturn(message: RpcReturnMessage): boolean {
    const pending = this.#pendingReturns.get(message.answerId);
    if (!pending || pending.length === 0) {
      return false;
    }

    while (pending.length > 0) {
      const waiter = pending.shift()!;
      if (waiter.settled) continue;
      waiter.settled = true;
      this.#clearPendingReturnWaiter(waiter);
      if (pending.length === 0) {
        this.#pendingReturns.delete(message.answerId);
      }
      this.#markReturnObserved(message.answerId);
      waiter.resolve(message);
      return true;
    }

    this.#pendingReturns.delete(message.answerId);
    this.#abortResponsePumpReadIfIdle();
    this.#abandonExpectedReturn(message.answerId);
    return false;
  }

  #rejectAllPendingReturns(error: unknown): void {
    const pendingEntries = [...this.#pendingReturns.entries()];
    this.#pendingReturns.clear();
    this.#abortResponsePumpReadIfIdle();
    for (const [questionId, waiters] of pendingEntries) {
      for (const waiter of waiters) {
        if (waiter.settled) continue;
        waiter.settled = true;
        this.#clearPendingReturnWaiter(waiter);
        waiter.reject(error);
      }
      this.#abandonExpectedReturn(questionId);
    }
  }

  #abortResponsePumpReadIfIdle(): void {
    if (this.#hasPendingReturnWaiters()) return;
    this.#responsePumpAbort?.abort();
  }

  #ensureResponsePump(): void {
    if (this.#responsePump) return;
    this.#responsePump = this.#pumpResponses()
      .catch((_error) => {
        // Individual waiters receive transport/decode failures directly.
      })
      .finally(() => {
        this.#responsePump = null;
        if (this.#hasPendingReturnWaiters()) {
          this.#ensureResponsePump();
        }
      });
  }

  async #pumpResponses(): Promise<void> {
    while (this.#hasPendingReturnWaiters()) {
      const abortController = new AbortController();
      this.#responsePumpAbort = abortController;
      let outbound: Uint8Array;
      try {
        outbound = await this.transport.nextOutboundFrame({
          signal: abortController.signal,
        });
      } catch (error) {
        if (
          abortController.signal.aborted && !this.#hasPendingReturnWaiters()
        ) {
          return;
        }
        this.#rejectAllPendingReturns(error);
        return;
      } finally {
        if (this.#responsePumpAbort === abortController) {
          this.#responsePumpAbort = null;
        }
      }

      let decoded: RpcReturnMessage;
      try {
        decoded = decodeReturnFrame(outbound);
      } catch {
        continue;
      }

      if (!this.#expectedReturns.has(decoded.answerId)) {
        // Ignore stale/forged returns for unknown or already-finished questions.
        continue;
      }
      if (!this.#resolvePendingReturn(decoded)) {
        this.#queueReturn(decoded);
      }
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
