import {
  connectWithReconnect,
  type ConnectWithReconnectOptions,
} from "./reconnect.ts";
import { normalizeSessionError } from "./errors.ts";
import { RpcSession, type RpcSessionOptions } from "./session.ts";
import type { RpcTransport } from "./transport.ts";
import { TcpTransport, type TcpTransportOptions } from "./transports/tcp.ts";
import {
  WebSocketTransport,
  type WebSocketTransportOptions,
} from "./transports/websocket.ts";
import type { WasmPeer } from "./wasm_peer.ts";

export interface ConnectTcpTransportWithReconnectOptions {
  transport?: TcpTransportOptions;
  reconnect: ConnectWithReconnectOptions;
}

export interface ConnectWebSocketTransportWithReconnectOptions {
  protocols?: string | string[];
  transport?: WebSocketTransportOptions;
  reconnect: ConnectWithReconnectOptions;
}

export interface CreateRpcSessionWithReconnectOptions<
  TTransport extends RpcTransport,
> {
  connectTransport: () => Promise<TTransport>;
  createPeer: () => Promise<WasmPeer> | WasmPeer;
  reconnect: ConnectWithReconnectOptions;
  session?: RpcSessionOptions;
  autoStart?: boolean;
}

export async function connectTransportWithReconnect<
  TTransport extends RpcTransport,
>(
  connect: () => Promise<TTransport>,
  reconnect: ConnectWithReconnectOptions,
): Promise<TTransport> {
  return await connectWithReconnect(connect, reconnect);
}

export async function connectTcpTransportWithReconnect(
  hostname: string,
  port: number,
  options: ConnectTcpTransportWithReconnectOptions,
): Promise<TcpTransport> {
  return await connectTransportWithReconnect(
    () => TcpTransport.connect(hostname, port, options.transport ?? {}),
    options.reconnect,
  );
}

export async function connectWebSocketTransportWithReconnect(
  url: string | URL,
  options: ConnectWebSocketTransportWithReconnectOptions,
): Promise<WebSocketTransport> {
  return await connectTransportWithReconnect(
    () =>
      WebSocketTransport.connect(
        url,
        options.protocols,
        options.transport ?? {},
      ),
    options.reconnect,
  );
}

export async function createRpcSessionWithReconnect<
  TTransport extends RpcTransport,
>(
  options: CreateRpcSessionWithReconnectOptions<TTransport>,
): Promise<{ session: RpcSession; transport: TTransport }> {
  const transport = await connectTransportWithReconnect(
    options.connectTransport,
    options.reconnect,
  );

  let peer: WasmPeer | null = null;
  try {
    peer = await options.createPeer();
    const session = new RpcSession(peer, transport, options.session ?? {});
    if (options.autoStart ?? true) {
      await session.start();
    }
    return { session, transport };
  } catch (error) {
    try {
      await transport.close();
    } catch {
      // no-op while unwinding startup errors.
    }

    if (peer) {
      try {
        peer.close();
      } catch {
        // no-op while unwinding startup errors.
      }
    }

    throw normalizeSessionError(error, "failed to create rpc session");
  }
}
