import { assert } from "./test_utils.ts";
import type {
  CapabilityPointer,
  CapnpErrorOptions,
  CapnpFrameFramerOptions,
  CapnpFrameLimitsOptions,
  ConnectTcpTransportWithReconnectOptions,
  ConnectWebSocketTransportWithReconnectOptions,
  ConnectWithReconnectOptions,
  CreateRpcSessionWithReconnectOptions,
  DenoOtelObservabilityOptions,
  ExponentialBackoffReconnectPolicyOptions,
  FrameSizeLimitMiddlewareOptions,
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
  RpcConnectionPoolOptions,
  RpcConnectionPoolStats,
  RpcFinishOptions,
  RpcFinishRequest,
  RpcFrameDirection,
  RpcIntrospectionCallbacks,
  RpcMetricsFramesByType,
  RpcMetricsMiddleware,
  RpcMetricsMiddlewareOptions,
  RpcMetricsSnapshot,
  RpcObservability,
  RpcObservabilityAttributes,
  RpcObservabilityAttributeValue,
  RpcObservabilityEvent,
  RpcPeerAddress,
  RpcPeerOptions,
  RpcPromisedAnswerOp,
  RpcPromisedAnswerTarget,
  RpcReleaseRequest,
  RpcReturnException,
  RpcReturnExceptionFrameRequest,
  RpcReturnMessage,
  RpcReturnResults,
  RpcReturnResultsFrameRequest,
  RpcRuntimeModuleOptions,
  RpcServerBridgeOptions,
  RpcServerBridgePumpHostCallsOptions,
  RpcServerCallContext,
  RpcServerCallResponse,
  RpcServerDispatch,
  RpcServerRuntimeCreateOptions,
  RpcServerRuntimeCreateWithRootOptions,
  RpcServerRuntimeHostCallPumpOptions,
  RpcServerRuntimeOptions,
  RpcServerRuntimePumpOptions,
  RpcServerRuntimeRootRegistrar,
  RpcServerRuntimeRootRegistrationOptions,
  RpcServerRuntimeWarning,
  RpcServerRuntimeWarningCode,
  RpcServerWasmHost,
  RpcServiceConstructor,
  RpcServiceImplementation,
  RpcServiceToken,
  RpcServiceTokenCreateOptions,
  RpcSessionCreateOptions,
  RpcSessionHarnessTransport,
  RpcSessionOptions,
  RpcStub,
  RpcStubLifecycle,
  RpcTransport,
  RpcTransportMiddleware,
  SessionRpcClientTransportCreateOptions,
  SessionRpcClientTransportOptions,
  TcpConnectOptions,
  TcpPort,
  TcpRpcClientConnectOptions,
  TcpRpcClientTransportOptions,
  TcpServeHandle,
  TcpServeOptions,
  TcpServiceApi,
  TcpTransportOptions,
  WebSocketConnectOptions,
  WebSocketServeHandle,
  WebSocketServeOptions,
  WebSocketServiceApi,
  WebSocketTransportOptions,
  WebSocketUrl,
} from "../src/mod.ts";

type Assert<T extends true> = T;
type IsEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type IsAssignable<From, To> = From extends To ? true : false;

type PublicTypeExportSmoke = {
  capnpErrorOptions: CapnpErrorOptions;
  capnpFrameFramerOptions: CapnpFrameFramerOptions;
  capnpFrameLimitsOptions: CapnpFrameLimitsOptions;
  frameSizeLimitMiddlewareOptions: FrameSizeLimitMiddlewareOptions;
  loggingMiddlewareOptions: LoggingMiddlewareOptions;
  middlewareResult: MiddlewareResult;
  rpcTransportMiddleware: RpcTransportMiddleware;
  rpcFrameDirection: RpcFrameDirection;
  rpcIntrospectionCallbacks: RpcIntrospectionCallbacks;
  rpcMetricsFramesByType: RpcMetricsFramesByType;
  rpcMetricsMiddleware: RpcMetricsMiddleware;
  rpcMetricsMiddlewareOptions: RpcMetricsMiddlewareOptions;
  rpcMetricsSnapshot: RpcMetricsSnapshot;
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
  messagePortTransportOptions: MessagePortTransportOptions;
  reconnectCapabilityRemapContext: ReconnectCapabilityRemapContext;
  reconnectPolicy: ReconnectPolicy;
  reconnectPolicyContext: ReconnectPolicyContext;
  reconnectRetryInfo: ReconnectRetryInfo;
  reconnectingRpcClientTransportOptions: ReconnectingRpcClientTransportOptions;
  rpcPeerAddress: RpcPeerAddress;
  rpcPeerOptions: RpcPeerOptions;
  rpcBootstrapRequest: RpcBootstrapRequest;
  rpcCallFrameRequest: RpcCallFrameRequest;
  rpcCallRequest: RpcCallRequest;
  rpcCallTarget: RpcCallTarget;
  rpcCapDescriptor: RpcCapDescriptor;
  rpcCapabilityPointer: RpcCapabilityPointer;
  rpcClientCallOptions: RpcClientCallOptions;
  rpcClientCallResult: RpcClientCallResult;
  rpcClientTransportLike: RpcClientTransportLike;
  rpcConnectionPoolOptions: RpcConnectionPoolOptions;
  rpcConnectionPoolStats: RpcConnectionPoolStats;
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
  rpcServiceConstructor: RpcServiceConstructor<{ ping(): Promise<void> }>;
  rpcServiceImplementation: RpcServiceImplementation<{ ping(): Promise<void> }>;
  rpcServiceToken: RpcServiceToken<{ ping(): Promise<void> }>;
  rpcServiceTokenCreateOptions: RpcServiceTokenCreateOptions<{
    ping(): Promise<void>;
  }>;
  rpcStub: RpcStub<{ ping(): Promise<void> }>;
  rpcStubLifecycle: RpcStubLifecycle;
  rpcServerBridgeOptions: RpcServerBridgeOptions;
  rpcServerRuntimeHostCallPumpOptions: RpcServerRuntimeHostCallPumpOptions;
  rpcServerRuntimeOptions: RpcServerRuntimeOptions;
  rpcServerRuntimePumpOptions: RpcServerRuntimePumpOptions;
  rpcServerRuntimeRootRegistrationOptions:
    RpcServerRuntimeRootRegistrationOptions;
  rpcServerRuntimeRootRegistrar: RpcServerRuntimeRootRegistrar<{
    ping(): Promise<void> | void;
  }>;
  rpcServerRuntimeWarning: RpcServerRuntimeWarning;
  rpcServerRuntimeWarningCode: RpcServerRuntimeWarningCode;
  rpcServerBridgePumpHostCallsOptions: RpcServerBridgePumpHostCallsOptions;
  rpcServerCallContext: RpcServerCallContext;
  rpcServerCallResponse: RpcServerCallResponse;
  rpcServerRuntimeCreateOptions: RpcServerRuntimeCreateOptions;
  rpcServerRuntimeCreateWithRootOptions: RpcServerRuntimeCreateWithRootOptions;
  rpcServerDispatch: RpcServerDispatch;
  rpcServerWasmHost: RpcServerWasmHost;
  rpcRuntimeModuleOptions: RpcRuntimeModuleOptions;
  rpcSessionCreateOptions: RpcSessionCreateOptions;
  rpcSessionHarnessTransport: RpcSessionHarnessTransport;
  rpcSessionOptions: RpcSessionOptions;
  rpcTransport: RpcTransport;
  tcpConnectOptions: TcpConnectOptions;
  tcpPort: TcpPort;
  sessionRpcClientTransportCreateOptions:
    SessionRpcClientTransportCreateOptions;
  sessionRpcClientTransportOptions: SessionRpcClientTransportOptions;
  tcpServeHandle: TcpServeHandle;
  tcpServeOptions: TcpServeOptions;
  tcpServiceApi: TcpServiceApi;
  tcpTransportOptions: TcpTransportOptions;
  tcpRpcClientConnectOptions: TcpRpcClientConnectOptions;
  tcpRpcClientTransportOptions: TcpRpcClientTransportOptions;
  webSocketConnectOptions: WebSocketConnectOptions;
  webSocketServeHandle: WebSocketServeHandle;
  webSocketServeOptions: WebSocketServeOptions;
  webSocketServiceApi: WebSocketServiceApi;
  webSocketTransportOptions: WebSocketTransportOptions;
  webSocketUrl: WebSocketUrl;
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

type AssertSessionCreateAutoStart = Assert<
  IsEqual<RpcSessionCreateOptions["autoStart"], boolean | undefined>
>;

type AssertClientCreateStartSession = Assert<
  IsEqual<
    SessionRpcClientTransportCreateOptions["startSession"],
    boolean | undefined
  >
>;

type AssertRpcConnectionPoolOptionsMaxConnections = Assert<
  IsEqual<RpcConnectionPoolOptions["maxConnections"], number | undefined>
>;

type AssertRpcConnectionPoolStatsTotal = Assert<
  IsEqual<RpcConnectionPoolStats["total"], number>
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
  AssertSessionCreateAutoStart,
  AssertClientCreateStartSession,
  AssertRpcConnectionPoolOptionsMaxConnections,
  AssertRpcConnectionPoolStatsTotal,
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
  true,
  true,
  true,
];

Deno.test("public API type contracts compile", () => {
  assert(STATIC_ASSERTIONS.length === 14);
});
