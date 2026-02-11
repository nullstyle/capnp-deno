/**
 * RPC runtime contracts shared by generated `*_rpc.ts` modules.
 *
 * @module
 */

import type {
  CapabilityPointer,
  PreambleCapDescriptor,
} from "../encoding/runtime.ts";

export interface RpcFinishOptions {
  releaseResultCaps?: boolean;
  requireEarlyCancellation?: boolean;
}

/**
 * Shared RPC call options used by generated client stubs.
 */
export interface RpcCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  interfaceId?: bigint;
  onQuestionId?: (questionId: number) => void;
  autoFinish?: boolean;
  finish?: RpcFinishOptions;
  paramsCapTable?: PreambleCapDescriptor[];
}

/**
 * Shared RPC call context passed to generated server handlers.
 */
export interface RpcCallContext {
  readonly capability: CapabilityPointer;
  readonly methodId: number;
  readonly questionId?: number;
  readonly interfaceId?: bigint;
  readonly paramsCapTable?: PreambleCapDescriptor[];
  /**
   * Optional outbound client bound to the current call context.
   *
   * When present, generated adapters can invoke callbacks on capabilities
   * received in params.
   */
  readonly outboundClient?: RpcClientTransport;
  /**
   * Optional export hook bound to the current call context.
   *
   * When present, generated adapters can export local capability results.
   */
  readonly exportCapability?: (
    dispatch: RpcServerDispatch,
    options?: RpcExportCapabilityOptions,
  ) => CapabilityPointer;
}

/**
 * Shared transport contract used by generated RPC clients.
 */
export interface RpcClientTransport {
  call(
    capability: CapabilityPointer,
    methodId: number,
    params: Uint8Array,
    options?: RpcCallOptions,
  ): Promise<Uint8Array>;
  callRaw?(
    capability: CapabilityPointer,
    methodId: number,
    params: Uint8Array,
    options?: RpcCallOptions,
  ): Promise<{ contentBytes: Uint8Array; capTable: PreambleCapDescriptor[] }>;
  finish?(questionId: number, options?: RpcFinishOptions): Promise<void> | void;
  release?(
    capability: CapabilityPointer,
    referenceCount?: number,
  ): Promise<void> | void;
  /**
   * Optional capability-export hook used by high-level generated adapters
   * when users pass local callback implementations as arguments.
   */
  exportCapability?(
    dispatch: RpcServerDispatch,
    options?: RpcExportCapabilityOptions,
  ): CapabilityPointer;
}

/**
 * Shared generated server dispatch return type.
 */
export type RpcServerDispatchResult =
  | Uint8Array
  | { content: Uint8Array; capTable?: PreambleCapDescriptor[] };

/**
 * Shared generated server dispatch contract.
 */
export interface RpcServerDispatch {
  readonly interfaceId: bigint;
  readonly interfaceIds?: readonly bigint[];
  dispatch(
    methodId: number,
    params: Uint8Array,
    ctx: RpcCallContext,
  ): Promise<RpcServerDispatchResult> | RpcServerDispatchResult;
}

/**
 * Shared transport contract for generated `bootstrap*Client(...)` helpers.
 */
export interface RpcBootstrapClientTransport extends RpcClientTransport {
  bootstrap(options?: RpcCallOptions): Promise<CapabilityPointer>;
  close?(): Promise<void> | void;
}

/**
 * Shared export options for generated `register*Server(...)` helpers.
 */
export interface RpcExportCapabilityOptions {
  capabilityIndex?: number;
  referenceCount?: number;
}

/**
 * Shared registry contract for generated `register*Server(...)` helpers.
 */
export interface RpcServerRegistry {
  exportCapability(
    dispatch: RpcServerDispatch,
    options?: RpcExportCapabilityOptions,
  ): CapabilityPointer;
}

/**
 * Generic function signature of generated `bootstrap*Client(...)` helpers.
 */
export type RpcBootstrapClientFactory<
  TClient,
  TTransport extends RpcBootstrapClientTransport = RpcBootstrapClientTransport,
> = (transport: TTransport, options?: RpcCallOptions) => Promise<TClient>;

/**
 * Connected transport + typed bootstrap client pair.
 */
export interface RpcConnectedClient<
  TClient,
  TTransport extends RpcBootstrapClientTransport = RpcBootstrapClientTransport,
> {
  transport: TTransport;
  client: TClient;
}

declare const RPC_SERVICE_TOKEN_TYPE: unique symbol;

/**
 * Runtime metadata token for a generated RPC service interface.
 */
export interface RpcServiceToken<
  TClient extends object,
  TServer extends object = TClient,
> {
  interfaceId: bigint;
  interfaceName: string;
  bootstrapClient: (
    transport: RpcBootstrapClientTransport,
    options?: RpcCallOptions,
  ) => Promise<TClient>;
  registerServer: (
    registry: RpcServerRegistry,
    server: TServer,
    options?: RpcExportCapabilityOptions,
  ) => CapabilityPointer;
  readonly [RPC_SERVICE_TOKEN_TYPE]?: [TClient, TServer];
}

/**
 * Type of generated service stubs returned from high-level connectors.
 */
export interface RpcStubLifecycle {
  close(): Promise<void>;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Typed RPC stub plus lifecycle controls.
 */
export type RpcStub<TClient extends object> = TClient & RpcStubLifecycle;

/**
 * Generic high-level helper: connect transport, bootstrap typed client.
 *
 * If bootstrap fails, this helper best-effort closes the transport before
 * rethrowing the original error.
 */
export async function connectAndBootstrap<
  TClient,
  TTransport extends RpcBootstrapClientTransport,
>(
  connect: () => Promise<TTransport>,
  bootstrapClient: RpcBootstrapClientFactory<TClient, TTransport>,
  options?: RpcCallOptions,
): Promise<RpcConnectedClient<TClient, TTransport>> {
  const transport = await connect();
  try {
    const client = await bootstrapClient(transport, options);
    return { transport, client };
  } catch (error) {
    try {
      await transport.close?.();
    } catch {
      // best-effort cleanup only
    }
    throw error;
  }
}
