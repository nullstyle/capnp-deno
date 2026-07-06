import { assert } from "./test_utils.ts";
import type {
  AddParams,
  CounterSink as CounterService,
  CounterSink as CounterServiceToken,
  CounterSinkClient,
  CounterSinkServer,
  CounterSinkService as CounterServiceServer,
  createCounterSinkAddStreamSender,
  TotalResults,
} from "../examples/streaming/gen/schema_types.ts";
import type {
  Pinger as PingService,
  Pinger as PingServiceToken,
  PingerClient,
  PingerServer,
  PingParams,
  PingResults,
  Ponger as PongService,
  PongerClient,
  PongerServer,
  PongParams,
  PongResults,
} from "../examples/ping/gen/schema_types.ts";
import type {
  CapabilityPointer,
  CapnpErrorOptions,
  CapnpFrameFramerOptions,
  CapnpFrameLimitsOptions,
  ConnectTcpTransportWithReconnectOptions,
  ConnectWebSocketTransportWithReconnectOptions,
  ConnectWebTransportTransportWithReconnectOptions,
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
  RpcAcceptedTransport,
  RpcBootstrapRequest,
  RpcCallContext,
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
  RpcServiceBinding,
  RpcServiceConnectionHandle,
  RpcServiceConnectOptions,
  RpcServiceConstructor,
  RpcServiceContext,
  RpcServiceFactory,
  RpcServiceHandle,
  RpcServiceImplementation,
  RpcServiceServeOptions,
  RpcServiceToken,
  RpcServiceTokenCreateOptions,
  RpcSessionCreateOptions,
  RpcSessionHarnessTransport,
  RpcSessionOptions,
  RpcStub,
  RpcStubLifecycle,
  RpcTransport,
  RpcTransportAcceptor,
  RpcTransportMiddleware,
  RpcWireClientOptions,
  SessionRpcClientTransportCreateOptions,
  SessionRpcClientTransportOptions,
  StreamCallFn,
  StreamSendContext,
  StreamSender,
  StreamSenderOptions,
  TcpTransportListener,
  TcpTransportListenOptions,
  TcpTransportOptions,
  WebSocketTransportHandler,
  WebSocketTransportHandlerOptions,
  WebSocketTransportListener,
  WebSocketTransportListenOptions,
  WebSocketTransportOptions,
  WebTransportTransportAcceptOptions,
  WebTransportTransportConnectOptions,
  WebTransportTransportListener,
  WebTransportTransportListenOptions,
  WebTransportTransportOptions,
} from "../src/mod.ts";
import type { connect, serve } from "../src/mod.ts";

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
  rpcWireClientOptions: RpcWireClientOptions;
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
  connectWebTransportTransportWithReconnectOptions:
    ConnectWebTransportTransportWithReconnectOptions;
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
  rpcCallContext: RpcCallContext;
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
  rpcAcceptedTransport: RpcAcceptedTransport;
  rpcReleaseRequest: RpcReleaseRequest;
  rpcReturnException: RpcReturnException;
  rpcReturnExceptionFrameRequest: RpcReturnExceptionFrameRequest;
  rpcReturnMessage: RpcReturnMessage;
  rpcReturnResults: RpcReturnResults;
  rpcReturnResultsFrameRequest: RpcReturnResultsFrameRequest;
  rpcPromisedAnswerOp: RpcPromisedAnswerOp;
  rpcPromisedAnswerTarget: RpcPromisedAnswerTarget;
  rpcServiceBinding: RpcServiceBinding<{ ping(): Promise<void> }>;
  rpcServiceConnectOptions: RpcServiceConnectOptions;
  rpcServiceConnectionHandle: RpcServiceConnectionHandle;
  rpcServiceContext: RpcServiceContext;
  rpcServiceFactory: RpcServiceFactory<{ ping(): Promise<void> }>;
  rpcServiceHandle: RpcServiceHandle;
  rpcServiceConstructor: RpcServiceConstructor<{ ping(): Promise<void> }>;
  rpcServiceImplementation: RpcServiceImplementation<{ ping(): Promise<void> }>;
  rpcServiceServeOptions: RpcServiceServeOptions;
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
  rpcTransportAcceptor: RpcTransportAcceptor;
  rpcTransport: RpcTransport;
  sessionRpcClientTransportCreateOptions:
    SessionRpcClientTransportCreateOptions;
  sessionRpcClientTransportOptions: SessionRpcClientTransportOptions;
  streamCallFn: StreamCallFn<number, void>;
  streamSendContext: StreamSendContext;
  streamSender: StreamSender<number, void>;
  streamSenderOptions: StreamSenderOptions<void>;
  tcpTransportListenOptions: TcpTransportListenOptions;
  tcpTransportListener: TcpTransportListener;
  tcpTransportOptions: TcpTransportOptions;
  webSocketTransportHandler: WebSocketTransportHandler;
  webSocketTransportHandlerOptions: WebSocketTransportHandlerOptions;
  webSocketTransportListener: WebSocketTransportListener;
  webSocketTransportListenOptions: WebSocketTransportListenOptions;
  webSocketTransportOptions: WebSocketTransportOptions;
  webTransportTransportAcceptOptions: WebTransportTransportAcceptOptions;
  webTransportTransportListener: WebTransportTransportListener;
  webTransportTransportListenOptions: WebTransportTransportListenOptions;
  webTransportTransportConnectOptions: WebTransportTransportConnectOptions;
  webTransportTransportOptions: WebTransportTransportOptions;
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

type AssertRpcCallContextSignal = Assert<
  IsEqual<RpcCallContext["signal"], AbortSignal>
>;

type AssertStreamSendContextSignal = Assert<
  IsEqual<StreamSendContext["signal"], AbortSignal>
>;

type AssertStreamSenderGenericSend = Assert<
  IsEqual<Parameters<StreamSender<number, void>["send"]>[0], number>
>;

type AssertStreamSenderCancel = Assert<
  IsEqual<
    StreamSender<number, void>["cancel"],
    (reason?: unknown) => Promise<void>
  >
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

type AssertPingServiceTokenForConnect = Assert<
  IsAssignable<
    typeof PingServiceToken,
    Parameters<typeof connect<PingService>>[0]
  >
>;

type AssertPingServiceTokenForServe = Assert<
  IsAssignable<
    typeof PingServiceToken,
    Parameters<typeof serve<PingService, PingService>>[0]
  >
>;

type PingArgument = Parameters<PingService["ping"]>[0];
type AssertPingAcceptsLocalCallback = Assert<
  IsAssignable<PongService, PingArgument>
>;
type AssertPingAcceptsRemoteCallbackStub = Assert<
  IsAssignable<RpcStub<PongService>, PingArgument>
>;
type AssertPingArgumentShape = Assert<
  IsEqual<PingArgument, PongService | RpcStub<PongService>>
>;
type AssertPingReturnsVoidPromise = Assert<
  IsEqual<ReturnType<PingService["ping"]>, Promise<void>>
>;
type AssertPongArgumentShape = Assert<
  IsEqual<Parameters<PongService["pong"]>[0], number>
>;
type AssertPongReturnsVoidPromise = Assert<
  IsEqual<ReturnType<PongService["pong"]>, Promise<void>>
>;
type AssertLowLevelPingerClientShape = Assert<
  IsEqual<
    Parameters<PingerClient["ping"]>[0],
    PingParams
  >
>;
type AssertLowLevelPingerClientReturn = Assert<
  IsEqual<ReturnType<PingerClient["ping"]>, Promise<PingResults>>
>;
type AssertLowLevelPingerServerContext = Assert<
  IsEqual<Parameters<PingerServer["ping"]>[1], RpcCallContext>
>;
type AssertLowLevelPingerServerReturn = Assert<
  IsEqual<
    ReturnType<PingerServer["ping"]>,
    Promise<PingResults> | PingResults
  >
>;
type AssertLowLevelPongerClientShape = Assert<
  IsEqual<
    Parameters<PongerClient["pong"]>[0],
    PongParams
  >
>;
type AssertLowLevelPongerClientReturn = Assert<
  IsEqual<ReturnType<PongerClient["pong"]>, Promise<PongResults>>
>;
type AssertLowLevelPongerServerContext = Assert<
  IsEqual<Parameters<PongerServer["pong"]>[1], RpcCallContext>
>;

type AssertCounterServiceTokenForConnect = Assert<
  IsAssignable<
    typeof CounterServiceToken,
    Parameters<typeof connect<CounterService, CounterServiceServer>>[0]
  >
>;

type AssertCounterServiceTokenForServe = Assert<
  IsAssignable<
    typeof CounterServiceToken,
    Parameters<typeof serve<CounterServiceServer, CounterService>>[0]
  >
>;

type CounterAddArgument = Parameters<CounterService["add"]>[0];
type AssertCounterAddAcceptsTypedParam = Assert<
  IsEqual<CounterAddArgument, number>
>;
type AssertCounterTotalReturn = Assert<
  IsEqual<ReturnType<CounterService["total"]>, Promise<TotalResults>>
>;

type CounterServerAddArguments = Parameters<CounterServiceServer["add"]>;
type AssertCounterServerReceivesContext = Assert<
  IsEqual<CounterServerAddArguments, [number, RpcCallContext]>
>;
type AssertCounterServerAddReturn = Assert<
  IsEqual<ReturnType<CounterServiceServer["add"]>, Promise<void> | void>
>;
type AssertLowLevelCounterClientStreamingReturn = Assert<
  IsEqual<ReturnType<CounterSinkClient["add"]>, Promise<void>>
>;
type AssertLowLevelCounterClientParams = Assert<
  IsEqual<Parameters<CounterSinkClient["add"]>[0], AddParams>
>;
type AssertLowLevelCounterServerStreamingReturn = Assert<
  IsEqual<ReturnType<CounterSinkServer["add"]>, Promise<void> | void>
>;
type AssertLowLevelCounterServerContext = Assert<
  IsEqual<Parameters<CounterSinkServer["add"]>[1], RpcCallContext>
>;

type CounterAddStreamSender = ReturnType<
  typeof createCounterSinkAddStreamSender
>;
type AssertCounterAddStreamSenderTyped = Assert<
  IsAssignable<CounterAddStreamSender, StreamSender<number, void>>
>;
type AssertCounterAddStreamSenderClientParam = Assert<
  IsEqual<
    Parameters<typeof createCounterSinkAddStreamSender>[0],
    CounterService
  >
>;

type StaticAssertions = [
  AssertTypeExportsExist,
  AssertRpcTransportStartSignature,
  AssertRpcClientCallOptionsCapTable,
  AssertRpcClientCallResultCapTable,
  AssertRpcServerCallContextCapTable,
  AssertRpcCallContextSignal,
  AssertStreamSendContextSignal,
  AssertStreamSenderGenericSend,
  AssertStreamSenderCancel,
  AssertRpcServerDispatchInterface,
  AssertRemapCallbackContext,
  AssertRemapReturnAssignable,
  AssertReconnectOnRetrySignature,
  AssertCreateSessionAutoStart,
  AssertSessionCreateAutoStart,
  AssertClientCreateStartSession,
  AssertRpcConnectionPoolOptionsMaxConnections,
  AssertRpcConnectionPoolStatsTotal,
  AssertPingServiceTokenForConnect,
  AssertPingServiceTokenForServe,
  AssertPingAcceptsLocalCallback,
  AssertPingAcceptsRemoteCallbackStub,
  AssertPingArgumentShape,
  AssertPingReturnsVoidPromise,
  AssertPongArgumentShape,
  AssertPongReturnsVoidPromise,
  AssertLowLevelPingerClientShape,
  AssertLowLevelPingerClientReturn,
  AssertLowLevelPingerServerContext,
  AssertLowLevelPingerServerReturn,
  AssertLowLevelPongerClientShape,
  AssertLowLevelPongerClientReturn,
  AssertLowLevelPongerServerContext,
  AssertCounterServiceTokenForConnect,
  AssertCounterServiceTokenForServe,
  AssertCounterAddAcceptsTypedParam,
  AssertCounterTotalReturn,
  AssertCounterServerReceivesContext,
  AssertCounterServerAddReturn,
  AssertLowLevelCounterClientStreamingReturn,
  AssertLowLevelCounterClientParams,
  AssertLowLevelCounterServerStreamingReturn,
  AssertLowLevelCounterServerContext,
  AssertCounterAddStreamSenderTyped,
  AssertCounterAddStreamSenderClientParam,
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
  true,
  true,
  true,
];

Deno.test("public API type contracts compile", () => {
  assert(STATIC_ASSERTIONS.length === 45);
});
