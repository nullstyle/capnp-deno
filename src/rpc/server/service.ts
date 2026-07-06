/**
 * High-level token-based RPC service APIs.
 *
 * This module is the runtime contract for DX V2:
 * - generated code exports {@link RpcServiceToken} values,
 * - applications call generic {@link connect}, {@link serve}, and
 *   {@link serveConnection} helpers,
 * - runtime bridges tokens to existing transport/session primitives.
 *
 * @module
 */

import { annotateCapnpError, SessionError } from "../../errors.ts";
import {
  emitObservabilityEvent,
  type RpcObservability,
} from "../../observability/observability.ts";
import type { CapabilityPointer } from "../../encoding/runtime.ts";
import {
  createRpcDebugTracer,
  type RpcDebugSchemaMethod,
  type RpcDebugTracer,
  type RpcDebugTracerOptions,
} from "../diagnostics.ts";
import type {
  RpcBootstrapClientTransport,
  RpcCallOptions,
  RpcExportCapabilityOptions,
  RpcServerRegistry,
} from "./rpc_runtime.ts";
import {
  RpcServerRuntime,
  type RpcServerRuntimeCreateWithRootOptions,
} from "./runtime.ts";
import {
  RpcWireClient,
  type RpcWireClientOptions,
} from "../rpc_wire_client.ts";
import type {
  RpcAcceptedTransport,
  RpcTransportAcceptSource,
} from "../transports/internal/accept.ts";
import type { RpcTransport } from "../transports/internal/transport.ts";
import { TcpTransport } from "../transports/tcp.ts";
import { MiddlewareTransport } from "../transports/middleware/rpc_middleware.ts";
import { WebSocketTransport } from "../transports/websocket.ts";
import { WebTransportTransport } from "../transports/webtransport.ts";
import type { RpcServiceBinding, RpcStub } from "./service_types.ts";
import { RpcPeer } from "./service_types.ts";
import {
  reportConnectionError,
  resolveBindingForConnection,
} from "./service_shared.ts";

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
  /** Generated method metadata used by debug tracers, when available. */
  readonly methods?: readonly RpcDebugSchemaMethod[];
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
  methods?: readonly RpcDebugSchemaMethod[];
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
    ...(options.methods ? { methods: options.methods } : {}),
    bootstrapClient: options.bootstrapClient,
    registerServer: options.registerServer,
  });
}

export {
  RpcPeer,
  type RpcPeerAddress,
  type RpcPeerOptions,
  type RpcServiceBinding,
  type RpcServiceConstructor,
  type RpcServiceContext,
  type RpcServiceFactory,
  type RpcServiceImplementation,
  type RpcStub,
  type RpcStubLifecycle,
} from "./service_types.ts";

export type { RpcAcceptedTransport } from "../transports/internal/accept.ts";

export type RpcTransportAcceptor = RpcTransportAcceptSource;

/**
 * Options for generic typed service connections.
 */
export interface RpcServiceConnectOptions
  extends Omit<RpcWireClientOptions, "interfaceId"> {
  /**
   * Bootstrap call options forwarded to the generated bootstrap helper.
   */
  bootstrap?: RpcCallOptions;
  /**
   * Optional generated-RPC debug tracer or tracer options.
   */
  debug?: RpcDebugTracer | RpcDebugTracerOptions;
}

/**
 * Live statistics for a generated RPC service listener.
 *
 * @example
 * ```ts
 * const listener = TcpTransport.listen({ port: 4000 });
 * using handle = serve(Pinger, listener, new PingServer());
 * console.log(handle.stats.activeConnections);
 * ```
 */
export interface RpcServiceStats {
  /** Whether the service listener has been closed. */
  readonly closed: boolean;
  /** The number of currently active accepted connections. */
  readonly activeConnections: number;
  /** The number of connections accepted by this listener. */
  readonly acceptedConnections: number;
  /** The number of connections refused before runtime creation. */
  readonly refusedConnections: number;
  /** The configured active connection limit, when one is set. */
  readonly maxActiveConnections?: number;
}

/**
 * Options for generic typed service serving.
 */
export interface RpcServiceServeOptions {
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
  /**
   * Maximum number of active accepted connections to serve at once.
   *
   * Additional accepted transports are closed immediately and reported through
   * `onConnectionError` and observability.
   *
   * @example
   * ```ts
   * serve(Pinger, listener, new PingServer(), { maxActiveConnections: 128 });
   * ```
   */
  maxActiveConnections?: number;
  /**
   * Observability sink for service-level lifecycle events.
   *
   * @example
   * ```ts
   * serve(Pinger, listener, new PingServer(), {
   *   observability: { onEvent: (event) => console.log(event.name) },
   * });
   * ```
   */
  observability?: RpcObservability;
  /**
   * Optional generated-RPC debug tracer or tracer options.
   */
  debug?: RpcDebugTracer | RpcDebugTracerOptions;
}

/**
 * Generic handle returned by {@link serve}.
 */
export interface RpcServiceHandle {
  readonly closed: boolean;
  /**
   * Snapshot of listener or connection lifecycle statistics.
   */
  readonly stats: RpcServiceStats;
  close(): Promise<void>;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Handle returned by {@link serveConnection}.
 */
export interface RpcServiceConnectionHandle extends RpcServiceHandle {
  readonly peer: RpcPeer;
  readonly runtime: RpcServerRuntime;
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

function createPeerFromAcceptedTransport(
  accepted: RpcAcceptedTransport,
): RpcPeer {
  return new RpcPeer({
    role: "server",
    transport: accepted.transport,
    localAddress: accepted.localAddress ?? null,
    remoteAddress: accepted.remoteAddress ?? null,
    id: accepted.id,
  });
}

function isRpcDebugTracer(value: unknown): value is RpcDebugTracer {
  return !!value && typeof value === "object" &&
    "middleware" in value && "observability" in value &&
    "record" in value && "snapshot" in value && "clear" in value;
}

function resolveDebugTracer(
  debug: RpcDebugTracer | RpcDebugTracerOptions | undefined,
): RpcDebugTracer | null {
  if (!debug) return null;
  if (isRpcDebugTracer(debug)) return debug;
  return createRpcDebugTracer(debug);
}

function composeObservability(
  first: RpcObservability | undefined,
  second: RpcObservability | undefined,
): RpcObservability | undefined {
  if (!first) return second;
  if (!second) return first;
  return {
    onEvent(event) {
      emitObservabilityEvent(first, event);
      emitObservabilityEvent(second, event);
    },
  };
}

function wrapDebugTransport(
  transport: RpcTransport,
  tracer: RpcDebugTracer | null,
): RpcTransport {
  return tracer
    ? new MiddlewareTransport(transport, [tracer.middleware])
    : transport;
}

function recordServiceDebugEvent<
  TClient extends object,
  TServer extends object,
>(
  tracer: RpcDebugTracer | null,
  name: string,
  service: RpcServiceToken<TClient, TServer>,
  peer?: RpcPeer,
): void {
  if (!tracer) return;
  tracer.registerSchema?.(service.methods ?? []);
  tracer.record({
    timestampMs: Date.now(),
    kind: "observability",
    eventName: name,
    interfaceId: service.interfaceId,
    attributes: {
      "rpc.service_name": service.interfaceName,
      "rpc.interface_id": service.interfaceId,
      ...(peer
        ? {
          "rpc.peer_id": peer.id,
          "rpc.peer_role": peer.role,
        }
        : {}),
    },
  });
}

function runtimeOptionsWithDebug(
  runtime: RpcServiceServeOptions["runtime"] | undefined,
  tracer: RpcDebugTracer | null,
): RpcServiceServeOptions["runtime"] {
  if (!tracer) return runtime;
  const resolved = runtime ?? {};
  return {
    ...resolved,
    session: {
      ...(resolved.session ?? {}),
      observability: composeObservability(
        resolved.session?.observability,
        tracer.observability,
      ),
    },
    bridgeOptions: {
      ...(resolved.bridgeOptions ?? {}),
      observability: composeObservability(
        resolved.bridgeOptions?.observability,
        tracer.observability,
      ),
    },
  };
}

function attachTransportLifecycle(
  transport: RpcTransport,
  onClose: () => Promise<void>,
  onError: (error: unknown) => Promise<void>,
  report: ((error: unknown) => void | Promise<void>) | undefined,
): () => void {
  let detachTransportListeners = (): void => {};
  if (
    !(transport instanceof TcpTransport) &&
    !(transport instanceof WebSocketTransport) &&
    !(transport instanceof WebTransportTransport)
  ) {
    return detachTransportListeners;
  }

  const optionCarrier = transport as {
    options: {
      onClose?: () => void | Promise<void>;
      onError?: (error: unknown) => void | Promise<void>;
    };
  };
  const previousOnClose = optionCarrier.options.onClose;
  const previousOnError = optionCarrier.options.onError;

  optionCarrier.options.onClose = () => {
    if (previousOnClose) {
      void Promise.resolve(previousOnClose()).catch((error) => {
        void reportConnectionError(report, error);
      });
    }
    void onClose().catch((error) => {
      void reportConnectionError(report, error);
    });
  };

  optionCarrier.options.onError = (error) => {
    if (previousOnError) {
      void Promise.resolve(previousOnError(error)).catch((callbackError) => {
        void reportConnectionError(report, callbackError);
      });
    }
    void onError(error).catch((closeError) => {
      void reportConnectionError(report, closeError);
    });
  };

  if (transport instanceof WebSocketTransport) {
    const onSocketClose = (): void => {
      void onClose().catch((error) => {
        void reportConnectionError(report, error);
      });
    };
    if (transport.socket.readyState === WebSocket.CLOSED) {
      queueMicrotask(onSocketClose);
    } else {
      transport.socket.addEventListener("close", onSocketClose, { once: true });
      detachTransportListeners = (): void => {
        transport.socket.removeEventListener("close", onSocketClose);
      };
    }
  }

  return detachTransportListeners;
}

class RpcServiceConnectionHandleImpl implements RpcServiceConnectionHandle {
  readonly peer: RpcPeer;
  readonly runtime: RpcServerRuntime;

  readonly #disposeInstance: (() => Promise<void>) | null;
  readonly #onClosed: (() => void) | undefined;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(
    peer: RpcPeer,
    runtime: RpcServerRuntime,
    disposeInstance: (() => Promise<void>) | null,
    onClosed?: () => void,
  ) {
    this.peer = peer;
    this.runtime = runtime;
    this.#disposeInstance = disposeInstance;
    this.#onClosed = onClosed;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get stats(): RpcServiceStats {
    return {
      closed: this.#closed,
      activeConnections: this.#closed ? 0 : 1,
      acceptedConnections: 1,
      refusedConnections: 0,
    };
  }

  [Symbol.dispose](): void {
    void this.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = (async () => {
      if (this.#closed) return;
      this.#closed = true;
      try {
        await this.runtime.close();
      } finally {
        try {
          await this.#disposeInstance?.();
        } finally {
          this.#onClosed?.();
        }
      }
    })();
    return this.#closePromise;
  }
}

class RpcServiceHandleImpl<TServer extends object> implements RpcServiceHandle {
  readonly #service: RpcServiceToken<object, TServer>;
  readonly #acceptor: RpcTransportAcceptSource;
  readonly #implementation: RpcServiceBinding<TServer>;
  readonly #options: RpcServiceServeOptions;
  readonly #active = new Set<RpcServiceConnectionHandleImpl>();
  readonly #maxActiveConnections: number | undefined;
  readonly #tracer: RpcDebugTracer | null;
  readonly #observability: RpcObservability | undefined;
  readonly #connectionOptions: RpcServiceServeOptions;
  readonly #acceptLoop: Promise<void>;
  #acceptedConnections = 0;
  #refusedConnections = 0;
  #closed = false;

  constructor(
    service: RpcServiceToken<object, TServer>,
    acceptor: RpcTransportAcceptSource,
    implementation: RpcServiceBinding<TServer>,
    options: RpcServiceServeOptions,
  ) {
    this.#service = service;
    this.#acceptor = acceptor;
    this.#implementation = implementation;
    this.#options = options;
    this.#maxActiveConnections = normalizeMaxActiveConnections(
      options.maxActiveConnections,
      service,
    );
    this.#tracer = resolveDebugTracer(options.debug);
    this.#observability = composeObservability(
      options.observability,
      this.#tracer?.observability,
    );
    this.#connectionOptions = {
      ...options,
      ...(this.#tracer ? { debug: this.#tracer } : {}),
      observability: this.#observability,
    };
    this.#acceptLoop = this.#runAcceptLoop();
  }

  get closed(): boolean {
    return this.#closed;
  }

  get stats(): RpcServiceStats {
    const stats = {
      closed: this.#closed,
      activeConnections: this.#active.size,
      acceptedConnections: this.#acceptedConnections,
      refusedConnections: this.#refusedConnections,
    };
    return this.#maxActiveConnections === undefined
      ? stats
      : { ...stats, maxActiveConnections: this.#maxActiveConnections };
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

    const closeResults = await Promise.allSettled(
      [...this.#active].map((handle) => handle.close()),
    );
    this.#active.clear();

    await Promise.resolve(this.#acceptor.close()).catch(() => {});
    await this.#acceptLoop;

    const failure = closeResults.find((result) => result.status === "rejected");
    if (failure && failure.status === "rejected") {
      throw new SessionError("rpc service close failed", {
        cause: failure.reason,
      });
    }
  }

  async #runAcceptLoop(): Promise<void> {
    try {
      for await (const accepted of this.#acceptor.accept()) {
        if (this.#closed) {
          await Promise.resolve(accepted.transport.close()).catch(() => {});
          continue;
        }
        if (this.#shouldRefuseConnection()) {
          await this.#refuseConnection(accepted);
          continue;
        }
        await this.#acceptConnection(accepted);
      }
    } catch (error) {
      if (this.#closed) return;
      await reportConnectionError(this.#options.onConnectionError, error);
    }
  }

  #shouldRefuseConnection(): boolean {
    return this.#maxActiveConnections !== undefined &&
      this.#active.size >= this.#maxActiveConnections;
  }

  async #refuseConnection(accepted: RpcAcceptedTransport): Promise<void> {
    this.#refusedConnections++;
    const error = new SessionError(
      `generated RPC service ${this.#service.interfaceName} refused a connection: active connection limit ${this.#maxActiveConnections} reached`,
      {
        metadata: {
          phase: "service_serve",
          serviceName: this.#service.interfaceName,
          interfaceId: this.#service.interfaceId,
          peerId: accepted.id,
          transport: accepted.remoteAddress?.transport ??
            accepted.localAddress?.transport,
        },
      },
    );
    emitObservabilityEvent(this.#observability, {
      name: "rpc.service.connection_refused",
      attributes: {
        "rpc.service_name": this.#service.interfaceName,
        "rpc.interface_id": this.#service.interfaceId,
        "rpc.active_connections": this.#active.size,
        ...(this.#maxActiveConnections === undefined
          ? {}
          : { "rpc.max_active_connections": this.#maxActiveConnections }),
        ...(accepted.id ? { "rpc.peer_id": accepted.id } : {}),
      },
      error,
    });
    await reportConnectionError(this.#options.onConnectionError, error);
    await Promise.resolve(accepted.transport.close()).catch((closeError) =>
      reportConnectionError(this.#options.onConnectionError, closeError)
    );
  }

  async #acceptConnection(accepted: RpcAcceptedTransport): Promise<void> {
    let handle: RpcServiceConnectionHandleImpl | null = null;
    this.#acceptedConnections++;
    emitObservabilityEvent(this.#observability, {
      name: "rpc.service.connection_accepted",
      attributes: {
        "rpc.service_name": this.#service.interfaceName,
        "rpc.interface_id": this.#service.interfaceId,
        "rpc.active_connections": this.#active.size + 1,
        ...(this.#maxActiveConnections === undefined
          ? {}
          : { "rpc.max_active_connections": this.#maxActiveConnections }),
        ...(accepted.id ? { "rpc.peer_id": accepted.id } : {}),
      },
    });
    handle = await createServiceConnectionHandle(
      this.#service,
      accepted,
      this.#implementation,
      this.#connectionOptions,
      () => {
        if (handle) {
          this.#active.delete(handle);
        }
      },
    ).catch(async (error) => {
      await reportConnectionError(this.#options.onConnectionError, error);
      return null;
    });
    if (!handle || handle.closed) return;
    this.#active.add(handle);
    if (this.#closed) {
      void handle.close().catch((error) => {
        void reportConnectionError(this.#options.onConnectionError, error);
      });
    }
  }
}

function normalizeMaxActiveConnections(
  value: number | undefined,
  service: Pick<
    RpcServiceToken<object, object>,
    "interfaceId" | "interfaceName"
  >,
): number | undefined {
  if (value === undefined) return undefined;
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new SessionError(
    "maxActiveConnections must be a positive safe integer",
    {
      metadata: {
        phase: "service_serve",
        serviceName: service.interfaceName,
        interfaceId: service.interfaceId,
      },
    },
  );
}

async function createServiceConnectionHandle<
  TClient extends object,
  TServer extends object,
>(
  service: RpcServiceToken<TClient, TServer>,
  accepted: RpcAcceptedTransport,
  implementation: RpcServiceBinding<TServer>,
  options: RpcServiceServeOptions = {},
  onClosed?: () => void,
): Promise<RpcServiceConnectionHandleImpl> {
  const peer = createPeerFromAcceptedTransport(accepted);
  const tracer = resolveDebugTracer(options.debug);
  recordServiceDebugEvent(
    tracer,
    "rpc.service.serve_connection",
    service,
    peer,
  );
  let handle: RpcServiceConnectionHandleImpl | null = null;
  let closedBeforeActive = false;
  const detachTransportLifecycle = attachTransportLifecycle(
    accepted.transport,
    async () => {
      if (!handle) {
        closedBeforeActive = true;
        return;
      }
      await handle.close();
    },
    async () => {
      if (!handle) {
        closedBeforeActive = true;
        return;
      }
      await handle.close();
    },
    options.onConnectionError,
  );

  let resolved:
    | Awaited<ReturnType<typeof resolveBindingForConnection<TServer>>>
    | null = null;
  try {
    resolved = await resolveBindingForConnection(implementation, peer);
    if (closedBeforeActive) {
      throw new SessionError(
        "rpc service connection closed during initialization",
      );
    }
    const runtime = await RpcServerRuntime.createWithRoot(
      wrapDebugTransport(accepted.transport, tracer),
      (registry, server, rootOptions) =>
        service.registerServer(registry, server, rootOptions),
      resolved.server,
      {
        ...(runtimeOptionsWithDebug(options.runtime, tracer) ?? {}),
        rootCapabilityIndex: options.rootCapabilityIndex,
        rootReferenceCount: options.rootReferenceCount,
      },
    );
    handle = new RpcServiceConnectionHandleImpl(
      peer,
      runtime,
      resolved.disposeInstance,
      onClosed,
    );
    if (closedBeforeActive) {
      await handle.close().catch((error) => {
        void reportConnectionError(options.onConnectionError, error);
      });
    }
    detachTransportLifecycle();
    return handle;
  } catch (error) {
    detachTransportLifecycle();
    await Promise.resolve(accepted.transport.close()).catch(() => {});
    await resolved?.disposeInstance?.().catch(() => {});
    throw annotateCapnpError(error, {
      phase: "service_serve",
      serviceName: service.interfaceName,
      interfaceId: service.interfaceId,
      peerId: peer.id,
    }, `serve(${service.interfaceName}) failed`);
  }
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
    throw annotateCapnpError(error, {
      phase: "service_connect",
      serviceName: service.interfaceName,
      interfaceId: service.interfaceId,
    }, `connect(${service.interfaceName}) failed`);
  }
}

/**
 * Connect a typed client to a started RPC transport.
 *
 * @param service - Generated service token for the target interface.
 * @param transport - Started transport to bootstrap over.
 * @param options - Client bootstrap and wire-client options.
 * @returns A typed stub with lifecycle helpers attached.
 * @example
 * ```ts
 * const transport = await TcpTransport.connect("127.0.0.1", 4000);
 * using client = await connect(Pinger, transport);
 * ```
 */
export function connect<
  TClient extends object,
  TServer extends object = TClient,
>(
  service: RpcServiceToken<TClient, TServer>,
  transport: RpcTransport,
  options: RpcServiceConnectOptions = {},
): Promise<RpcStub<TClient>> {
  const { bootstrap, debug, observability, ...clientOptions } = options;
  const tracer = resolveDebugTracer(debug);
  recordServiceDebugEvent(tracer, "rpc.service.connect", service);
  const clientTransport = new RpcWireClient(
    wrapDebugTransport(transport, tracer),
    {
      ...clientOptions,
      observability: composeObservability(observability, tracer?.observability),
    },
  );
  return bootstrapConnectedClient(service, clientTransport, bootstrap);
}

/**
 * Bind a single accepted transport to a service runtime.
 *
 * @param service - Generated service token for the target interface.
 * @param accepted - Accepted transport plus peer metadata.
 * @param implementation - Service instance, constructor, or connection factory.
 * @param options - Runtime and bootstrap root configuration.
 * @returns A managed per-connection runtime handle.
 * @example
 * ```ts
 * const accepted = {
 *   transport,
 *   localAddress: { transport: "tcp", hostname: "127.0.0.1", port: 4000 },
 *   remoteAddress: { transport: "tcp", hostname: "127.0.0.1", port: 41234 },
 * };
 * using handle = await serveConnection(Pinger, accepted, ({ peer }) =>
 *   new PingServer(peer)
 * );
 * ```
 */
export function serveConnection<
  TServer extends object,
  TClient extends object = TServer,
>(
  service: RpcServiceToken<TClient, TServer>,
  accepted: RpcAcceptedTransport,
  implementation: RpcServiceBinding<TServer>,
  options: RpcServiceServeOptions = {},
): Promise<RpcServiceConnectionHandle> {
  return createServiceConnectionHandle(
    service,
    accepted,
    implementation,
    options,
  );
}

/**
 * Serve a typed RPC service over an accepted-transport source.
 *
 * @param service - Generated service token for the target interface.
 * @param acceptor - Accepted-transport source that yields server connections.
 * @param implementation - Service instance, constructor, or connection factory.
 * @param options - Runtime and bootstrap root configuration.
 * @returns A managed service handle that closes all active runtimes.
 * @example
 * ```ts
 * const listener = TcpTransport.listen({ hostname: "127.0.0.1", port: 4000 });
 * using handle = serve(Pinger, listener, ({ peer }) => new PingServer(peer));
 * ```
 */
export function serve<
  TServer extends object,
  TClient extends object = TServer,
>(
  service: RpcServiceToken<TClient, TServer>,
  acceptor: RpcTransportAcceptSource,
  implementation: RpcServiceBinding<TServer>,
  options: RpcServiceServeOptions = {},
): RpcServiceHandle {
  return new RpcServiceHandleImpl(
    service as RpcServiceToken<object, TServer>,
    acceptor,
    implementation,
    options,
  );
}
