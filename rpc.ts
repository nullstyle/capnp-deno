/**
 * Public RPC/runtime entrypoint.
 *
 * Import from `@nullstyle/capnp/rpc` when you need session, transport,
 * client/server, and resilience APIs without the wire/frame encoding helpers.
 */

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

export {
  connectAndBootstrap,
  type RpcBootstrapClientFactory,
  type RpcBootstrapClientTransport,
  type RpcCallContext,
  type RpcCallOptions,
  type RpcClientTransport,
  type RpcConnectedClient,
  type RpcExportCapabilityOptions,
  type RpcServerDispatch as RpcGeneratedServerDispatch,
  type RpcServerDispatchResult,
  type RpcServerRegistry,
} from "./src/rpc/server/rpc_runtime.ts";

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
