/**
 * High-level token-based RPC service APIs.
 *
 * This module is the runtime contract for DX V2:
 * - generated code exports {@link RpcServiceToken} values,
 * - applications call {@link TCP.connect} / {@link TCP.serve},
 *   {@link WS.connect} / {@link WS.serve}, or {@link WT.connect} /
 *   {@link WT.serve},
 * - runtime bridges tokens to existing transport/session primitives.
 *
 * @module
 */

import type { CapabilityPointer } from "../../encoding/runtime.ts";
import type {
  RpcBootstrapClientTransport,
  RpcCallOptions,
  RpcExportCapabilityOptions,
  RpcServerRegistry,
} from "./rpc_runtime.ts";
import { normalizeTcpPort } from "./service_net.ts";
import type { RpcServerRuntimeCreateWithRootOptions } from "./runtime.ts";
import {
  RpcWireClient,
  type RpcWireClientOptions,
} from "../rpc_wire_client.ts";
import { TcpTransport } from "../transports/tcp.ts";
import type {
  TcpTransportListener,
  TcpTransportOptions,
} from "../transports/tcp.ts";
import {
  WebSocketTransport,
  type WebSocketTransportOptions,
} from "../transports/websocket.ts";
import {
  WebTransportTransport,
  type WebTransportTransportAcceptOptions,
  type WebTransportTransportConnectOptions,
} from "../transports/webtransport.ts";
import { createTcpServeHandle } from "./service_tcp.ts";
import {
  createWebSocketRequestHandler,
  createWebSocketServeHandle,
} from "./service_websocket.ts";
import { createWebTransportServeHandle } from "./service_webtransport.ts";
import type {
  RpcServiceImplementation,
  RpcStub,
  TcpPort,
} from "./service_types.ts";

declare const RPC_SERVICE_TOKEN_TYPE: unique symbol;

/**
 * Runtime metadata token for a generated RPC service interface.
 *
 * Generated code should export one token per interface.
 */
export interface RpcServiceToken<
  TClient extends object,
  TServer extends object = TClient,
> {
  /** Stable Cap'n Proto interface id. */
  readonly interfaceId: bigint;
  /** Human-readable interface name. */
  readonly interfaceName: string;
  /**
   * Generated typed bootstrap helper.
   *
   * Usually implemented by generated `bootstrap*Client(...)`.
   */
  bootstrapClient(
    transport: RpcBootstrapClientTransport,
    options?: RpcCallOptions,
  ): Promise<TClient>;
  /**
   * Generated typed server registrar.
   *
   * Usually implemented by generated `register*Server(...)`.
   */
  registerServer(
    registry: RpcServerRegistry,
    server: TServer,
    options?: RpcExportCapabilityOptions,
  ): CapabilityPointer;
  /**
   * Type-only marker to preserve `TClient`/`TServer` across structural typing.
   */
  readonly [RPC_SERVICE_TOKEN_TYPE]?: [TClient, TServer];
}

/**
 * Options for {@link createRpcServiceToken}.
 */
export interface RpcServiceTokenCreateOptions<
  TClient extends object,
  TServer extends object = TClient,
> {
  interfaceId: bigint;
  interfaceName: string;
  bootstrapClient: RpcServiceToken<TClient, TServer>["bootstrapClient"];
  registerServer: RpcServiceToken<TClient, TServer>["registerServer"];
}

/**
 * Construct a frozen token object from generated bootstrap/register helpers.
 */
export function createRpcServiceToken<
  TClient extends object,
  TServer extends object = TClient,
>(
  options: RpcServiceTokenCreateOptions<TClient, TServer>,
): RpcServiceToken<TClient, TServer> {
  return Object.freeze({
    interfaceId: options.interfaceId,
    interfaceName: options.interfaceName,
    bootstrapClient: options.bootstrapClient,
    registerServer: options.registerServer,
  });
}

export {
  RpcPeer,
  type RpcPeerAddress,
  type RpcPeerOptions,
  type RpcServiceConstructor,
  type RpcServiceImplementation,
  type RpcStub,
  type RpcStubLifecycle,
  type TcpPort,
} from "./service_types.ts";

interface RpcConnectOptionsBase
  extends Omit<RpcWireClientOptions, "interfaceId"> {
  /**
   * Bootstrap call options forwarded to the generated bootstrap helper.
   */
  bootstrap?: RpcCallOptions;
}

/**
 * Options for {@link TCP.connect}.
 */
export interface TcpConnectOptions extends RpcConnectOptionsBase {
  /**
   * Low-level TCP transport options forwarded to {@link TcpTransport.connect}.
   */
  transport?: TcpTransportOptions;
}

/**
 * WebSocket URL input accepted by {@link WS.connect}.
 */
export type WebSocketUrl = string | URL;

/**
 * Options for {@link WS.connect}.
 */
export interface WebSocketConnectOptions extends RpcConnectOptionsBase {
  /**
   * Requested sub-protocol(s) for the WebSocket handshake.
   */
  protocols?: string | string[];
  /**
   * Low-level WebSocket transport options.
   */
  transport?: WebSocketTransportOptions;
}

/**
 * WebTransport URL input accepted by {@link WT.connect}.
 */
export type WebTransportUrl = string | URL;

/**
 * Options for {@link WT.connect}.
 */
export interface WebTransportConnectOptions extends RpcConnectOptionsBase {
  /**
   * Low-level WebTransport transport options.
   */
  transport?: WebTransportTransportConnectOptions;
}

/**
 * Options for {@link TCP.serve}.
 */
export interface TcpServeOptions {
  /**
   * Low-level TCP transport options for accepted connections.
   */
  transport?: TcpTransportOptions;
  /**
   * Runtime options forwarded to `RpcServerRuntime.createWithRoot()`.
   *
   * Root index/reference fields are controlled by dedicated options here.
   */
  runtime?: Omit<
    RpcServerRuntimeCreateWithRootOptions,
    "rootCapabilityIndex" | "rootReferenceCount"
  >;
  /**
   * Bootstrap root capability index (defaults to 0).
   */
  rootCapabilityIndex?: number;
  /**
   * Bootstrap root capability reference count (defaults to 1).
   */
  rootReferenceCount?: number;
  /**
   * Optional callback invoked when a single connection fails to initialize.
   */
  onConnectionError?: (error: unknown) => void | Promise<void>;
}

/**
 * Options for {@link WS.serve} and {@link WS.handler}.
 */
export interface WebSocketServeOptions {
  /**
   * Restrict accepted requests to this URL path (for example `"/rpc"`).
   */
  path?: string;
  /**
   * Supported sub-protocol(s). When configured, the request must include at
   * least one matching protocol or the upgrade is rejected with HTTP 426.
   */
  protocols?: string | readonly string[];
  /**
   * Low-level WebSocket transport options for accepted connections.
   */
  transport?: WebSocketTransportOptions;
  /**
   * Runtime options forwarded to `RpcServerRuntime.createWithRoot()`.
   *
   * Root index/reference fields are controlled by dedicated options here.
   */
  runtime?: Omit<
    RpcServerRuntimeCreateWithRootOptions,
    "rootCapabilityIndex" | "rootReferenceCount"
  >;
  /**
   * Bootstrap root capability index (defaults to 0).
   */
  rootCapabilityIndex?: number;
  /**
   * Bootstrap root capability reference count (defaults to 1).
   */
  rootReferenceCount?: number;
  /**
   * Optional callback invoked when a single connection fails to initialize.
   */
  onConnectionError?: (error: unknown) => void | Promise<void>;
}

/**
 * Options for {@link WT.serve}.
 */
export interface WebTransportServeOptions {
  /**
   * Restrict accepted sessions to this URL path (for example `"/rpc"`).
   */
  path?: string;
  /**
   * TLS certificate chain in PEM format for the QUIC listener.
   */
  cert: string;
  /**
   * TLS private key in PEM format for the QUIC listener.
   */
  key: string;
  /**
   * Additional QUIC listener options. `cert`, `key`, and `alpnProtocols` are
   * managed by the runtime.
   */
  quic?: Omit<Deno.QuicListenOptions, "cert" | "key" | "alpnProtocols">;
  /**
   * Additional QUIC accept options applied to each incoming connection.
   */
  accept?: Deno.QuicAcceptOptions<boolean>;
  /**
   * Low-level WebTransport transport options for accepted sessions.
   */
  transport?: WebTransportTransportAcceptOptions;
  /**
   * Runtime options forwarded to `RpcServerRuntime.createWithRoot()`.
   *
   * Root index/reference fields are controlled by dedicated options here.
   */
  runtime?: Omit<
    RpcServerRuntimeCreateWithRootOptions,
    "rootCapabilityIndex" | "rootReferenceCount"
  >;
  /**
   * Bootstrap root capability index (defaults to 0).
   */
  rootCapabilityIndex?: number;
  /**
   * Bootstrap root capability reference count (defaults to 1).
   */
  rootReferenceCount?: number;
  /**
   * Optional callback invoked when a single connection fails to initialize.
   */
  onConnectionError?: (error: unknown) => void | Promise<void>;
}

/**
 * Handle returned by {@link TCP.serve}.
 */
export interface TcpServeHandle {
  readonly listener: TcpTransportListener;
  readonly closed: boolean;
  close(): Promise<void>;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Handle returned by {@link WS.serve}.
 */
export interface WebSocketServeHandle {
  readonly addr: Deno.Addr;
  readonly closed: boolean;
  close(): Promise<void>;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Handle returned by {@link WT.serve}.
 */
export interface WebTransportServeHandle {
  readonly addr: Deno.NetAddr;
  readonly closed: boolean;
  close(): Promise<void>;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Request-level WebSocket RPC handler for composing inside a custom HTTP router.
 */
export interface WebSocketRequestHandler {
  readonly closed: boolean;
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}

function withStubLifecycle<TClient extends object>(
  client: TClient,
  close: () => Promise<void>,
): RpcStub<TClient> {
  return new Proxy(client as object, {
    get(target, prop, receiver) {
      if (prop === "close") return close;
      if (prop === Symbol.asyncDispose) return close;
      if (prop === Symbol.dispose) {
        return () => {
          void close();
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as RpcStub<TClient>;
}

/**
 * High-level TCP helpers for token-based generated services.
 */
export interface TcpServiceApi {
  connect<TClient extends object, TServer extends object = TClient>(
    service: RpcServiceToken<TClient, TServer>,
    hostname: string,
    port: TcpPort,
    options?: TcpConnectOptions,
  ): Promise<RpcStub<TClient>>;

  serve<TServer extends object, TClient extends object = TServer>(
    service: RpcServiceToken<TClient, TServer>,
    hostname: string,
    port: TcpPort,
    implementation: RpcServiceImplementation<TServer>,
    options?: TcpServeOptions,
  ): TcpServeHandle;
}

/**
 * High-level WebSocket helpers for token-based generated services.
 */
export interface WebSocketServiceApi {
  connect<TClient extends object, TServer extends object = TClient>(
    service: RpcServiceToken<TClient, TServer>,
    url: WebSocketUrl,
    options?: WebSocketConnectOptions,
  ): Promise<RpcStub<TClient>>;

  handler<TServer extends object, TClient extends object = TServer>(
    service: RpcServiceToken<TClient, TServer>,
    implementation: RpcServiceImplementation<TServer>,
    options?: WebSocketServeOptions,
  ): WebSocketRequestHandler;

  serve<TServer extends object, TClient extends object = TServer>(
    service: RpcServiceToken<TClient, TServer>,
    hostname: string,
    port: TcpPort,
    implementation: RpcServiceImplementation<TServer>,
    options?: WebSocketServeOptions,
  ): WebSocketServeHandle;
}

/**
 * High-level WebTransport helpers for token-based generated services.
 */
export interface WebTransportServiceApi {
  connect<TClient extends object, TServer extends object = TClient>(
    service: RpcServiceToken<TClient, TServer>,
    url: WebTransportUrl,
    options?: WebTransportConnectOptions,
  ): Promise<RpcStub<TClient>>;

  serve<TServer extends object, TClient extends object = TServer>(
    service: RpcServiceToken<TClient, TServer>,
    hostname: string,
    port: TcpPort,
    implementation: RpcServiceImplementation<TServer>,
    options: WebTransportServeOptions,
  ): WebTransportServeHandle;
}

async function bootstrapConnectedClient<
  TClient extends object,
  TServer extends object,
>(
  service: RpcServiceToken<TClient, TServer>,
  transport: RpcWireClient,
  bootstrap: RpcCallOptions | undefined,
): Promise<RpcStub<TClient>> {
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await transport.close();
  };

  try {
    const client = await service.bootstrapClient(transport, bootstrap);
    return withStubLifecycle(client, close);
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

/**
 * Connect a typed client to a remote TCP service.
 */
async function tcpConnect<
  TClient extends object,
  TServer extends object = TClient,
>(
  service: RpcServiceToken<TClient, TServer>,
  hostname: string,
  port: TcpPort,
  options: TcpConnectOptions = {},
): Promise<RpcStub<TClient>> {
  const { bootstrap, transport, ...clientOptions } = options;
  const resolvedPort = normalizeTcpPort(port);
  const tcp = await TcpTransport.connect(hostname, resolvedPort, transport);
  const clientTransport = new RpcWireClient(tcp, clientOptions);
  return bootstrapConnectedClient(service, clientTransport, bootstrap);
}

/**
 * Connect a typed client to a remote WebSocket service.
 */
async function wsConnect<
  TClient extends object,
  TServer extends object = TClient,
>(
  service: RpcServiceToken<TClient, TServer>,
  url: WebSocketUrl,
  options: WebSocketConnectOptions = {},
): Promise<RpcStub<TClient>> {
  const { bootstrap, protocols, transport, ...clientOptions } = options;
  const ws = await WebSocketTransport.connect(url, protocols, transport);
  const clientTransport = new RpcWireClient(ws, clientOptions);
  return bootstrapConnectedClient(service, clientTransport, bootstrap);
}

/**
 * Connect a typed client to a remote WebTransport service.
 */
async function wtConnect<
  TClient extends object,
  TServer extends object = TClient,
>(
  service: RpcServiceToken<TClient, TServer>,
  url: WebTransportUrl,
  options: WebTransportConnectOptions = {},
): Promise<RpcStub<TClient>> {
  const { bootstrap, transport, ...clientOptions } = options;
  const wt = await WebTransportTransport.connect(url, transport);
  const clientTransport = new RpcWireClient(wt, clientOptions);
  return bootstrapConnectedClient(service, clientTransport, bootstrap);
}

/**
 * Start serving a typed service implementation over TCP.
 */
function tcpServe<TServer extends object, TClient extends object = TServer>(
  service: RpcServiceToken<TClient, TServer>,
  hostname: string,
  port: TcpPort,
  implementation: RpcServiceImplementation<TServer>,
  options: TcpServeOptions = {},
): TcpServeHandle {
  const resolvedPort = normalizeTcpPort(port);
  return createTcpServeHandle(
    service as RpcServiceToken<object, TServer>,
    hostname,
    resolvedPort,
    implementation,
    options,
  );
}

/**
 * Start serving a typed service implementation over WebSocket.
 */
function wsServe<TServer extends object, TClient extends object = TServer>(
  service: RpcServiceToken<TClient, TServer>,
  hostname: string,
  port: TcpPort,
  implementation: RpcServiceImplementation<TServer>,
  options: WebSocketServeOptions = {},
): WebSocketServeHandle {
  const resolvedPort = normalizeTcpPort(port);
  return createWebSocketServeHandle(
    service as RpcServiceToken<object, TServer>,
    hostname,
    resolvedPort,
    implementation,
    options,
  );
}

/**
 * Build a request-level WebSocket RPC handler for custom HTTP routers.
 */
function wsHandler<TServer extends object, TClient extends object = TServer>(
  service: RpcServiceToken<TClient, TServer>,
  implementation: RpcServiceImplementation<TServer>,
  options: WebSocketServeOptions = {},
): WebSocketRequestHandler {
  return createWebSocketRequestHandler(
    service as RpcServiceToken<object, TServer>,
    implementation,
    options,
  );
}

/**
 * Start serving a typed service implementation over WebTransport.
 */
function wtServe<TServer extends object, TClient extends object = TServer>(
  service: RpcServiceToken<TClient, TServer>,
  hostname: string,
  port: TcpPort,
  implementation: RpcServiceImplementation<TServer>,
  options: WebTransportServeOptions,
): WebTransportServeHandle {
  const resolvedPort = normalizeTcpPort(port);
  return createWebTransportServeHandle(
    service as RpcServiceToken<object, TServer>,
    hostname,
    resolvedPort,
    implementation,
    options,
  );
}

/**
 * Public high-level TCP API for token-based generated services.
 */
export const TCP: TcpServiceApi = {
  connect: tcpConnect,
  serve: tcpServe,
};

/**
 * Public high-level WebSocket API for token-based generated services.
 */
export const WS: WebSocketServiceApi = {
  connect: wsConnect,
  handler: wsHandler,
  serve: wsServe,
};

/**
 * Public high-level WebTransport API for token-based generated services.
 */
export const WT: WebTransportServiceApi = {
  connect: wtConnect,
  serve: wtServe,
};
