/**
 * Cap'n Proto RPC server bridge.
 *
 * Decodes inbound RPC frames, dispatches calls to registered capability
 * handlers via {@link RpcServerBridge}, manages the answer table for
 * promise pipelining, and encodes return/exception frames.
 *
 * @module
 */

import type { WasmHostCallRecord } from "../../wasm/abi.ts";
import { ProtocolError } from "../../errors.ts";
import {
  emitObservabilityEvent,
  type RpcObservability,
} from "../../observability/observability.ts";
import {
  decodeBootstrapRequestFrame,
  decodeCallRequestFrame,
  decodeFinishFrame,
  decodeReleaseFrame,
  decodeRpcMessageTag,
  EMPTY_STRUCT_MESSAGE,
  encodeBootstrapResponseFrame,
  encodeReturnExceptionFrame,
  encodeReturnResultsFrame,
  RPC_CALL_TARGET_TAG_IMPORTED_CAP,
  RPC_CALL_TARGET_TAG_PROMISED_ANSWER,
  RPC_MESSAGE_TAG_BOOTSTRAP,
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_DISEMBARGO,
  RPC_MESSAGE_TAG_FINISH,
  RPC_MESSAGE_TAG_RELEASE,
  RPC_MESSAGE_TAG_RESOLVE,
  RPC_MESSAGE_TAG_RETURN,
  RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD,
  type RpcCallRequest,
  type RpcCallTarget,
  type RpcCapDescriptor,
  type RpcFinishRequest,
  type RpcPromisedAnswerOp,
} from "../wire.ts";

/** A pointer to a capability identified by its export table index. */
export interface CapabilityPointer {
  /** The capability's index in the export/import table. */
  capabilityIndex: number;
}

/**
 * Context object passed to server middleware hooks.
 *
 * Contains metadata about the current dispatch and a mutable `state` map
 * that middleware can use to pass data to later hooks or downstream middleware.
 */
export interface ServerMiddlewareContext {
  /** The question ID of the incoming call. */
  readonly questionId: number;
  /** The Cap'n Proto interface ID. */
  readonly interfaceId: bigint;
  /** The method ordinal within the interface. */
  readonly methodId: number;
  /** The capability index being called. */
  readonly capabilityIndex: number;
  /**
   * Mutable key-value map that middleware can use to pass data between hooks
   * and to downstream middleware in the chain.
   */
  readonly state: Map<string, unknown>;
}

/**
 * Result of a server middleware `onIncomingFrame` hook.
 * Return the (possibly transformed) frame to continue processing,
 * or `null` to silently drop the frame.
 */
export type ServerMiddlewareFrameResult = Uint8Array | null;

/**
 * Result of a server middleware `onDispatch` hook.
 * Return the (possibly transformed) params to continue processing,
 * or `null` to skip further dispatch (returning an empty result).
 */
export type ServerMiddlewareDispatchResult = Uint8Array | null;

/**
 * Interceptor that can inspect and transform server-side RPC dispatch at
 * various lifecycle stages. Implement one or more hooks to add cross-cutting
 * behavior such as logging, authentication, metrics, or rate limiting.
 *
 * All hooks are optional. Both sync and async returns are supported.
 *
 * Middleware hooks:
 * - `onIncomingFrame`: Called for every inbound frame before dispatch routing.
 * - `onDispatch`: Called after the target capability is resolved but before
 *   the dispatch handler runs.
 * - `onResponse`: Called after the dispatch handler returns successfully.
 * - `onError`: Called when a dispatch handler throws or an error occurs
 *   during dispatch processing.
 *
 * @example
 * ```ts
 * const logger: RpcServerMiddleware = {
 *   onDispatch(method, params, ctx) {
 *     console.log(`dispatch method=${method} iface=${ctx.interfaceId}`);
 *     return params;
 *   },
 *   onResponse(result, ctx) {
 *     console.log(`response for question=${ctx.questionId}`);
 *     return result;
 *   },
 * };
 * const bridge = new RpcServerBridge({ middleware: [logger] });
 * ```
 */
export interface RpcServerMiddleware {
  /**
   * Called for every inbound frame before dispatch routing.
   *
   * @param frame - The raw inbound frame bytes.
   * @param context - Partial context (only `state` is available at this stage).
   * @returns The frame to continue processing, or `null` to drop it.
   */
  onIncomingFrame?: (
    frame: Uint8Array,
    context: Pick<ServerMiddlewareContext, "state">,
  ) =>
    | ServerMiddlewareFrameResult
    | Promise<ServerMiddlewareFrameResult>;

  /**
   * Called after the target capability is resolved, before the dispatch
   * handler runs.
   *
   * @param method - The method ordinal being called.
   * @param params - The serialized parameter bytes.
   * @param context - Full dispatch context.
   * @returns The params to pass to the handler, or `null` to skip dispatch.
   */
  onDispatch?: (
    method: number,
    params: Uint8Array,
    context: ServerMiddlewareContext,
  ) =>
    | ServerMiddlewareDispatchResult
    | Promise<ServerMiddlewareDispatchResult>;

  /**
   * Called after the dispatch handler returns successfully.
   *
   * @param result - The dispatch outcome.
   * @param context - Full dispatch context.
   * @returns The (possibly transformed) result to send back.
   */
  onResponse?: (
    result: RpcCallResponse,
    context: ServerMiddlewareContext,
  ) => RpcCallResponse | Promise<RpcCallResponse>;

  /**
   * Called when a dispatch handler throws or an error occurs during
   * dispatch processing.
   *
   * @param error - The error that occurred.
   * @param context - Full dispatch context (may be partial if the error
   *   occurred before full context was available).
   * @returns void -- the error is still propagated after all middleware runs.
   */
  onError?: (
    error: unknown,
    context:
      & Partial<ServerMiddlewareContext>
      & Pick<ServerMiddlewareContext, "state">,
  ) => void | Promise<void>;
}

/**
 * Context provided to server dispatch handlers for each incoming RPC call.
 *
 * Contains the full call metadata including target, capability, method,
 * question ID, interface ID, and the parameters capability table.
 */
export interface RpcCallContext {
  /** The call target (imported cap or promised answer). */
  readonly target: RpcCallTarget;
  /** The capability being called. */
  readonly capability: CapabilityPointer;
  /** The method ordinal within the interface. */
  readonly methodId: number;
  /** The question ID for this call. */
  readonly questionId: number;
  /** The Cap'n Proto interface ID. */
  readonly interfaceId: bigint;
  /** Capability descriptors from the call's parameter payload. */
  readonly paramsCapTable: RpcCapDescriptor[];
  /**
   * Optional outbound client for invoking callbacks on inbound capabilities.
   */
  readonly outboundClient?: {
    call(
      capability: CapabilityPointer,
      methodId: number,
      params: Uint8Array,
      options?: unknown,
    ): Promise<Uint8Array>;
    callRaw?(
      capability: CapabilityPointer,
      methodId: number,
      params: Uint8Array,
      options?: unknown,
    ): Promise<{ contentBytes: Uint8Array; capTable: RpcCapDescriptor[] }>;
    finish?(questionId: number, options?: unknown): Promise<void> | void;
    release?(
      capability: CapabilityPointer,
      referenceCount?: number,
    ): Promise<void> | void;
  };
  /**
   * Optional export hook for returning local capability implementations.
   */
  readonly exportCapability?: (
    dispatch: RpcServerDispatch,
    options?: { capabilityIndex?: number; referenceCount?: number },
  ) => CapabilityPointer;
}

/**
 * Response returned by an {@link RpcServerDispatch} handler.
 *
 * Can be a simple `Uint8Array` (treated as content-only) or a full response
 * object with capability table and return flags.
 */
export interface RpcCallResponse {
  /** The serialized result content (Cap'n Proto message). */
  readonly content?: Uint8Array;
  /** Capability descriptors to include in the response. */
  readonly capTable?: RpcCapDescriptor[];
  /** Whether to release parameter capabilities. Defaults to true. */
  readonly releaseParamCaps?: boolean;
  /** Whether a Finish message is unnecessary. Defaults to false. */
  readonly noFinishNeeded?: boolean;
}

/**
 * Interface for server-side RPC dispatch handlers.
 *
 * Implement this interface for each Cap'n Proto interface you want to serve.
 * Register implementations with {@link RpcServerBridge.exportCapability}.
 */
export interface RpcServerDispatch {
  /** The Cap'n Proto interface ID this dispatch handles. */
  readonly interfaceId: bigint;
  /**
   * Optional list of interface IDs accepted by this dispatch. When provided,
   * incoming calls are accepted if their `interfaceId` matches any entry.
   * Useful for generated interface-inheritance stubs where one capability can
   * be called through parent interface IDs.
   */
  readonly interfaceIds?: readonly bigint[];
  /**
   * Handles an incoming RPC call.
   *
   * @param methodId - The method number within the interface.
   * @param params - The serialized parameter content.
   * @param ctx - Full call context including capability and question info.
   * @returns The response bytes or a full response object.
   */
  dispatch(
    methodId: number,
    params: Uint8Array,
    ctx: RpcCallContext,
  ): Promise<Uint8Array | RpcCallResponse> | Uint8Array | RpcCallResponse;
}

/**
 * Options for configuring an {@link RpcServerBridge}.
 */
export interface RpcServerBridgeOptions {
  nextCapabilityIndex?: number;
  onUnhandledError?: (
    error: unknown,
    call: RpcCallRequest,
  ) => void | Promise<void>;
  onFinish?: (finish: RpcFinishRequest) => void | Promise<void>;
  /**
   * Maximum number of entries allowed in the answer table.
   * When the limit is reached, new calls are rejected with an exception.
   * Defaults to 4096. Set to 0 or Infinity to disable.
   */
  maxAnswerTableSize?: number;
  /**
   * Timeout in milliseconds after which a completed answer table entry
   * (one whose dispatch has resolved) is automatically evicted if the
   * peer has not sent a Finish message. Defaults to Infinity (disabled).
   * Set to a positive finite number to enable automatic eviction.
   */
  answerEvictionTimeoutMs?: number;
  /**
   * Maximum number of times to retry evicting an answer table entry
   * when pipelineRefCount > 0. After this limit is reached, the entry
   * is force-evicted and a warning is reported via onUnhandledError.
   * Defaults to 10. Set to 0 or Infinity to disable the limit.
   */
  maxEvictionRetries?: number;
  /**
   * Callback invoked when a Bootstrap request is received. Return the
   * capability index that should be sent back to the client.
   *
   * If not provided, bootstrap frames will throw a {@link ProtocolError}.
   */
  onBootstrap?: (
    request: { questionId: number },
  ) => { capabilityIndex: number } | Promise<{ capabilityIndex: number }>;
  /**
   * Optional array of server-side middleware interceptors. Middleware
   * hooks are executed in array order for all hooks: `onIncomingFrame`,
   * `onDispatch`, `onResponse`, and `onError`.
   */
  middleware?: RpcServerMiddleware[];
  /**
   * Optional observability hook for emitting diagnostic events from the
   * server bridge, such as middleware errors that would otherwise be
   * silently swallowed.
   */
  observability?: RpcObservability;
}

/**
 * Abstraction over the WASM peer's host-call bridge used by {@link RpcServerBridge}
 * to pump and respond to host calls.
 */
export interface RpcServerWasmHost {
  readonly handle: number;
  readonly abi: {
    supportsHostCallReturnFrame?: boolean;
    popHostCall(peer: number): WasmHostCallRecord | null;
    respondHostCallReturnFrame?(
      peer: number,
      returnFrame: Uint8Array,
    ): void;
    respondHostCallResults(
      peer: number,
      questionId: number,
      payloadFrame: Uint8Array,
    ): void;
    respondHostCallException(
      peer: number,
      questionId: number,
      reason: string | Uint8Array,
    ): void;
  };
}

/**
 * Options for {@link RpcServerBridge.pumpWasmHostCalls}.
 */
export interface RpcServerBridgePumpHostCallsOptions {
  /** Maximum number of host calls to process in this pump cycle. */
  maxCalls?: number;
}

interface RegisteredDispatch {
  readonly dispatch: RpcServerDispatch;
  refCount: number;
}

type RpcDispatchOutcome =
  | { kind: "results"; response: RpcCallResponse }
  | { kind: "exception"; reason: string };

/**
 * An entry in the answer table, tracking an in-flight or completed question.
 * Used for promise pipelining: when a pipelined call targets a promisedAnswer,
 * we look up the referenced question here to find the capability to dispatch to.
 */
interface AnswerTableEntry {
  /** Promise that resolves when the dispatch completes */
  readonly promise: Promise<RpcDispatchOutcome>;
  /** Resolved outcome, set once the promise settles */
  outcome?: RpcDispatchOutcome;
  /** Timer handle for automatic eviction of completed but unfinished entries */
  evictionTimer?: ReturnType<typeof setTimeout>;
  /**
   * Number of in-flight pipelined calls currently dispatching against this
   * entry. Eviction is deferred while this count is greater than zero.
   */
  pipelineRefCount: number;
  /**
   * Number of times eviction has been attempted for this entry.
   * Incremented each time eviction is deferred due to pipelineRefCount > 0.
   */
  evictionAttempts: number;
}

function normalizeCapability(
  capability: number | CapabilityPointer,
): number {
  if (typeof capability === "number") {
    return capability;
  }
  return capability.capabilityIndex;
}

function normalizeCallResponse(
  value: Uint8Array | RpcCallResponse,
): RpcCallResponse {
  if (value instanceof Uint8Array) {
    return { content: value };
  }
  return value;
}

/**
 * Resolve a promisedAnswer target to a capability index by looking up
 * the answer table entry and applying the transform operations.
 *
 * In the Cap'n Proto RPC protocol, a promisedAnswer target says:
 * "take the result of question N, then follow these pointer fields
 *  to find the capability I want to call."
 *
 * The transform is a sequence of PromisedAnswer.Op entries. Each
 * getPointerField(n) operation selects the n-th capability from the
 * cap table. For the common case (no transform or empty transform),
 * we use capTable[0].id as the capability index.
 */
function resolvePromisedAnswerCapability(
  outcome: RpcDispatchOutcome,
  transform: RpcPromisedAnswerOp[] | undefined,
): number {
  if (outcome.kind === "exception") {
    throw new ProtocolError(
      `promisedAnswer target question resolved with exception: ${outcome.reason}`,
    );
  }

  const capTable = outcome.response.capTable ?? [];
  const ops = transform ?? [];

  // If no transform, use the first capability in the cap table.
  if (ops.length === 0) {
    if (capTable.length === 0) {
      throw new ProtocolError(
        "promisedAnswer target resolved but result has no capabilities in cap table",
      );
    }
    return capTable[0].id;
  }

  // Apply getPointerField operations to select the capability.
  //
  // In full Cap'n Proto RPC, transform operations compose: each
  // getPointerField(n) navigates one level deeper into a nested
  // capability structure.  However, this implementation resolves
  // capabilities through a flat export table, so only a single
  // getPointerField step is meaningful.  To avoid silently
  // discarding earlier steps (which would be a correctness bug),
  // we reject multi-step transforms with an explicit error.
  //
  // To support full multi-step transforms, the resolution logic
  // would need to deserialize the result struct and walk nested
  // pointer fields, resolving intermediate capabilities at each
  // level -- essentially implementing Cap'n Proto struct traversal.
  let pointerIndex = 0;
  let getPointerFieldCount = 0;
  for (const op of ops) {
    if (op.tag === RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD) {
      getPointerFieldCount += 1;
      if (getPointerFieldCount > 1) {
        throw new ProtocolError(
          "multi-step promisedAnswer transforms (multiple getPointerField operations) are not yet supported; " +
            `got ${
              ops.filter((o) =>
                o.tag === RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD
              ).length
            } getPointerField steps`,
        );
      }
      pointerIndex = op.pointerIndex ?? 0;
    }
    // noop ops are simply skipped
  }

  if (pointerIndex >= capTable.length) {
    throw new ProtocolError(
      `promisedAnswer transform getPointerField(${pointerIndex}) is out of range; cap table has ${capTable.length} entries`,
    );
  }

  return capTable[pointerIndex].id;
}

/**
 * Server-side bridge that dispatches incoming RPC calls to registered
 * capability handlers.
 *
 * The bridge maintains a registry of exported capabilities (each associated
 * with an {@link RpcServerDispatch} handler) and routes incoming Call, Release,
 * and Finish messages to the appropriate handler.
 *
 * It can also pump host calls from a WASM peer via {@link pumpWasmHostCalls}.
 *
 * @example
 * ```ts
 * const bridge = new RpcServerBridge();
 * const cap = bridge.exportCapability(myDispatch);
 * // cap.capabilityIndex is now registered and will receive calls
 * ```
 */
export class RpcServerBridge {
  #nextCapabilityIndex: number;
  #dispatchByCapability = new Map<number, RegisteredDispatch>();
  #onUnhandledError?: RpcServerBridgeOptions["onUnhandledError"];
  #onFinish?: RpcServerBridgeOptions["onFinish"];
  #onBootstrap?: RpcServerBridgeOptions["onBootstrap"];
  /** Answer table: maps question IDs to their dispatch promises/outcomes */
  #answerTable = new Map<number, AnswerTableEntry>();
  #maxAnswerTableSize: number;
  #answerEvictionTimeoutMs: number;
  #maxEvictionRetries: number;
  #middleware: readonly RpcServerMiddleware[];
  #observability: RpcObservability | undefined;
  #outboundClient: RpcCallContext["outboundClient"];

  constructor(options: RpcServerBridgeOptions = {}) {
    this.#nextCapabilityIndex = options.nextCapabilityIndex ?? 0;
    this.#onUnhandledError = options.onUnhandledError;
    this.#onFinish = options.onFinish;
    this.#onBootstrap = options.onBootstrap;
    this.#maxAnswerTableSize = options.maxAnswerTableSize ?? 4096;
    this.#answerEvictionTimeoutMs = options.answerEvictionTimeoutMs ?? Infinity;
    this.#maxEvictionRetries = options.maxEvictionRetries ?? 10;
    this.#middleware = options.middleware ? [...options.middleware] : [];
    this.#observability = options.observability;
    this.#outboundClient = undefined;
  }

  setOutboundClient(outboundClient: RpcCallContext["outboundClient"]): void {
    this.#outboundClient = outboundClient;
  }

  exportCapability(
    dispatch: RpcServerDispatch,
    options: { capabilityIndex?: number; referenceCount?: number } = {},
  ): CapabilityPointer {
    const capabilityIndex = options.capabilityIndex ??
      this.#nextCapabilityIndex;
    if (options.capabilityIndex === undefined) {
      this.#nextCapabilityIndex = capabilityIndex + 1;
    }
    if (this.#dispatchByCapability.has(capabilityIndex)) {
      throw new ProtocolError(
        `capability ${capabilityIndex} already has a registered server dispatch`,
      );
    }

    const referenceCount = options.referenceCount ?? 1;
    if (!Number.isInteger(referenceCount) || referenceCount <= 0) {
      throw new ProtocolError(
        `referenceCount must be a positive integer, got ${referenceCount}`,
      );
    }

    this.#dispatchByCapability.set(capabilityIndex, {
      dispatch,
      refCount: referenceCount,
    });
    return { capabilityIndex };
  }

  retainCapability(
    capability: number | CapabilityPointer,
    referenceCount = 1,
  ): void {
    if (!Number.isInteger(referenceCount) || referenceCount <= 0) {
      throw new ProtocolError(
        `referenceCount must be a positive integer, got ${referenceCount}`,
      );
    }

    const capabilityIndex = normalizeCapability(capability);
    const registered = this.#dispatchByCapability.get(capabilityIndex);
    if (!registered) {
      throw new ProtocolError(`unknown capability ${capabilityIndex}`);
    }
    registered.refCount += referenceCount;
  }

  releaseCapability(
    capability: number | CapabilityPointer,
    referenceCount = 1,
  ): boolean {
    if (!Number.isInteger(referenceCount) || referenceCount <= 0) {
      throw new ProtocolError(
        `referenceCount must be a positive integer, got ${referenceCount}`,
      );
    }

    const capabilityIndex = normalizeCapability(capability);
    const registered = this.#dispatchByCapability.get(capabilityIndex);
    if (!registered) {
      return false;
    }

    if (referenceCount > registered.refCount) {
      throw new ProtocolError(
        `release referenceCount ${referenceCount} exceeds current refCount ${registered.refCount} for capability ${capabilityIndex}`,
      );
    }

    registered.refCount -= referenceCount;
    if (registered.refCount <= 0) {
      this.#dispatchByCapability.delete(capabilityIndex);
      return false;
    }
    return true;
  }

  hasCapability(capability: number | CapabilityPointer): boolean {
    return this.#dispatchByCapability.has(normalizeCapability(capability));
  }

  /**
   * Returns the number of entries currently in the answer table.
   * Useful for testing and debugging promise pipelining state.
   */
  get answerTableSize(): number {
    return this.#answerTable.size;
  }

  async handleFrame(frame: Uint8Array): Promise<Uint8Array | null> {
    // Run onIncomingFrame middleware chain.
    let currentFrame: Uint8Array | null = frame;
    const middlewareState = new Map<string, unknown>();
    for (const mw of this.#middleware) {
      if (currentFrame === null) break;
      if (mw.onIncomingFrame) {
        currentFrame = await mw.onIncomingFrame(currentFrame, {
          state: middlewareState,
        });
      }
    }
    if (currentFrame === null) return null;

    const tag = decodeRpcMessageTag(currentFrame);

    if (tag === RPC_MESSAGE_TAG_RELEASE) {
      const release = decodeReleaseFrame(currentFrame);
      this.releaseCapability(release.id, release.referenceCount);
      return null;
    }

    if (tag === RPC_MESSAGE_TAG_FINISH) {
      const finish = decodeFinishFrame(currentFrame);
      // Clean up the answer table entry for this question.
      const entry = this.#answerTable.get(finish.questionId);
      if (entry?.evictionTimer !== undefined) {
        clearTimeout(entry.evictionTimer);
      }
      this.#answerTable.delete(finish.questionId);
      if (this.#onFinish) {
        await this.#onFinish(finish);
      }
      return null;
    }

    // Return, Resolve, and Disembargo are handled by the WASM peer directly;
    // the bridge just passes them through without error.
    if (
      tag === RPC_MESSAGE_TAG_RETURN ||
      tag === RPC_MESSAGE_TAG_RESOLVE ||
      tag === RPC_MESSAGE_TAG_DISEMBARGO
    ) {
      return null;
    }

    if (tag === RPC_MESSAGE_TAG_BOOTSTRAP) {
      const bootstrap = decodeBootstrapRequestFrame(currentFrame);
      if (!this.#onBootstrap) {
        throw new ProtocolError(
          "bootstrap not configured \u2014 provide onBootstrap in RpcServerBridgeOptions",
        );
      }
      const result = await this.#onBootstrap({
        questionId: bootstrap.questionId,
      });
      return encodeBootstrapResponseFrame({
        answerId: bootstrap.questionId,
        capabilityIndex: result.capabilityIndex,
      });
    }

    if (tag !== RPC_MESSAGE_TAG_CALL) {
      throw new ProtocolError(
        `unsupported rpc message tag for server bridge: ${tag}`,
      );
    }

    return await this.#handleCall(
      decodeCallRequestFrame(currentFrame),
      middlewareState,
    );
  }

  async pumpWasmHostCalls(
    wasmHost: RpcServerWasmHost,
    options: RpcServerBridgePumpHostCallsOptions = {},
  ): Promise<number> {
    const maxCalls = options.maxCalls;
    if (
      maxCalls !== undefined &&
      (!Number.isInteger(maxCalls) || maxCalls <= 0)
    ) {
      throw new ProtocolError(
        `maxCalls must be a positive integer when provided, got ${
          String(maxCalls)
        }`,
      );
    }

    let handled = 0;
    while (maxCalls === undefined || handled < maxCalls) {
      const hostCall = wasmHost.abi.popHostCall(wasmHost.handle);
      if (!hostCall) break;
      await this.#handleWasmHostCall(wasmHost, hostCall);
      handled += 1;
    }
    return handled;
  }

  async #handleCall(
    call: RpcCallRequest,
    middlewareState?: Map<string, unknown>,
  ): Promise<Uint8Array> {
    // Enforce answer table size limit to prevent unbounded growth.
    if (
      this.#maxAnswerTableSize > 0 &&
      this.#maxAnswerTableSize !== Infinity &&
      this.#answerTable.size >= this.#maxAnswerTableSize
    ) {
      return encodeReturnExceptionFrame({
        answerId: call.questionId,
        reason:
          `answer table is full (${this.#maxAnswerTableSize} entries); cannot accept new questions`,
      });
    }

    // Register this question in the answer table before dispatching,
    // so that pipelined calls targeting this question can find it.
    let resolveEntry!: (outcome: RpcDispatchOutcome) => void;
    const entry: AnswerTableEntry = {
      promise: new Promise<RpcDispatchOutcome>((resolve) => {
        resolveEntry = resolve;
      }),
      pipelineRefCount: 0,
      evictionAttempts: 0,
    };
    this.#answerTable.set(call.questionId, entry);

    const outcome = await this.#dispatchCall(
      call,
      middlewareState ?? new Map<string, unknown>(),
    );

    // Store the resolved outcome and resolve the promise.
    (entry as { outcome?: RpcDispatchOutcome }).outcome = outcome;
    resolveEntry(outcome);

    // Schedule automatic eviction of completed entries that are not
    // finished by the peer within the configured timeout.
    this.#scheduleEviction(call.questionId, entry);

    if (outcome.kind === "exception") {
      return encodeReturnExceptionFrame({
        answerId: call.questionId,
        reason: outcome.reason,
      });
    }

    return encodeReturnResultsFrame({
      answerId: call.questionId,
      content: outcome.response.content,
      capTable: outcome.response.capTable,
      releaseParamCaps: outcome.response.releaseParamCaps,
      noFinishNeeded: outcome.response.noFinishNeeded,
    });
  }

  /**
   * Schedule automatic eviction of a completed answer table entry.
   * If the peer does not send a Finish within the configured timeout,
   * the entry is silently removed to prevent unbounded growth.
   *
   * If eviction is deferred due to pipelineRefCount > 0, the eviction
   * is rescheduled up to maxEvictionRetries times. After the limit is
   * reached, the entry is force-evicted and a warning is reported.
   */
  #scheduleEviction(questionId: number, entry: AnswerTableEntry): void {
    if (
      this.#answerEvictionTimeoutMs <= 0 ||
      this.#answerEvictionTimeoutMs === Infinity
    ) {
      return;
    }
    const timer = setTimeout(() => {
      // Only evict if the entry is still present (not already finished).
      if (this.#answerTable.get(questionId) !== entry) {
        return;
      }
      // Defer eviction while pipelined calls are in-flight.
      if (entry.pipelineRefCount > 0) {
        entry.evictionAttempts += 1;

        // Check if we've exceeded the maximum retry limit.
        if (
          this.#maxEvictionRetries > 0 &&
          this.#maxEvictionRetries !== Infinity &&
          entry.evictionAttempts > this.#maxEvictionRetries
        ) {
          // Force-evict the entry and report a warning.
          this.#answerTable.delete(questionId);
          if (this.#onUnhandledError) {
            const error = new Error(
              `Force-evicted answer table entry for question ${questionId} after ${entry.evictionAttempts} eviction attempts (pipelineRefCount=${entry.pipelineRefCount})`,
            );
            // Create a synthetic call request for the error handler.
            const syntheticCall: RpcCallRequest = {
              questionId,
              target: { tag: RPC_CALL_TARGET_TAG_IMPORTED_CAP, importedCap: 0 },
              interfaceId: 0n,
              methodId: 0,
              paramsContent: new Uint8Array(0),
              paramsCapTable: [],
            };
            // Fire and forget — don't await to avoid blocking the timer.
            // Wrap in try/catch so that a synchronous throw from
            // onUnhandledError is also caught, then .catch() handles
            // the async-rejection path.
            try {
              Promise.resolve(this.#onUnhandledError(error, syntheticCall))
                .catch((_handlerError) => {
                  // Error handler itself failed — nothing more we can do.
                  // The original error has already been reported above.
                });
            } catch (_handlerError) {
              // Error handler threw synchronously — nothing more we can do.
            }
          }
          return;
        }

        // Reschedule eviction since pipelineRefCount is still > 0.
        this.#scheduleEviction(questionId, entry);
        return;
      }
      this.#answerTable.delete(questionId);
    }, this.#answerEvictionTimeoutMs);
    // Unref the timer so it does not prevent the process from exiting
    // and does not trigger resource-leak sanitizers in test runners.
    if (typeof Deno !== "undefined" && typeof Deno.unrefTimer === "function") {
      Deno.unrefTimer(timer);
    } else if (
      typeof timer === "object" && timer !== null && "unref" in timer &&
      typeof (timer as { unref: unknown }).unref === "function"
    ) {
      (timer as { unref: () => void }).unref();
    }
    (entry as { evictionTimer?: ReturnType<typeof setTimeout> })
      .evictionTimer = timer;
  }

  async #handleWasmHostCall(
    wasmHost: RpcServerWasmHost,
    hostCall: WasmHostCallRecord,
  ): Promise<void> {
    let call: RpcCallRequest;
    try {
      call = decodeCallRequestFrame(hostCall.frame);
    } catch (error) {
      const reason = error instanceof Error
        ? error.message
        : `invalid host call frame: ${String(error)}`;
      wasmHost.abi.respondHostCallException(
        wasmHost.handle,
        hostCall.questionId,
        reason,
      );
      return;
    }

    if (call.questionId !== hostCall.questionId) {
      wasmHost.abi.respondHostCallException(
        wasmHost.handle,
        hostCall.questionId,
        `host call questionId mismatch: metadata=${hostCall.questionId} frame=${call.questionId}`,
      );
      return;
    }

    const outcome = await this.#dispatchCall(
      call,
      new Map<string, unknown>(),
    );
    if (outcome.kind === "exception") {
      wasmHost.abi.respondHostCallException(
        wasmHost.handle,
        call.questionId,
        outcome.reason,
      );
      return;
    }

    const response = outcome.response;
    const supportsReturnFrame = wasmHost.abi.supportsHostCallReturnFrame ??
      true;
    if (wasmHost.abi.respondHostCallReturnFrame && supportsReturnFrame) {
      wasmHost.abi.respondHostCallReturnFrame(
        wasmHost.handle,
        encodeReturnResultsFrame({
          answerId: call.questionId,
          content: response.content,
          capTable: response.capTable,
          releaseParamCaps: response.releaseParamCaps,
          noFinishNeeded: response.noFinishNeeded,
        }),
      );
      return;
    }

    if ((response.capTable?.length ?? 0) > 0) {
      wasmHost.abi.respondHostCallException(
        wasmHost.handle,
        call.questionId,
        "wasm host-call bridge does not support response cap tables yet",
      );
      return;
    }
    if (
      response.releaseParamCaps === false || response.noFinishNeeded === true
    ) {
      wasmHost.abi.respondHostCallException(
        wasmHost.handle,
        call.questionId,
        "wasm host-call bridge does not support non-default return flags yet",
      );
      return;
    }

    wasmHost.abi.respondHostCallResults(
      wasmHost.handle,
      call.questionId,
      response.content ?? new Uint8Array(EMPTY_STRUCT_MESSAGE),
    );
  }

  async #dispatchCall(
    call: RpcCallRequest,
    middlewareState: Map<string, unknown>,
  ): Promise<RpcDispatchOutcome> {
    // Handle promisedAnswer targets (Level 2 RPC / promise pipelining).
    if (call.target.tag === RPC_CALL_TARGET_TAG_PROMISED_ANSWER) {
      return await this.#dispatchPipelinedCall(call, middlewareState);
    }

    if (call.target.tag !== RPC_CALL_TARGET_TAG_IMPORTED_CAP) {
      return {
        kind: "exception",
        reason: `unsupported call target tag: ${
          (call.target as { tag: number }).tag
        }`,
      };
    }

    const capabilityIndex = call.target.importedCap;
    return await this.#dispatchToCapability(
      capabilityIndex,
      call,
      middlewareState,
    );
  }

  /**
   * Handle a pipelined call that targets a promisedAnswer.
   * This waits for the referenced question to complete, resolves the
   * capability from the result's cap table using the transform, then
   * dispatches the call to that capability.
   */
  async #dispatchPipelinedCall(
    call: RpcCallRequest,
    middlewareState: Map<string, unknown>,
  ): Promise<RpcDispatchOutcome> {
    if (call.target.tag !== RPC_CALL_TARGET_TAG_PROMISED_ANSWER) {
      return {
        kind: "exception",
        reason: "internal error: expected promisedAnswer target",
      };
    }

    const { questionId: targetQuestionId, transform } =
      call.target.promisedAnswer;

    // Look up the referenced question in the answer table.
    const answerEntry = this.#answerTable.get(targetQuestionId);
    if (!answerEntry) {
      return {
        kind: "exception",
        reason:
          `promisedAnswer references unknown question ${targetQuestionId}`,
      };
    }

    // Increment the pipeline ref count to prevent eviction while this
    // pipelined call is in-flight.
    answerEntry.pipelineRefCount += 1;
    try {
      // Wait for the referenced question to complete.
      let targetOutcome: RpcDispatchOutcome;
      if (answerEntry.outcome !== undefined) {
        targetOutcome = answerEntry.outcome;
      } else {
        targetOutcome = await answerEntry.promise;
      }

      // Resolve the capability index from the answer's result cap table.
      let capabilityIndex: number;
      try {
        capabilityIndex = resolvePromisedAnswerCapability(
          targetOutcome,
          transform,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { kind: "exception", reason };
      }

      // Dispatch to the resolved capability.
      return await this.#dispatchToCapability(
        capabilityIndex,
        call,
        middlewareState,
      );
    } finally {
      answerEntry.pipelineRefCount -= 1;
    }
  }

  /**
   * Dispatch a call to a specific capability index.
   * Shared by both direct (importedCap) and pipelined (promisedAnswer) paths.
   */
  async #dispatchToCapability(
    capabilityIndex: number,
    call: RpcCallRequest,
    middlewareState: Map<string, unknown>,
  ): Promise<RpcDispatchOutcome> {
    const registered = this.#dispatchByCapability.get(capabilityIndex);
    if (!registered) {
      return {
        kind: "exception",
        reason: `unknown capability index: ${capabilityIndex}`,
      };
    }

    const acceptedInterfaceIds = registered.dispatch.interfaceIds;
    const interfaceAccepted = acceptedInterfaceIds
      ? acceptedInterfaceIds.includes(call.interfaceId)
      : (registered.dispatch.interfaceId === call.interfaceId);
    if (!interfaceAccepted) {
      const expected = acceptedInterfaceIds?.length
        ? acceptedInterfaceIds.map((id) => id.toString()).join(",")
        : registered.dispatch.interfaceId.toString();
      return {
        kind: "exception",
        reason:
          `interface mismatch for capability ${capabilityIndex}: expected ${expected} got ${call.interfaceId.toString()}`,
      };
    }

    const mwCtx: ServerMiddlewareContext = {
      questionId: call.questionId,
      interfaceId: call.interfaceId,
      methodId: call.methodId,
      capabilityIndex,
      state: middlewareState,
    };

    const ctx: RpcCallContext = {
      target: call.target,
      capability: { capabilityIndex },
      methodId: call.methodId,
      questionId: call.questionId,
      interfaceId: call.interfaceId,
      paramsCapTable: call.paramsCapTable.map((entry) => ({
        tag: entry.tag,
        id: entry.id,
      })),
      outboundClient: this.#outboundClient,
      exportCapability: (dispatch, options) =>
        this.exportCapability(dispatch, options),
    };

    try {
      // Run onDispatch middleware chain.
      let currentParams: Uint8Array | null = call.paramsContent;
      for (const mw of this.#middleware) {
        if (currentParams === null) break;
        if (mw.onDispatch) {
          currentParams = await mw.onDispatch(
            call.methodId,
            currentParams,
            mwCtx,
          );
        }
      }

      if (currentParams === null) {
        // Middleware dropped the dispatch; return an empty result.
        const emptyResponse: RpcCallResponse = {};
        return { kind: "results", response: emptyResponse };
      }

      let response = normalizeCallResponse(
        await registered.dispatch.dispatch(
          call.methodId,
          currentParams,
          ctx,
        ),
      );

      // Run onResponse middleware chain.
      for (const mw of this.#middleware) {
        if (mw.onResponse) {
          response = await mw.onResponse(response, mwCtx);
        }
      }

      return { kind: "results", response };
    } catch (error) {
      // Run onError middleware chain.
      for (const mw of this.#middleware) {
        if (mw.onError) {
          try {
            await mw.onError(error, mwCtx);
          } catch (mwError) {
            // Errors from onError middleware are swallowed to avoid
            // masking the original dispatch error, but reported via
            // observability so they are not completely invisible.
            emitObservabilityEvent(this.#observability, {
              name: "rpc.server.middleware_error",
              error: mwError,
              attributes: {
                "rpc.question_id": mwCtx.questionId,
                "rpc.interface_id": mwCtx.interfaceId,
                "rpc.method_id": mwCtx.methodId,
              },
            });
          }
        }
      }

      if (this.#onUnhandledError) {
        try {
          await this.#onUnhandledError(error, call);
        } catch (_handlerError) {
          // Error handler itself failed — nothing more we can do.
          // The original error has already been handled/logged by the caller.
        }
      }
      const reason = error instanceof Error ? error.message : String(error);
      return { kind: "exception", reason };
    }
  }
}
