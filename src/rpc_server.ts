import type { WasmHostCallRecord } from "./abi.ts";
import { ProtocolError } from "./errors.ts";
import {
  decodeCallRequestFrame,
  decodeFinishFrame,
  decodeReleaseFrame,
  decodeRpcMessageTag,
  EMPTY_STRUCT_MESSAGE,
  encodeReturnExceptionFrame,
  encodeReturnResultsFrame,
  RPC_CALL_TARGET_TAG_IMPORTED_CAP,
  RPC_CALL_TARGET_TAG_PROMISED_ANSWER,
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_FINISH,
  RPC_MESSAGE_TAG_RELEASE,
  RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD,
  type RpcCallRequest,
  type RpcCallTarget,
  type RpcCapDescriptor,
  type RpcFinishRequest,
  type RpcPromisedAnswerOp,
} from "./rpc_wire.ts";

/** A pointer to a capability identified by its export table index. */
export interface CapabilityPointer {
  /** The capability's index in the export/import table. */
  capabilityIndex: number;
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
  readonly methodOrdinal: number;
  /** The question ID for this call. */
  readonly questionId: number;
  /** The Cap'n Proto interface ID. */
  readonly interfaceId: bigint;
  /** Capability descriptors from the call's parameter payload. */
  readonly paramsCapTable: RpcCapDescriptor[];
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
   * Handles an incoming RPC call.
   *
   * @param methodOrdinal - The method number within the interface.
   * @param params - The serialized parameter content.
   * @param ctx - Full call context including capability and question info.
   * @returns The response bytes or a full response object.
   */
  dispatch(
    methodOrdinal: number,
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
  let pointerIndex = 0;
  for (const op of ops) {
    if (op.tag === RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD) {
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
  /** Answer table: maps question IDs to their dispatch promises/outcomes */
  #answerTable = new Map<number, AnswerTableEntry>();

  constructor(options: RpcServerBridgeOptions = {}) {
    this.#nextCapabilityIndex = options.nextCapabilityIndex ?? 0;
    this.#onUnhandledError = options.onUnhandledError;
    this.#onFinish = options.onFinish;
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
    const tag = decodeRpcMessageTag(frame);

    if (tag === RPC_MESSAGE_TAG_RELEASE) {
      const release = decodeReleaseFrame(frame);
      this.releaseCapability(release.id, release.referenceCount);
      return null;
    }

    if (tag === RPC_MESSAGE_TAG_FINISH) {
      const finish = decodeFinishFrame(frame);
      // Clean up the answer table entry for this question.
      this.#answerTable.delete(finish.questionId);
      if (this.#onFinish) {
        await this.#onFinish(finish);
      }
      return null;
    }

    if (tag !== RPC_MESSAGE_TAG_CALL) {
      throw new ProtocolError(
        `unsupported rpc message tag for server bridge: ${tag}`,
      );
    }

    return await this.#handleCall(decodeCallRequestFrame(frame));
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

  async #handleCall(call: RpcCallRequest): Promise<Uint8Array> {
    // Register this question in the answer table before dispatching,
    // so that pipelined calls targeting this question can find it.
    let resolveEntry!: (outcome: RpcDispatchOutcome) => void;
    const entry: AnswerTableEntry = {
      promise: new Promise<RpcDispatchOutcome>((resolve) => {
        resolveEntry = resolve;
      }),
    };
    this.#answerTable.set(call.questionId, entry);

    const outcome = await this.#dispatchCall(call);

    // Store the resolved outcome and resolve the promise.
    (entry as { outcome?: RpcDispatchOutcome }).outcome = outcome;
    resolveEntry(outcome);

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

    const outcome = await this.#dispatchCall(call);
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

  async #dispatchCall(call: RpcCallRequest): Promise<RpcDispatchOutcome> {
    // Handle promisedAnswer targets (Level 2 RPC / promise pipelining).
    if (call.target.tag === RPC_CALL_TARGET_TAG_PROMISED_ANSWER) {
      return await this.#dispatchPipelinedCall(call);
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
    return await this.#dispatchToCapability(capabilityIndex, call);
  }

  /**
   * Handle a pipelined call that targets a promisedAnswer.
   * This waits for the referenced question to complete, resolves the
   * capability from the result's cap table using the transform, then
   * dispatches the call to that capability.
   */
  async #dispatchPipelinedCall(
    call: RpcCallRequest,
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
    return await this.#dispatchToCapability(capabilityIndex, call);
  }

  /**
   * Dispatch a call to a specific capability index.
   * Shared by both direct (importedCap) and pipelined (promisedAnswer) paths.
   */
  async #dispatchToCapability(
    capabilityIndex: number,
    call: RpcCallRequest,
  ): Promise<RpcDispatchOutcome> {
    const registered = this.#dispatchByCapability.get(capabilityIndex);
    if (!registered) {
      return {
        kind: "exception",
        reason: `unknown capability index: ${capabilityIndex}`,
      };
    }

    if (registered.dispatch.interfaceId !== call.interfaceId) {
      return {
        kind: "exception",
        reason:
          `interface mismatch for capability ${capabilityIndex}: expected ${registered.dispatch.interfaceId.toString()} got ${call.interfaceId.toString()}`,
      };
    }

    const ctx: RpcCallContext = {
      target: call.target,
      capability: { capabilityIndex },
      methodOrdinal: call.methodId,
      questionId: call.questionId,
      interfaceId: call.interfaceId,
      paramsCapTable: call.paramsCapTable.map((entry) => ({
        tag: entry.tag,
        id: entry.id,
      })),
    };

    try {
      const response = normalizeCallResponse(
        await registered.dispatch.dispatch(
          call.methodId,
          call.paramsContent,
          ctx,
        ),
      );
      return { kind: "results", response };
    } catch (error) {
      if (this.#onUnhandledError) {
        await this.#onUnhandledError(error, call);
      }
      const reason = error instanceof Error ? error.message : String(error);
      return { kind: "exception", reason };
    }
  }
}
