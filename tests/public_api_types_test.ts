import { assert } from "./test_utils.ts";
import type {
  CapabilityPointer,
  CapnpErrorOptions,
  CapnpFrameFramerOptions,
  CapnpFrameLimitsOptions,
  CapnpWasmExports,
  ConnectTcpTransportWithReconnectOptions,
  ConnectWebSocketTransportWithReconnectOptions,
  ConnectWithReconnectOptions,
  CreateRpcSessionWithReconnectOptions,
  DenoOtelObservabilityOptions,
  ExponentialBackoffReconnectPolicyOptions,
  FrameSizeLimitMiddlewareOptions,
  JsonSerdeCodec,
  JsonSerdeCodecLookupOptions,
  JsonSerdeCodecOptions,
  JsonSerdeExportBinding,
  LoggingMiddlewareOptions,
  MessagePortTransportOptions,
  MiddlewareResult,
  ReconnectCapabilityRemapContext,
  ReconnectingRpcClientTransportOptions,
  ReconnectPolicy,
  ReconnectPolicyContext,
  ReconnectRetryInfo,
  RpcBootstrapRequest,
  RpcCallFrameRequest,
  RpcCallRequest,
  RpcCallTarget,
  RpcCapabilityPointer,
  RpcCapDescriptor,
  RpcClientCallOptions,
  RpcClientCallResult,
  RpcClientTransportLike,
  RpcFinishOptions,
  RpcFinishRequest,
  RpcObservability,
  RpcObservabilityAttributes,
  RpcObservabilityAttributeValue,
  RpcObservabilityEvent,
  RpcPromisedAnswerOp,
  RpcPromisedAnswerTarget,
  RpcReleaseRequest,
  RpcReturnException,
  RpcReturnExceptionFrameRequest,
  RpcReturnMessage,
  RpcReturnResults,
  RpcReturnResultsFrameRequest,
  RpcServerBridgeOptions,
  RpcServerBridgePumpHostCallsOptions,
  RpcServerCallContext,
  RpcServerCallResponse,
  RpcServerDispatch,
  RpcServerRuntimeHostCallPumpOptions,
  RpcServerRuntimeOptions,
  RpcServerRuntimePumpOptions,
  RpcServerRuntimeWarning,
  RpcServerRuntimeWarningCode,
  RpcServerWasmHost,
  RpcSessionHarnessTransport,
  RpcSessionOptions,
  RpcTransport,
  RpcTransportMiddleware,
  SessionRpcClientTransportOptions,
  TcpTransportOptions,
  WasmAbiCapabilities,
  WasmAbiOptions,
  WasmHostCallRecord,
  WasmSendFinishOptions,
  WebSocketTransportOptions,
} from "../mod.ts";

type Assert<T extends true> = T;
type IsEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type IsAssignable<From, To> = From extends To ? true : false;

type PublicTypeExportSmoke = {
  capnpErrorOptions: CapnpErrorOptions;
  capnpFrameFramerOptions: CapnpFrameFramerOptions;
  capnpFrameLimitsOptions: CapnpFrameLimitsOptions;
  capnpWasmExports: CapnpWasmExports;
  frameSizeLimitMiddlewareOptions: FrameSizeLimitMiddlewareOptions;
  loggingMiddlewareOptions: LoggingMiddlewareOptions;
  middlewareResult: MiddlewareResult;
  rpcTransportMiddleware: RpcTransportMiddleware;
  wasmAbiCapabilities: WasmAbiCapabilities;
  wasmHostCallRecord: WasmHostCallRecord;
  capabilityPointer: CapabilityPointer;
  connectTcpTransportWithReconnectOptions:
    ConnectTcpTransportWithReconnectOptions;
  connectWebSocketTransportWithReconnectOptions:
    ConnectWebSocketTransportWithReconnectOptions;
  connectWithReconnectOptions: ConnectWithReconnectOptions;
  createRpcSessionWithReconnectOptions: CreateRpcSessionWithReconnectOptions<
    RpcTransport
  >;
  denoOtelObservabilityOptions: DenoOtelObservabilityOptions;
  exponentialBackoffReconnectPolicyOptions:
    ExponentialBackoffReconnectPolicyOptions;
  jsonSerdeCodec: JsonSerdeCodec<unknown>;
  jsonSerdeCodecLookupOptions: JsonSerdeCodecLookupOptions<unknown>;
  jsonSerdeCodecOptions: JsonSerdeCodecOptions<unknown>;
  jsonSerdeExportBinding: JsonSerdeExportBinding;
  messagePortTransportOptions: MessagePortTransportOptions;
  reconnectCapabilityRemapContext: ReconnectCapabilityRemapContext;
  reconnectPolicy: ReconnectPolicy;
  reconnectPolicyContext: ReconnectPolicyContext;
  reconnectRetryInfo: ReconnectRetryInfo;
  reconnectingRpcClientTransportOptions: ReconnectingRpcClientTransportOptions;
  rpcBootstrapRequest: RpcBootstrapRequest;
  rpcCallFrameRequest: RpcCallFrameRequest;
  rpcCallRequest: RpcCallRequest;
  rpcCallTarget: RpcCallTarget;
  rpcCapDescriptor: RpcCapDescriptor;
  rpcCapabilityPointer: RpcCapabilityPointer;
  rpcClientCallOptions: RpcClientCallOptions;
  rpcClientCallResult: RpcClientCallResult;
  rpcClientTransportLike: RpcClientTransportLike;
  rpcFinishOptions: RpcFinishOptions;
  rpcFinishRequest: RpcFinishRequest;
  rpcObservability: RpcObservability;
  rpcObservabilityAttributes: RpcObservabilityAttributes;
  rpcObservabilityAttributeValue: RpcObservabilityAttributeValue;
  rpcObservabilityEvent: RpcObservabilityEvent;
  rpcReleaseRequest: RpcReleaseRequest;
  rpcReturnException: RpcReturnException;
  rpcReturnExceptionFrameRequest: RpcReturnExceptionFrameRequest;
  rpcReturnMessage: RpcReturnMessage;
  rpcReturnResults: RpcReturnResults;
  rpcReturnResultsFrameRequest: RpcReturnResultsFrameRequest;
  rpcPromisedAnswerOp: RpcPromisedAnswerOp;
  rpcPromisedAnswerTarget: RpcPromisedAnswerTarget;
  rpcServerBridgeOptions: RpcServerBridgeOptions;
  rpcServerRuntimeHostCallPumpOptions: RpcServerRuntimeHostCallPumpOptions;
  rpcServerRuntimeOptions: RpcServerRuntimeOptions;
  rpcServerRuntimePumpOptions: RpcServerRuntimePumpOptions;
  rpcServerRuntimeWarning: RpcServerRuntimeWarning;
  rpcServerRuntimeWarningCode: RpcServerRuntimeWarningCode;
  rpcServerBridgePumpHostCallsOptions: RpcServerBridgePumpHostCallsOptions;
  rpcServerCallContext: RpcServerCallContext;
  rpcServerCallResponse: RpcServerCallResponse;
  rpcServerDispatch: RpcServerDispatch;
  rpcServerWasmHost: RpcServerWasmHost;
  rpcSessionHarnessTransport: RpcSessionHarnessTransport;
  rpcSessionOptions: RpcSessionOptions;
  rpcTransport: RpcTransport;
  sessionRpcClientTransportOptions: SessionRpcClientTransportOptions;
  tcpTransportOptions: TcpTransportOptions;
  wasmAbiOptions: WasmAbiOptions;
  wasmSendFinishOptions: WasmSendFinishOptions;
  webSocketTransportOptions: WebSocketTransportOptions;
};

type AssertTypeExportsExist = Assert<
  IsAssignable<PublicTypeExportSmoke, PublicTypeExportSmoke>
>;

type AssertRpcTransportStartSignature = Assert<
  IsEqual<
    RpcTransport["start"],
    (
      onFrame: (frame: Uint8Array) => void | Promise<void>,
    ) => void | Promise<void>
  >
>;

type AssertRpcClientCallOptionsCapTable = Assert<
  IsEqual<
    RpcClientCallOptions["paramsCapTable"],
    RpcCapDescriptor[] | undefined
  >
>;

type AssertRpcClientCallResultCapTable = Assert<
  IsEqual<RpcClientCallResult["capTable"], RpcCapDescriptor[]>
>;

type AssertRpcServerCallContextCapTable = Assert<
  IsEqual<RpcServerCallContext["paramsCapTable"], RpcCapDescriptor[]>
>;

type AssertRpcServerDispatchInterface = Assert<
  IsEqual<RpcServerDispatch["interfaceId"], bigint>
>;

type RemapFn = NonNullable<
  ReconnectingRpcClientTransportOptions["remapCapabilityOnReconnect"]
>;
type AssertRemapCallbackContext = Assert<
  IsEqual<Parameters<RemapFn>[0], ReconnectCapabilityRemapContext>
>;

type RemapReturn = ReturnType<RemapFn>;
type ExpectedRemapReturn =
  | RpcCapabilityPointer
  | null
  | undefined
  | Promise<RpcCapabilityPointer | null | undefined>;
type AssertRemapReturnAssignable = Assert<
  IsAssignable<RemapReturn, ExpectedRemapReturn>
>;

type AssertReconnectOnRetrySignature = Assert<
  IsEqual<
    ConnectWithReconnectOptions["onRetry"],
    ((info: ReconnectRetryInfo) => void | Promise<void>) | undefined
  >
>;

type AssertCreateSessionAutoStart = Assert<
  IsEqual<
    CreateRpcSessionWithReconnectOptions<RpcTransport>["autoStart"],
    boolean | undefined
  >
>;

type AssertWasmAbiCapabilitiesHasHostCallReturnFrame = Assert<
  IsEqual<WasmAbiCapabilities["hasHostCallReturnFrame"], boolean>
>;

type StaticAssertions = [
  AssertTypeExportsExist,
  AssertRpcTransportStartSignature,
  AssertRpcClientCallOptionsCapTable,
  AssertRpcClientCallResultCapTable,
  AssertRpcServerCallContextCapTable,
  AssertRpcServerDispatchInterface,
  AssertRemapCallbackContext,
  AssertRemapReturnAssignable,
  AssertReconnectOnRetrySignature,
  AssertCreateSessionAutoStart,
  AssertWasmAbiCapabilitiesHasHostCallReturnFrame,
];

const STATIC_ASSERTIONS: StaticAssertions = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];

Deno.test("public API type contracts compile", () => {
  assert(STATIC_ASSERTIONS.length === 11);
});
