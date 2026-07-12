import type { RpcTransport } from "../transports/internal/transport.ts";
import { formatPeerAddress } from "./service_net.ts";

/**
 * Options for constructing an {@link RpcPeer}.
 */
export interface RpcPeerOptions {
  /** Whether this side of the connection acts as the client or the server. */
  role: "client" | "server";
  /** The started transport carrying frames for this connection. */
  transport: RpcTransport;
  /** Local endpoint address metadata, when known. */
  localAddress?: RpcPeerAddress | null;
  /** Remote endpoint address metadata, when known. */
  remoteAddress?: RpcPeerAddress | null;
  /**
   * Stable identifier for the peer. Derived from the role and remote address
   * when omitted.
   */
  id?: string;
}

/**
 * Address metadata describing one endpoint of an RPC connection.
 */
export interface RpcPeerAddress {
  /** Transport kind, for example `"tcp"`, `"websocket"`, or `"messageport"`. */
  transport?: string;
  /** Hostname or IP address for network transports. */
  hostname?: string;
  /** Port number for network transports. */
  port?: number;
  /** URL path or channel name for path-addressed transports. */
  path?: string;
}

/**
 * Connection metadata handed to service factories and high-level connectors.
 *
 * An `RpcPeer` pairs the accepted transport with role and address metadata so
 * service implementations can identify the remote endpoint and close the
 * underlying transport when finished. Instances support `using` and
 * `await using` disposal, which closes the transport.
 *
 * @example
 * ```ts
 * const listener = TcpTransport.listen({ hostname: "127.0.0.1", port: 4000 });
 * using handle = serve(Pinger, listener, ({ peer }) => {
 *   console.log(`accepted ${peer.id} from`, peer.remoteAddress);
 *   return new PingServer();
 * });
 * ```
 */
export class RpcPeer {
  /** Whether this side of the connection acts as the client or the server. */
  readonly role: RpcPeerOptions["role"];
  /** The started transport carrying frames for this connection. */
  readonly transport: RpcTransport;
  /** Local endpoint address metadata, or `null` when unknown. */
  readonly localAddress: RpcPeerAddress | null;
  /** Remote endpoint address metadata, or `null` when unknown. */
  readonly remoteAddress: RpcPeerAddress | null;
  /** Stable identifier for the peer. */
  readonly id: string;

  /**
   * Create peer metadata for a connection.
   *
   * @param options - Role, transport, and address metadata for the connection.
   */
  constructor(options: RpcPeerOptions) {
    this.role = options.role;
    this.transport = options.transport;
    this.localAddress = options.localAddress ?? null;
    this.remoteAddress = options.remoteAddress ?? null;
    this.id = options.id ??
      `${options.role}:${formatPeerAddress(options.remoteAddress ?? null)}`;
  }

  /**
   * Close the underlying transport for this connection.
   *
   * @returns A promise that resolves once the transport has closed.
   */
  async close(): Promise<void> {
    await this.transport.close();
  }

  /** Closes the underlying transport when disposed via `using`. */
  [Symbol.dispose](): void {
    void this.close();
  }

  /** Closes the underlying transport when disposed via `await using`. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /**
   * Describe the peer for diagnostics.
   *
   * @returns A short diagnostic description including the peer id.
   */
  toString(): string {
    return `[RpcPeer ${this.id}]`;
  }
}

/**
 * Lifecycle members merged onto typed RPC stubs.
 *
 * `close()` releases the stub's underlying resource (a capability reference
 * or the connection). When the schema interface itself defines a `close`
 * method, the stub forwards `close` to that RPC method instead and lifecycle
 * release is reachable only through `Symbol.dispose` / `Symbol.asyncDispose`
 * (`using` / `await using`).
 */
export interface RpcStubLifecycle {
  close(): Promise<void>;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Typed RPC stub plus lifecycle controls.
 *
 * A schema method named `close` wins the property: the lifecycle `close()` is
 * merged only when `TClient` does not define one, so colliding schema methods
 * keep their generated signature.
 */
export type RpcStub<TClient extends object> = TClient extends { close: unknown }
  ? TClient & Omit<RpcStubLifecycle, "close">
  : TClient & RpcStubLifecycle;

export interface RpcServiceContext {
  /** Peer metadata and transport lifecycle for the accepted connection. */
  readonly peer: RpcPeer;
  /**
   * Aborts when service initialization is canceled before the runtime becomes
   * active, for example by `connectionInitTimeoutMs` or a forced drain.
   */
  readonly signal: AbortSignal;
}

export type RpcServiceConstructor<TServer extends object> = new (
  peer: RpcPeer,
) => TServer;

export type RpcServiceFactory<TServer extends object> = (
  context: RpcServiceContext,
) => TServer | Promise<TServer>;

export type RpcServiceImplementation<TServer extends object> =
  | TServer
  | RpcServiceConstructor<TServer>;

export type RpcServiceBinding<TServer extends object> =
  | RpcServiceImplementation<TServer>
  | RpcServiceFactory<TServer>;
