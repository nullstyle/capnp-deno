import { SessionError } from "../../errors.ts";
import { WebSocketTransport } from "../transports/websocket.ts";
import type {
  RpcServiceToken,
  WebSocketRequestHandler,
  WebSocketServeHandle,
  WebSocketServeOptions,
} from "./service.ts";
import { requireDenoServe } from "./service_net.ts";
import {
  isWebSocketUpgradeRequest,
  resolveWebSocketProtocol,
  toWebSocketLocalAddress,
} from "./service_net.ts";
import { RpcServerRuntime } from "./runtime.ts";
import {
  type ActiveRuntime,
  closeActiveRuntime,
  reportConnectionError,
  resolveImplementationForConnection,
} from "./service_shared.ts";
import { RpcPeer, type RpcServiceImplementation } from "./service_types.ts";

class WebSocketRequestHandlerImpl<TServer extends object>
  implements WebSocketRequestHandler {
  readonly #service: RpcServiceToken<object, TServer>;
  readonly #implementation: RpcServiceImplementation<TServer>;
  readonly #options: WebSocketServeOptions;
  #closed = false;
  readonly #active = new Set<ActiveRuntime>();

  constructor(
    service: RpcServiceToken<object, TServer>,
    implementation: RpcServiceImplementation<TServer>,
    options: WebSocketServeOptions,
  ) {
    this.#service = service;
    this.#implementation = implementation;
    this.#options = options;
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

    const closeJobs = [...this.#active].map((entry) =>
      closeActiveRuntime(this.#active, entry)
    );
    const closeResults = await Promise.allSettled(closeJobs);
    this.#active.clear();

    const failure = closeResults.find((result) => result.status === "rejected");
    if (failure && failure.status === "rejected") {
      throw new SessionError("websocket service close failed", {
        cause: failure.reason,
      });
    }
  }

  async handle(request: Request): Promise<Response> {
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
      await reportConnectionError(this.#options.onConnectionError, error);
      return new Response("failed to upgrade websocket", { status: 400 });
    }

    void this.#acceptSocket(socket, request).catch((error) => {
      void reportConnectionError(this.#options.onConnectionError, error);
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
            void reportConnectionError(
              this.#options.onConnectionError,
              callbackError,
            );
          });
        }
        if (!activeEntry) {
          closedBeforeActive = true;
          return;
        }
        void closeActiveRuntime(this.#active, activeEntry).catch(
          (closeError) => {
            void reportConnectionError(
              this.#options.onConnectionError,
              closeError,
            );
          },
        );
      },
    });

    const peer = new RpcPeer({
      role: "server",
      transport,
      localAddress: toWebSocketLocalAddress(request),
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
        void closeActiveRuntime(this.#active, activeEntry).catch((error) => {
          void reportConnectionError(this.#options.onConnectionError, error);
        });
      }
    } catch (error) {
      await transport.close().catch(() => {});
      await resolved.disposeInstance?.().catch(() => {});
      await reportConnectionError(this.#options.onConnectionError, error);
    }
  }
}

class WebSocketServeHandleImpl<TServer extends object>
  implements WebSocketServeHandle {
  readonly #handler: WebSocketRequestHandlerImpl<TServer>;
  readonly #server: Deno.HttpServer<Deno.NetAddr>;
  #closed = false;

  constructor(
    service: RpcServiceToken<object, TServer>,
    hostname: string,
    port: number,
    implementation: RpcServiceImplementation<TServer>,
    options: WebSocketServeOptions,
  ) {
    this.#handler = new WebSocketRequestHandlerImpl(
      service,
      implementation,
      options,
    );
    this.#server = requireDenoServe()({
      hostname,
      port,
      onListen: () => {},
    }, (request) => this.#handler.handle(request));
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

    let closeError: unknown;
    try {
      await this.#handler.close();
    } catch (error) {
      closeError = error;
    }

    await this.#server.finished.catch(() => {});

    if (closeError !== undefined) {
      throw closeError;
    }
  }
}

export function createWebSocketRequestHandler<TServer extends object>(
  service: RpcServiceToken<object, TServer>,
  implementation: RpcServiceImplementation<TServer>,
  options: WebSocketServeOptions,
): WebSocketRequestHandler {
  return new WebSocketRequestHandlerImpl(service, implementation, options);
}

export function createWebSocketServeHandle<TServer extends object>(
  service: RpcServiceToken<object, TServer>,
  hostname: string,
  port: number,
  implementation: RpcServiceImplementation<TServer>,
  options: WebSocketServeOptions,
): WebSocketServeHandle {
  return new WebSocketServeHandleImpl(
    service,
    hostname,
    port,
    implementation,
    options,
  );
}
