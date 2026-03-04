/**
 * High-level token-based RPC service APIs.
 *
 * This module is the runtime contract for DX V2:
 * - generated code exports {@link RpcServiceToken} values,
 * - applications call {@link TCP.connect} / {@link TCP.serve} or
 *   {@link WS.connect} / {@link WS.serve},
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
import { SessionError } from "../../errors.ts";
import {
  RpcServerRuntime,
  type RpcServerRuntimeCreateWithRootOptions,
} from "./runtime.ts";
import type { RpcTransport } from "../transports/transport.ts";
import {
  TcpRpcClientTransport,
  type TcpRpcClientTransportOptions,
} from "../transports/tcp_rpc_client.ts";
import {
  TcpServerListener,
  type TcpTransport,
  type TcpTransportOptions,
} from "../transports/tcp.ts";
import {
  WebSocketTransport,
  type WebSocketTransportOptions,
} from "../transports/websocket.ts";

const MIN_TCP_PORT = 1;
const MAX_TCP_PORT = 65_535;

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

/**
 * Small peer descriptor passed to per-connection server constructors.
 */
export interface RpcPeerOptions {
  role: "client" | "server";
  transport: RpcTransport;
  localAddress?: RpcPeerAddress | null;
  remoteAddress?: RpcPeerAddress | null;
  id?: string;
}

/**
 * Normalized address metadata for a connected peer.
 */
export interface RpcPeerAddress {
  transport?: string;
  hostname?: string;
  port?: number;
  path?: string;
}

/**
 * Connection-scoped peer handle for high-level server constructors.
 */
export class RpcPeer {
  readonly role: RpcPeerOptions["role"];
  readonly transport: RpcTransport;
  readonly localAddress: RpcPeerAddress | null;
  readonly remoteAddress: RpcPeerAddress | null;
  readonly id: string;

  constructor(options: RpcPeerOptions) {
    this.role = options.role;
    this.transport = options.transport;
    this.localAddress = options.localAddress ?? null;
    this.remoteAddress = options.remoteAddress ?? null;
    this.id = options.id ??
      `${options.role}:${formatPeerAddress(options.remoteAddress ?? null)}`;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  [Symbol.dispose](): void {
    void this.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  toString(): string {
    return `[RpcPeer ${this.id}]`;
  }
}

/**
 * Common lifecycle contract mixed into returned client stubs.
 */
export interface RpcStubLifecycle {
  close(): Promise<void>;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Typed RPC client stub + disposal lifecycle.
 */
export type RpcStub<TClient extends object> = TClient & RpcStubLifecycle;

/**
 * TCP port input accepted by {@link TCP.connect} / {@link TCP.serve} and
 * {@link WS.serve}.
 */
export type TcpPort = number | string;

interface RpcConnectOptionsBase
  extends Omit<TcpRpcClientTransportOptions, "interfaceId"> {
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
   * Low-level TCP transport options forwarded to {@link TcpRpcClientTransport.connect}.
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
 * Constructable server implementation type.
 *
 * A new instance is created per accepted connection.
 */
export type RpcServiceConstructor<TServer extends object> = new (
  peer: RpcPeer,
) => TServer;

/**
 * Accepted server implementation input for {@link TCP.serve}.
 */
export type RpcServiceImplementation<TServer extends object> =
  | TServer
  | RpcServiceConstructor<TServer>;

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
 * Options for {@link WS.serve}.
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
 * Handle returned by {@link TCP.serve}.
 */
export interface TcpServeHandle {
  readonly listener: TcpServerListener;
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

interface ActiveRuntime {
  runtime: RpcServerRuntime;
  disposeInstance: (() => Promise<void>) | null;
}

class TcpServeHandleImpl<TServer extends object> implements TcpServeHandle {
  readonly listener: TcpServerListener;

  readonly #service: RpcServiceToken<object, TServer>;
  readonly #implementation: RpcServiceImplementation<TServer>;
  readonly #options: TcpServeOptions;
  #closed = false;
  #acceptLoop: Promise<void>;
  readonly #active = new Set<ActiveRuntime>();

  constructor(
    service: RpcServiceToken<object, TServer>,
    hostname: string,
    port: number,
    implementation: RpcServiceImplementation<TServer>,
    options: TcpServeOptions,
  ) {
    this.#service = service;
    this.#implementation = implementation;
    this.#options = options;
    this.listener = new TcpServerListener({
      hostname,
      port,
      transportOptions: options.transport,
    });
    this.#acceptLoop = this.#runAcceptLoop();
  }

  get closed(): boolean {
    return this.#closed;
  }

  [Symbol.dispose](): void {
    void this.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.listener.close();

    const closeJobs = [...this.#active].map((entry) =>
      this.#closeActive(entry)
    );
    const closeResults = await Promise.allSettled(closeJobs);
    this.#active.clear();

    await this.#acceptLoop;

    const failure = closeResults.find((result) => result.status === "rejected");
    if (failure && failure.status === "rejected") {
      throw new SessionError("tcp service close failed", {
        cause: failure.reason,
      });
    }
  }

  async #runAcceptLoop(): Promise<void> {
    try {
      for await (const transport of this.listener.accept()) {
        if (this.#closed) {
          await transport.close().catch(() => {});
          continue;
        }
        await this.#acceptTransport(transport);
      }
    } catch (error) {
      if (this.#closed) return;
      await this.#reportConnectionError(error);
    }
  }

  async #acceptTransport(
    transport: TcpTransport,
  ): Promise<void> {
    const previousOnClose = transport.options.onClose;
    let activeEntry: ActiveRuntime | null = null;
    let closedBeforeActive = false;
    transport.options.onClose = () => {
      if (previousOnClose) {
        void Promise.resolve(previousOnClose()).catch((error) => {
          void this.#reportConnectionError(error);
        });
      }
      if (!activeEntry) {
        closedBeforeActive = true;
        return;
      }
      void this.#closeActive(activeEntry).catch((error) => {
        void this.#reportConnectionError(error);
      });
    };

    const peer = new RpcPeer({
      role: "server",
      transport,
      localAddress: toRpcPeerAddress(transport.conn.localAddr),
      remoteAddress: toRpcPeerAddress(transport.conn.remoteAddr),
    });
    const resolved = resolveImplementationForConnection(
      this.#implementation,
      peer,
    );

    try {
      const runtime = await RpcServerRuntime.createWithRoot(
        transport,
        (registry, server, rootOptions) =>
          this.#service.registerServer(registry, server, rootOptions),
        resolved.server,
        {
          ...(this.#options.runtime ?? {}),
          rootCapabilityIndex: this.#options.rootCapabilityIndex,
          rootReferenceCount: this.#options.rootReferenceCount,
        },
      );
      activeEntry = {
        runtime,
        disposeInstance: resolved.disposeInstance,
      };
      this.#active.add(activeEntry);
      if (closedBeforeActive) {
        void this.#closeActive(activeEntry).catch((error) => {
          void this.#reportConnectionError(error);
        });
      }
    } catch (error) {
      await transport.close().catch(() => {});
      await resolved.disposeInstance?.().catch(() => {});
      await this.#reportConnectionError(error);
    }
  }

  async #closeActive(entry: ActiveRuntime): Promise<void> {
    if (!this.#active.has(entry)) return;
    this.#active.delete(entry);
    try {
      await entry.runtime.close();
    } finally {
      await entry.disposeInstance?.();
    }
  }

  async #reportConnectionError(error: unknown): Promise<void> {
    const report = this.#options.onConnectionError;
    if (!report) return;
    try {
      await report(error);
    } catch {
      // Errors in the error callback must not destabilize the accept loop.
    }
  }
}

class WebSocketServeHandleImpl<TServer extends object>
  implements WebSocketServeHandle {
  readonly #service: RpcServiceToken<object, TServer>;
  readonly #implementation: RpcServiceImplementation<TServer>;
  readonly #options: WebSocketServeOptions;
  readonly #hostname: string;
  readonly #port: number;
  readonly #server: Deno.HttpServer<Deno.NetAddr>;
  #closed = false;
  readonly #active = new Set<ActiveRuntime>();

  constructor(
    service: RpcServiceToken<object, TServer>,
    hostname: string,
    port: number,
    implementation: RpcServiceImplementation<TServer>,
    options: WebSocketServeOptions,
  ) {
    this.#service = service;
    this.#implementation = implementation;
    this.#options = options;
    this.#hostname = hostname;
    this.#port = port;
    this.#server = requireDenoServe()({
      hostname,
      port,
      onListen: () => {},
    }, (request) => this.#handleRequest(request));
  }

  get addr(): Deno.Addr {
    return this.#server.addr;
  }

  get closed(): boolean {
    return this.#closed;
  }

  [Symbol.dispose](): void {
    void this.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    await this.#server.shutdown().catch(() => {});

    const closeJobs = [...this.#active].map((entry) =>
      this.#closeActive(entry)
    );
    const closeResults = await Promise.allSettled(closeJobs);
    this.#active.clear();

    await this.#server.finished.catch(() => {});

    const failure = closeResults.find((result) => result.status === "rejected");
    if (failure && failure.status === "rejected") {
      throw new SessionError("websocket service close failed", {
        cause: failure.reason,
      });
    }
  }

  async #handleRequest(request: Request): Promise<Response> {
    if (this.#closed) {
      return new Response("service is closed", { status: 503 });
    }

    if (!isWebSocketUpgradeRequest(request)) {
      return new Response("websocket upgrade required", { status: 426 });
    }

    if (this.#options.path) {
      const url = new URL(request.url);
      if (url.pathname !== this.#options.path) {
        return new Response("not found", { status: 404 });
      }
    }

    const selectedProtocol = resolveWebSocketProtocol(
      request,
      this.#options.protocols,
    );
    if (selectedProtocol === null) {
      return new Response("websocket protocol mismatch", { status: 426 });
    }

    let socket: WebSocket;
    let response: Response;
    try {
      ({ socket, response } = selectedProtocol === undefined
        ? Deno.upgradeWebSocket(request)
        : Deno.upgradeWebSocket(request, { protocol: selectedProtocol }));
    } catch (error) {
      await this.#reportConnectionError(error);
      return new Response("failed to upgrade websocket", { status: 400 });
    }

    void this.#acceptSocket(socket, request).catch((error) => {
      void this.#reportConnectionError(error);
    });
    return response;
  }

  async #acceptSocket(socket: WebSocket, request: Request): Promise<void> {
    if (this.#closed) {
      try {
        socket.close();
      } catch {
        // no-op
      }
      return;
    }

    const priorOnError = this.#options.transport?.onError;
    let activeEntry: ActiveRuntime | null = null;
    let closedBeforeActive = false;
    const transport = new WebSocketTransport(socket, {
      ...(this.#options.transport ?? {}),
      onError: (error) => {
        if (priorOnError) {
          void Promise.resolve(priorOnError(error)).catch((callbackError) => {
            void this.#reportConnectionError(callbackError);
          });
        }
        if (!activeEntry) {
          closedBeforeActive = true;
          return;
        }
        void this.#closeActive(activeEntry).catch((closeError) => {
          void this.#reportConnectionError(closeError);
        });
      },
    });

    const url = new URL(request.url);
    const peer = new RpcPeer({
      role: "server",
      transport,
      localAddress: {
        transport: "websocket",
        hostname: this.#hostname,
        port: this.#port,
        path: url.pathname,
      },
      remoteAddress: {
        transport: "websocket",
      },
      id: request.headers.get("sec-websocket-key") ?? undefined,
    });
    const resolved = resolveImplementationForConnection(
      this.#implementation,
      peer,
    );

    try {
      const runtime = await RpcServerRuntime.createWithRoot(
        transport,
        (registry, server, rootOptions) =>
          this.#service.registerServer(registry, server, rootOptions),
        resolved.server,
        {
          ...(this.#options.runtime ?? {}),
          rootCapabilityIndex: this.#options.rootCapabilityIndex,
          rootReferenceCount: this.#options.rootReferenceCount,
        },
      );
      activeEntry = {
        runtime,
        disposeInstance: resolved.disposeInstance,
      };
      this.#active.add(activeEntry);
      if (closedBeforeActive || this.#closed) {
        void this.#closeActive(activeEntry).catch((error) => {
          void this.#reportConnectionError(error);
        });
      }
    } catch (error) {
      await transport.close().catch(() => {});
      await resolved.disposeInstance?.().catch(() => {});
      await this.#reportConnectionError(error);
    }
  }

  async #closeActive(entry: ActiveRuntime): Promise<void> {
    if (!this.#active.has(entry)) return;
    this.#active.delete(entry);
    try {
      await entry.runtime.close();
    } finally {
      await entry.disposeInstance?.();
    }
  }

  async #reportConnectionError(error: unknown): Promise<void> {
    const report = this.#options.onConnectionError;
    if (!report) return;
    try {
      await report(error);
    } catch {
      // Errors in the error callback must not destabilize request handling.
    }
  }
}

function resolveImplementationForConnection<TServer extends object>(
  implementation: RpcServiceImplementation<TServer>,
  peer: RpcPeer,
): { server: TServer; disposeInstance: (() => Promise<void>) | null } {
  if (typeof implementation === "function") {
    const Ctor = implementation as RpcServiceConstructor<TServer>;
    const server = new Ctor(peer);
    return { server, disposeInstance: toDisposer(server) };
  }
  return { server: implementation, disposeInstance: null };
}

function toDisposer(instance: unknown): (() => Promise<void>) | null {
  if (instance && typeof instance === "object") {
    if (Symbol.asyncDispose in instance) {
      const asyncDispose = (instance as AsyncDisposable)[Symbol.asyncDispose];
      if (typeof asyncDispose === "function") {
        return async () => {
          await asyncDispose.call(instance as AsyncDisposable);
        };
      }
    }
    if (Symbol.dispose in instance) {
      const dispose = (instance as Disposable)[Symbol.dispose];
      if (typeof dispose === "function") {
        return () =>
          new Promise<void>((resolve, reject) => {
            try {
              dispose.call(instance as Disposable);
              resolve();
            } catch (error) {
              reject(error);
            }
          });
      }
    }
  }
  return null;
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

function formatPeerAddress(address: RpcPeerAddress | null): string {
  if (!address) return "unknown";
  if (address.hostname && address.port !== undefined) {
    return `${address.hostname}:${address.port}`;
  }
  if (address.path) return address.path;
  return "unknown";
}

function toRpcPeerAddress(input: unknown): RpcPeerAddress | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Record<string, unknown>;
  const address: RpcPeerAddress = {};

  if (typeof candidate.transport === "string") {
    address.transport = candidate.transport;
  }
  if (typeof candidate.hostname === "string") {
    address.hostname = candidate.hostname;
  }
  if (typeof candidate.port === "number" && Number.isFinite(candidate.port)) {
    address.port = candidate.port;
  }
  if (typeof candidate.path === "string") {
    address.path = candidate.path;
  }

  if (
    address.transport === undefined &&
    address.hostname === undefined &&
    address.port === undefined &&
    address.path === undefined
  ) {
    return null;
  }
  return address;
}

function requireDenoServe(): typeof Deno.serve {
  const maybeServe = (Deno as unknown as { serve?: typeof Deno.serve }).serve;
  if (typeof maybeServe !== "function") {
    throw new SessionError(
      "Deno.serve is unavailable; run with a runtime that supports HTTP/WebSocket serve",
    );
  }
  return maybeServe;
}

function isWebSocketUpgradeRequest(request: Request): boolean {
  const upgrade = request.headers.get("upgrade");
  return typeof upgrade === "string" && upgrade.toLowerCase() === "websocket";
}

function parseRequestedWebSocketProtocols(request: Request): string[] {
  const raw = request.headers.get("sec-websocket-protocol");
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function resolveWebSocketProtocol(
  request: Request,
  supported: string | readonly string[] | undefined,
): string | null | undefined {
  if (supported === undefined) return undefined;
  const supportedList = typeof supported === "string" ? [supported] : [
    ...supported,
  ];
  if (supportedList.length === 0) return undefined;

  const requested = parseRequestedWebSocketProtocols(request);
  if (requested.length === 0) return null;
  for (const candidate of requested) {
    if (supportedList.includes(candidate)) {
      return candidate;
    }
  }
  return null;
}

function normalizeTcpPort(port: TcpPort): number {
  const resolved = Number(port);
  if (
    !Number.isInteger(resolved) ||
    resolved < MIN_TCP_PORT ||
    resolved > MAX_TCP_PORT
  ) {
    throw new SessionError(
      `port must be an integer in [${MIN_TCP_PORT}, ${MAX_TCP_PORT}], got ${
        String(port)
      }`,
    );
  }
  return resolved;
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

  serve<TServer extends object, TClient extends object = TServer>(
    service: RpcServiceToken<TClient, TServer>,
    hostname: string,
    port: TcpPort,
    implementation: RpcServiceImplementation<TServer>,
    options?: WebSocketServeOptions,
  ): WebSocketServeHandle;
}

async function bootstrapConnectedClient<
  TClient extends object,
  TServer extends object,
>(
  service: RpcServiceToken<TClient, TServer>,
  transport: TcpRpcClientTransport,
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
  const clientTransport = await TcpRpcClientTransport.connect(
    hostname,
    resolvedPort,
    {
      ...clientOptions,
      transport,
    },
  );
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
  const clientTransport = new TcpRpcClientTransport(ws, clientOptions);
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
  return new TcpServeHandleImpl(
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
  return new WebSocketServeHandleImpl(
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
  serve: wsServe,
};
