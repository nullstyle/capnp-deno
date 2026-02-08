// === Core: Errors, Validation, Types ===

export {
  AbiError,
  CapnpError,
  type CapnpErrorOptions,
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

// === WASM & ABI ===

export {
  type CapnpWasmExports,
  DEFAULT_MAX_DRAIN_FRAMES,
  type DrainOutFramesResult,
  getCapnpWasmExports,
  WasmAbi,
  type WasmAbiCapabilities,
  WasmAbiError,
  type WasmAbiOptions,
  type WasmHostCallRecord,
  type WasmSendFinishOptions,
} from "./src/abi.ts";

export { WasmPeer } from "./src/wasm_peer.ts";

export { instantiatePeer } from "./src/load.ts";

export {
  type JsonSerdeCodec,
  type JsonSerdeCodecLookupOptions,
  type JsonSerdeCodecOptions,
  type JsonSerdeExportBinding,
  WasmSerde,
} from "./src/serde.ts";

// === Wire Format & Message Routing ===

export {
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
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  encodeReturnExceptionFrame,
  encodeReturnResultsFrame,
  extractBootstrapCapabilityIndex,
  RPC_CALL_TARGET_TAG_IMPORTED_CAP,
  RPC_CALL_TARGET_TAG_PROMISED_ANSWER,
  RPC_MESSAGE_TAG_BOOTSTRAP,
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_FINISH,
  RPC_MESSAGE_TAG_RELEASE,
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
  type RpcMessageTagFinish,
  type RpcMessageTagRelease,
  type RpcMessageTagReturn,
  type RpcPromisedAnswerOp,
  type RpcPromisedAnswerTarget,
  type RpcReleaseRequest,
  type RpcReturnException,
  type RpcReturnExceptionFrameRequest,
  type RpcReturnMessage,
  type RpcReturnResults,
  type RpcReturnResultsFrameRequest,
} from "./src/rpc_wire.ts";

export {
  type CapnpFrameLimitsOptions,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_NESTING_DEPTH,
  DEFAULT_MAX_SEGMENT_COUNT,
  DEFAULT_MAX_TRAVERSAL_WORDS,
  validateCapnpFrame,
} from "./src/frame_limits.ts";

export {
  CapnpFrameFramer,
  type CapnpFrameFramerOptions,
} from "./src/framer.ts";

// === Session & Transport ===

export { type RpcTransport } from "./src/transport.ts";

export { RpcSession, type RpcSessionOptions } from "./src/session.ts";

// === RPC Client ===

export {
  type ClientMiddlewareContext,
  InMemoryRpcHarnessTransport,
  type RpcClientCallOptions,
  type RpcClientCallResult,
  type RpcClientMiddleware,
  type RpcFinishOptions,
  RpcPipeline,
  type RpcSessionHarnessTransport,
  SessionRpcClientTransport,
  type SessionRpcClientTransportOptions,
} from "./src/rpc_client.ts";

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
} from "./src/rpc_server.ts";

export {
  RpcServerRuntime,
  type RpcServerRuntimeHostCallPumpOptions,
  type RpcServerRuntimeOptions,
  type RpcServerRuntimePumpOptions,
  type RpcServerRuntimeWarning,
  type RpcServerRuntimeWarningCode,
} from "./src/server_runtime.ts";

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
} from "./src/middleware.ts";

// === Transports (TCP, WebSocket, MessagePort) ===

export {
  TcpTransport,
  type TcpTransportOptions,
} from "./src/transports/tcp.ts";

export {
  WebSocketTransport,
  type WebSocketTransportOptions,
} from "./src/transports/websocket.ts";

export {
  MessagePortTransport,
  type MessagePortTransportOptions,
} from "./src/transports/message_port.ts";

// === Resilience (Connection Pool, Circuit Breaker, Reconnect) ===

export {
  RpcConnectionPool,
  type RpcConnectionPoolOptions,
  type RpcConnectionPoolStats,
  type RpcConnectionPoolWarmupStats,
  withConnection,
} from "./src/connection_pool.ts";

export {
  CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitBreakerState,
} from "./src/circuit_breaker.ts";

export {
  connectWithReconnect,
  type ConnectWithReconnectOptions,
  createExponentialBackoffReconnectPolicy,
  type ExponentialBackoffReconnectPolicyOptions,
  type ReconnectPolicy,
  type ReconnectPolicyContext,
  type ReconnectRetryInfo,
} from "./src/reconnect.ts";

export {
  type ReconnectCapabilityRemapContext,
  ReconnectingRpcClientTransport,
  type ReconnectingRpcClientTransportOptions,
  type RpcCapabilityPointer,
  type RpcClientTransportLike,
} from "./src/reconnecting_client.ts";

export {
  connectTcpTransportWithReconnect,
  type ConnectTcpTransportWithReconnectOptions,
  connectTransportWithReconnect,
  connectWebSocketTransportWithReconnect,
  type ConnectWebSocketTransportWithReconnectOptions,
  createRpcSessionWithReconnect,
  type CreateRpcSessionWithReconnectOptions,
} from "./src/reconnect_wrappers.ts";

// === Observability ===

export {
  emitObservabilityEvent,
  type RpcObservability,
  type RpcObservabilityAttributes,
  type RpcObservabilityAttributeValue,
  type RpcObservabilityEvent,
} from "./src/observability.ts";

export {
  createDenoOtelObservability,
  type DenoOtelObservabilityOptions,
} from "./src/deno_otel.ts";
