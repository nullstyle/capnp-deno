import { SessionError } from "../../errors.ts";
import { WebTransportTransport } from "../transports/webtransport.ts";
import type {
  RpcServiceToken,
  WebTransportServeHandle,
  WebTransportServeOptions,
} from "./service.ts";
import {
  requireDenoQuicEndpoint,
  requireDenoUpgradeWebTransport,
  toWebTransportLocalAddress,
  toWebTransportRemoteAddress,
} from "./service_net.ts";
import { RpcServerRuntime } from "./runtime.ts";
import {
  type ActiveRuntime,
  closeActiveRuntime,
  reportConnectionError,
  resolveImplementationForConnection,
} from "./service_shared.ts";
import { RpcPeer, type RpcServiceImplementation } from "./service_types.ts";

class WebTransportServeHandleImpl<TServer extends object>
  implements WebTransportServeHandle {
  readonly #service: RpcServiceToken<object, TServer>;
  readonly #implementation: RpcServiceImplementation<TServer>;
  readonly #options: WebTransportServeOptions;
  readonly #endpoint: Deno.QuicEndpoint;
  readonly #listener: Deno.QuicListener;
  readonly #active = new Set<ActiveRuntime>();
  readonly #accepting = new Set<Promise<void>>();
  readonly #acceptLoop: Promise<void>;
  #closed = false;

  constructor(
    service: RpcServiceToken<object, TServer>,
    hostname: string,
    port: number,
    implementation: RpcServiceImplementation<TServer>,
    options: WebTransportServeOptions,
  ) {
    this.#service = service;
    this.#implementation = implementation;
    this.#options = options;
    const QuicEndpoint = requireDenoQuicEndpoint();
    this.#endpoint = new QuicEndpoint({ hostname, port });
    this.#listener = this.#endpoint.listen({
      ...(options.quic ?? {}),
      alpnProtocols: ["h3"],
      cert: options.cert,
      key: options.key,
    });
    this.#acceptLoop = this.#runAcceptLoop();
  }

  get addr(): Deno.NetAddr {
    return this.#endpoint.addr;
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

    try {
      this.#listener.stop();
    } catch {
      // no-op
    }

    const closeJobs = [...this.#active].map((entry) =>
      closeActiveRuntime(this.#active, entry)
    );
    const closeResults = await Promise.allSettled(closeJobs);

    try {
      this.#endpoint.close();
    } catch {
      // no-op
    }

    await this.#acceptLoop;
    const acceptResults = await Promise.allSettled([...this.#accepting]);

    const remainingCloseJobs = [...this.#active].map((entry) =>
      closeActiveRuntime(this.#active, entry)
    );
    const remainingCloseResults = await Promise.allSettled(remainingCloseJobs);
    this.#active.clear();

    const failure = [
      ...closeResults,
      ...acceptResults,
      ...remainingCloseResults,
    ].find((result) => result.status === "rejected");
    if (failure && failure.status === "rejected") {
      throw new SessionError("webtransport service close failed", {
        cause: failure.reason,
      });
    }
  }

  async #runAcceptLoop(): Promise<void> {
    while (!this.#closed) {
      let incoming: Deno.QuicIncoming;
      try {
        incoming = await this.#listener.incoming();
      } catch (error) {
        if (this.#closed) return;
        await reportConnectionError(this.#options.onConnectionError, error);
        continue;
      }
      this.#trackAcceptIncoming(incoming);
    }
  }

  #trackAcceptIncoming(incoming: Deno.QuicIncoming): void {
    const acceptJob = this.#acceptIncoming(incoming)
      .catch(async (error) => {
        if (this.#closed) return;
        await reportConnectionError(this.#options.onConnectionError, error);
      })
      .finally(() => {
        this.#accepting.delete(acceptJob);
      });
    this.#accepting.add(acceptJob);
  }

  async #acceptIncoming(incoming: Deno.QuicIncoming): Promise<void> {
    let conn: Deno.QuicConn;
    try {
      conn = await incoming.accept(this.#options.accept);
    } catch (error) {
      if (this.#closed) return;
      await reportConnectionError(this.#options.onConnectionError, error);
      return;
    }

    const upgradeWebTransport = requireDenoUpgradeWebTransport();
    let session: WebTransport & { url: string };
    try {
      session = await upgradeWebTransport(conn);
    } catch (error) {
      try {
        conn.close();
      } catch {
        // no-op
      }
      await reportConnectionError(this.#options.onConnectionError, error);
      return;
    }

    if (this.#closed) {
      try {
        session.close();
      } catch {
        // no-op
      }
      return;
    }

    const url = new URL(session.url);
    if (this.#options.path && url.pathname !== this.#options.path) {
      try {
        session.close({ reason: "webtransport path mismatch" });
      } catch {
        try {
          session.close();
        } catch {
          // no-op
        }
      }
      return;
    }

    const priorOnClose = this.#options.transport?.onClose;
    const priorOnError = this.#options.transport?.onError;
    let activeEntry: ActiveRuntime | null = null;
    let closedBeforeActive = false;
    let transport: WebTransportTransport;
    try {
      transport = await WebTransportTransport.accept(session, {
        ...(this.#options.transport ?? {}),
        onClose: () => {
          if (priorOnClose) {
            void Promise.resolve(priorOnClose()).catch((error) => {
              void reportConnectionError(
                this.#options.onConnectionError,
                error,
              );
            });
          }
          if (!activeEntry) {
            closedBeforeActive = true;
            return;
          }
          void closeActiveRuntime(this.#active, activeEntry).catch((error) => {
            void reportConnectionError(this.#options.onConnectionError, error);
          });
        },
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
    } catch (error) {
      try {
        session.close();
      } catch {
        // no-op
      }
      await reportConnectionError(this.#options.onConnectionError, error);
      return;
    }

    const peer = new RpcPeer({
      role: "server",
      transport,
      localAddress: toWebTransportLocalAddress(url),
      remoteAddress: toWebTransportRemoteAddress(conn.remoteAddr),
      id: `${conn.remoteAddr.hostname}:${conn.remoteAddr.port}`,
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
        try {
          await closeActiveRuntime(this.#active, activeEntry);
        } catch (error) {
          await reportConnectionError(this.#options.onConnectionError, error);
        }
      }
    } catch (error) {
      await transport.close().catch(() => {});
      await resolved.disposeInstance?.().catch(() => {});
      await reportConnectionError(this.#options.onConnectionError, error);
    }
  }
}

export function createWebTransportServeHandle<TServer extends object>(
  service: RpcServiceToken<object, TServer>,
  hostname: string,
  port: number,
  implementation: RpcServiceImplementation<TServer>,
  options: WebTransportServeOptions,
): WebTransportServeHandle {
  return new WebTransportServeHandleImpl(
    service,
    hostname,
    port,
    implementation,
    options,
  );
}
