import type { RpcTransport } from "../transports/internal/transport.ts";
import { formatPeerAddress } from "./service_net.ts";

export interface RpcPeerOptions {
  role: "client" | "server";
  transport: RpcTransport;
  localAddress?: RpcPeerAddress | null;
  remoteAddress?: RpcPeerAddress | null;
  id?: string;
}

export interface RpcPeerAddress {
  transport?: string;
  hostname?: string;
  port?: number;
  path?: string;
}

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

export interface RpcStubLifecycle {
  close(): Promise<void>;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}

export type RpcStub<TClient extends object> = TClient & RpcStubLifecycle;

export type TcpPort = number | string;

export type RpcServiceConstructor<TServer extends object> = new (
  peer: RpcPeer,
) => TServer;

export type RpcServiceImplementation<TServer extends object> =
  | TServer
  | RpcServiceConstructor<TServer>;
