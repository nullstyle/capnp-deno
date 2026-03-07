// === Core: Errors, Validation, Types ===

export {
  AbiError,
  CapnpError,
  type CapnpErrorOptions,
  type ErrorMetadata,
  InstantiationError,
  ProtocolError,
  SessionError,
  TransportError,
} from "./errors.ts";

export {
  assertNonNegativeFinite,
  assertNonNegativeInteger,
  assertPositiveFinite,
  assertPositiveInteger,
} from "./validation.ts";

// === Generated RPC Helpers ===

export { connectAndBootstrap } from "./rpc/server/rpc_runtime.ts";

// === High-Level Service API (DX V2) ===

export {
  createRpcServiceToken,
  RpcPeer,
  type RpcPeerAddress,
  type RpcPeerOptions,
  type RpcServiceConstructor,
  type RpcServiceImplementation,
  type RpcServiceToken,
  type RpcServiceTokenCreateOptions,
  type RpcStub,
  type RpcStubLifecycle,
  TCP,
  type TcpConnectOptions,
  type TcpPort,
  type TcpServeHandle,
  type TcpServeOptions,
  type TcpServiceApi,
  type WebSocketConnectOptions,
  type WebSocketRequestHandler,
  type WebSocketServeHandle,
  type WebSocketServeOptions,
  type WebSocketServiceApi,
  type WebSocketUrl,
  type WebTransportConnectOptions,
  type WebTransportServeHandle,
  type WebTransportServeOptions,
  type WebTransportServiceApi,
  type WebTransportUrl,
  WS,
  WT,
} from "./rpc/server/service.ts";

// === Wire Format & Message Routing ===

export {
  CAP_DESCRIPTOR_TAG_RECEIVER_HOSTED,
  CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
  decodeBootstrapRequestFrame,
  decodeCallRequestFrame,
  decodeFinishFrame,
  decodeReleaseFrame,
  decodeReturnFrame,
  decodeRpcMessage,
  decodeRpcMessageTag,
  dispatchRpcMessage,
  EMPTY_STRUCT_MESSAGE,
  encodeBootstrapRequestFrame,
  encodeBootstrapResponseFrame,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  encodeReturnExceptionFrame,
  encodeReturnResultsFrame,
  extractBootstrapCapabilityIndex,
  frameFromSegment,
  MessageBuilder,
  RETURN_TAG_EXCEPTION,
  RETURN_TAG_RESULTS,
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
  RPC_PROMISED_ANSWER_OP_TAG_NOOP,
  type RpcBootstrapRequest,
  type RpcCallFrameRequest,
  type RpcCallRequest,
  type RpcCallTarget,
  type RpcCapDescriptor,
  type RpcFinishRequest,
  type RpcMessage,
  type RpcMessageHandlers,
  type RpcMessageTagBootstrap,
  type RpcMessageTagCall,
  type RpcMessageTagDisembargo,
  type RpcMessageTagFinish,
  type RpcMessageTagRelease,
  type RpcMessageTagResolve,
  type RpcMessageTagReturn,
  type RpcPromisedAnswerOp,
  type RpcPromisedAnswerTarget,
  type RpcReleaseRequest,
  type RpcReturnException,
  type RpcReturnExceptionFrameRequest,
  type RpcReturnMessage,
  type RpcReturnResults,
  type RpcReturnResultsFrameRequest,
  segmentsFromFrame,
  type SegmentTable,
} from "./rpc/wire.ts";

export {
  type CapnpFrameLimitsOptions,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_NESTING_DEPTH,
  DEFAULT_MAX_SEGMENT_COUNT,
  DEFAULT_MAX_TRAVERSAL_WORDS,
  validateCapnpFrame,
} from "./rpc/wire/frame_limits.ts";

export {
  CapnpFrameFramer,
  type CapnpFrameFramerOptions,
} from "./rpc/wire/framer.ts";

// === Session & Transport ===

export { type RpcTransport } from "./rpc/transports/transport.ts";

export { type RpcRuntimeModuleOptions } from "./rpc/server/runtime_module.ts";

export {
  RpcSession,
  type RpcSessionCreateOptions,
  type RpcSessionOptions,
} from "./rpc/session/session.ts";

// === RPC Client ===

export {
  type ClientMiddlewareContext,
  InMemoryRpcHarnessTransport,
  NetworkRpcHarnessTransport,
  type RpcClientCallOptions,
  type RpcClientCallResult,
  type RpcClientMiddleware,
  type RpcFinishOptions,
  RpcPipeline,
  type RpcSessionHarnessTransport,
  SessionRpcClientTransport,
  type SessionRpcClientTransportCreateOptions,
  type SessionRpcClientTransportOptions,
} from "./rpc/session/client.ts";

// === RPC Server ===

export {
  type CapabilityPointer,
  type RpcCallContext as RpcServerCallContext,
  type RpcCallResponse as RpcServerCallResponse,
  RpcServerBridge,
  type RpcServerBridgeOptions,
  type RpcServerBridgePumpHostCallsOptions,
  type RpcServerDispatch,
  type RpcServerMiddleware,
  type RpcServerWasmHost,
  type ServerMiddlewareContext,
  type ServerMiddlewareDispatchResult,
  type ServerMiddlewareFrameResult,
} from "./rpc/server/bridge.ts";

export {
  RpcServerCallInterceptTransport,
  RpcServerOutboundClient,
} from "./rpc/server/outbound.ts";

export {
  RpcServerRuntime,
  type RpcServerRuntimeCreateOptions,
  type RpcServerRuntimeCreateWithRootOptions,
  type RpcServerRuntimeHostCallPumpOptions,
  type RpcServerRuntimeOptions,
  type RpcServerRuntimePumpOptions,
  type RpcServerRuntimeRootRegistrar,
  type RpcServerRuntimeRootRegistrationOptions,
  type RpcServerRuntimeWarning,
  type RpcServerRuntimeWarningCode,
} from "./rpc/server/runtime.ts";

// === Middleware (Client & Server) ===

export {
  createFrameSizeLimitMiddleware,
  createLoggingMiddleware,
  createRpcIntrospectionMiddleware,
  createRpcMetricsMiddleware,
  type FrameSizeLimitMiddlewareOptions,
  type LoggingMiddlewareOptions,
  type MiddlewareResult,
  MiddlewareTransport,
  type RpcFrameDirection,
  type RpcFrameDirectionFilter,
  type RpcIntrospectionCallbacks,
  type RpcMetricsFramesByType,
  type RpcMetricsMiddleware,
  type RpcMetricsMiddlewareOptions,
  type RpcMetricsSnapshot,
  type RpcTransportMiddleware,
} from "./rpc/transports/middleware.ts";

// === Transports (TCP, WebSocket, MessagePort) ===

export {
  TcpServerListener,
  type TcpServerListenerOptions,
  TcpTransport,
  type TcpTransportOptions,
} from "./rpc/transports/tcp.ts";
export {
  type TcpRpcClientConnectOptions,
  TcpRpcClientTransport,
  type TcpRpcClientTransportOptions,
} from "./rpc/transports/tcp_rpc_client.ts";

export {
  WebSocketTransport,
  type WebSocketTransportOptions,
} from "./rpc/transports/websocket.ts";

export {
  MessagePortTransport,
  type MessagePortTransportOptions,
} from "./rpc/transports/message_port.ts";

export {
  WebTransportTransport,
  type WebTransportTransportAcceptOptions,
  type WebTransportTransportConnectOptions,
  type WebTransportTransportOptions,
} from "./rpc/transports/webtransport.ts";

// === Resilience (Connection Pool, Circuit Breaker, Reconnect) ===

export {
  RpcConnectionPool,
  type RpcConnectionPoolOptions,
  type RpcConnectionPoolStats,
  type RpcConnectionPoolWarmupStats,
  withConnection,
} from "./rpc/transports/connection_pool.ts";

export {
  CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitBreakerState,
} from "./rpc/transports/circuit_breaker.ts";

export {
  connectWithReconnect,
  type ConnectWithReconnectOptions,
  createExponentialBackoffReconnectPolicy,
  type ExponentialBackoffReconnectPolicyOptions,
  type ReconnectPolicy,
  type ReconnectPolicyContext,
  type ReconnectRetryInfo,
} from "./rpc/transports/reconnect.ts";

export {
  type ReconnectCapabilityRemapContext,
  ReconnectingRpcClientTransport,
  type ReconnectingRpcClientTransportOptions,
  type RpcCapabilityPointer,
  type RpcClientTransportLike,
} from "./rpc/transports/reconnecting_client.ts";

export {
  connectTcpTransportWithReconnect,
  type ConnectTcpTransportWithReconnectOptions,
  connectTransportWithReconnect,
  connectWebSocketTransportWithReconnect,
  type ConnectWebSocketTransportWithReconnectOptions,
  connectWebTransportTransportWithReconnect,
  type ConnectWebTransportTransportWithReconnectOptions,
  createRpcSessionWithReconnect,
  type CreateRpcSessionWithReconnectOptions,
} from "./rpc/transports/reconnect_wrappers.ts";

// === Streaming ===

export {
  createStreamSender,
  type StreamCallFn,
  type StreamSender,
  type StreamSenderOptions,
} from "./rpc/session/streaming.ts";

// === Observability ===

export {
  emitObservabilityEvent,
  type RpcObservability,
  type RpcObservabilityAttributes,
  type RpcObservabilityAttributeValue,
  type RpcObservabilityEvent,
} from "./observability/observability.ts";

export {
  createDenoOtelObservability,
  type DenoOtelObservabilityOptions,
} from "./observability/deno_otel.ts";
