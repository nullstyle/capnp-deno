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
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_FINISH,
  RPC_MESSAGE_TAG_RELEASE,
  type RpcCallRequest,
  type RpcCallTarget,
  type RpcCapDescriptor,
  type RpcFinishRequest,
} from "./rpc_wire.ts";

export interface CapabilityPointer {
  capabilityIndex: number;
}

export interface RpcCallContext {
  readonly target: RpcCallTarget;
  readonly capability: CapabilityPointer;
  readonly methodOrdinal: number;
  readonly questionId: number;
  readonly interfaceId: bigint;
  readonly paramsCapTable: RpcCapDescriptor[];
}

export interface RpcCallResponse {
  readonly content?: Uint8Array;
  readonly capTable?: RpcCapDescriptor[];
  readonly releaseParamCaps?: boolean;
  readonly noFinishNeeded?: boolean;
}

export interface RpcServerDispatch {
  readonly interfaceId: bigint;
  dispatch(
    methodOrdinal: number,
    params: Uint8Array,
    ctx: RpcCallContext,
  ): Promise<Uint8Array | RpcCallResponse> | Uint8Array | RpcCallResponse;
}

export interface RpcServerBridgeOptions {
  nextCapabilityIndex?: number;
  onUnhandledError?: (
    error: unknown,
    call: RpcCallRequest,
  ) => void | Promise<void>;
  onFinish?: (finish: RpcFinishRequest) => void | Promise<void>;
}

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

export interface RpcServerBridgePumpHostCallsOptions {
  maxCalls?: number;
}

interface RegisteredDispatch {
  readonly dispatch: RpcServerDispatch;
  refCount: number;
}

type RpcDispatchOutcome =
  | { kind: "results"; response: RpcCallResponse }
  | { kind: "exception"; reason: string };

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

export class RpcServerBridge {
  #nextCapabilityIndex: number;
  #dispatchByCapability = new Map<number, RegisteredDispatch>();
  #onUnhandledError?: RpcServerBridgeOptions["onUnhandledError"];
  #onFinish?: RpcServerBridgeOptions["onFinish"];

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

  async handleFrame(frame: Uint8Array): Promise<Uint8Array | null> {
    const tag = decodeRpcMessageTag(frame);

    if (tag === RPC_MESSAGE_TAG_RELEASE) {
      const release = decodeReleaseFrame(frame);
      this.releaseCapability(release.id, release.referenceCount);
      return null;
    }

    if (tag === RPC_MESSAGE_TAG_FINISH) {
      const finish = decodeFinishFrame(frame);
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
    const outcome = await this.#dispatchCall(call);
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
    if (call.target.tag !== RPC_CALL_TARGET_TAG_IMPORTED_CAP) {
      return {
        kind: "exception",
        reason:
          "server bridge does not support promisedAnswer call targets yet",
      };
    }

    const capabilityIndex = call.target.importedCap;
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
