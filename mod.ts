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
} from "./src/errors.ts";

export {
  assertNonNegativeFinite,
  assertNonNegativeInteger,
  assertPositiveFinite,
  assertPositiveInteger,
} from "./src/validation.ts";

// === Generated RPC Helpers ===

export { connectAndBootstrap } from "./src/rpc/server/rpc_runtime.ts";

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
} from "./src/rpc/server/service.ts";

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
} from "./src/rpc/wire.ts";

export {
  type CapnpFrameLimitsOptions,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_NESTING_DEPTH,
  DEFAULT_MAX_SEGMENT_COUNT,
  DEFAULT_MAX_TRAVERSAL_WORDS,
  validateCapnpFrame,
} from "./src/rpc/wire/frame_limits.ts";

export {
  CapnpFrameFramer,
  type CapnpFrameFramerOptions,
} from "./src/rpc/wire/framer.ts";

// === Session & Transport ===

export { type RpcTransport } from "./src/rpc/transports/transport.ts";

export { type RpcRuntimeModuleOptions } from "./src/rpc/server/runtime_module.ts";

export {
  RpcSession,
  type RpcSessionCreateOptions,
  type RpcSessionOptions,
} from "./src/rpc/session/session.ts";

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
} from "./src/rpc/session/client.ts";

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
} from "./src/rpc/server/bridge.ts";

export {
  RpcServerCallInterceptTransport,
  RpcServerOutboundClient,
} from "./src/rpc/server/outbound.ts";

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
} from "./src/rpc/server/runtime.ts";

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
} from "./src/rpc/transports/middleware.ts";

// === Transports (TCP, WebSocket, MessagePort) ===

export {
  TcpServerListener,
  type TcpServerListenerOptions,
  TcpTransport,
  type TcpTransportOptions,
} from "./src/rpc/transports/tcp.ts";
export {
  type TcpRpcClientConnectOptions,
  TcpRpcClientTransport,
  type TcpRpcClientTransportOptions,
} from "./src/rpc/transports/tcp_rpc_client.ts";

export {
  WebSocketTransport,
  type WebSocketTransportOptions,
} from "./src/rpc/transports/websocket.ts";

export {
  MessagePortTransport,
  type MessagePortTransportOptions,
} from "./src/rpc/transports/message_port.ts";

// === Resilience (Connection Pool, Circuit Breaker, Reconnect) ===

export {
  RpcConnectionPool,
  type RpcConnectionPoolOptions,
  type RpcConnectionPoolStats,
  type RpcConnectionPoolWarmupStats,
  withConnection,
} from "./src/rpc/transports/connection_pool.ts";

export {
  CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitBreakerState,
} from "./src/rpc/transports/circuit_breaker.ts";

export {
  connectWithReconnect,
  type ConnectWithReconnectOptions,
  createExponentialBackoffReconnectPolicy,
  type ExponentialBackoffReconnectPolicyOptions,
  type ReconnectPolicy,
  type ReconnectPolicyContext,
  type ReconnectRetryInfo,
} from "./src/rpc/transports/reconnect.ts";

export {
  type ReconnectCapabilityRemapContext,
  ReconnectingRpcClientTransport,
  type ReconnectingRpcClientTransportOptions,
  type RpcCapabilityPointer,
  type RpcClientTransportLike,
} from "./src/rpc/transports/reconnecting_client.ts";

export {
  connectTcpTransportWithReconnect,
  type ConnectTcpTransportWithReconnectOptions,
  connectTransportWithReconnect,
  connectWebSocketTransportWithReconnect,
  type ConnectWebSocketTransportWithReconnectOptions,
  createRpcSessionWithReconnect,
  type CreateRpcSessionWithReconnectOptions,
} from "./src/rpc/transports/reconnect_wrappers.ts";

// === Streaming ===

export {
  createStreamSender,
  type StreamCallFn,
  type StreamSender,
  type StreamSenderOptions,
} from "./src/rpc/session/streaming.ts";

// === Observability ===

export {
  emitObservabilityEvent,
  type RpcObservability,
  type RpcObservabilityAttributes,
  type RpcObservabilityAttributeValue,
  type RpcObservabilityEvent,
} from "./src/observability/observability.ts";

export {
  createDenoOtelObservability,
  type DenoOtelObservabilityOptions,
} from "./src/observability/deno_otel.ts";
