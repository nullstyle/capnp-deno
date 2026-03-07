import { SessionError } from "../../errors.ts";
import { TcpTransport, type TcpTransportListener } from "../transports/tcp.ts";
import type {
  RpcServiceToken,
  TcpServeHandle,
  TcpServeOptions,
} from "./service.ts";
import { RpcServerRuntime } from "./runtime.ts";
import { toRpcPeerAddress } from "./service_net.ts";
import {
  type ActiveRuntime,
  closeActiveRuntime,
  reportConnectionError,
  resolveImplementationForConnection,
} from "./service_shared.ts";
import { RpcPeer, type RpcServiceImplementation } from "./service_types.ts";

class TcpServeHandleImpl<TServer extends object> implements TcpServeHandle {
  readonly listener: TcpTransportListener;

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
    this.listener = TcpTransport.listen({
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
      closeActiveRuntime(this.#active, entry)
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
      await reportConnectionError(this.#options.onConnectionError, error);
    }
  }

  async #acceptTransport(transport: TcpTransport): Promise<void> {
    const previousOnClose = transport.options.onClose;
    let activeEntry: ActiveRuntime | null = null;
    let closedBeforeActive = false;
    transport.options.onClose = () => {
      if (previousOnClose) {
        void Promise.resolve(previousOnClose()).catch((error) => {
          void reportConnectionError(this.#options.onConnectionError, error);
        });
      }
      if (!activeEntry) {
        closedBeforeActive = true;
        return;
      }
      void closeActiveRuntime(this.#active, activeEntry).catch((error) => {
        void reportConnectionError(this.#options.onConnectionError, error);
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

export function createTcpServeHandle<TServer extends object>(
  service: RpcServiceToken<object, TServer>,
  hostname: string,
  port: number,
  implementation: RpcServiceImplementation<TServer>,
  options: TcpServeOptions,
): TcpServeHandle {
  return new TcpServeHandleImpl(
    service,
    hostname,
    port,
    implementation,
    options,
  );
}
