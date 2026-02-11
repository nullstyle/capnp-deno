/**
 * Convenience factories for common reconnecting transport patterns.
 *
 * Combines {@link connectWithReconnect} with concrete transport constructors
 * (TCP, WebSocket) and optional {@link RpcSession} wiring to reduce
 * boilerplate for the most common reconnection setups.
 *
 * @module
 */

import {
  connectWithReconnect,
  type ConnectWithReconnectOptions,
} from "./reconnect.ts";
import { normalizeSessionError } from "../../errors.ts";
import { RpcSession, type RpcSessionOptions } from "../session/session.ts";
import type { RpcRuntimeModuleOptions } from "../server/runtime_module.ts";
import type { RpcTransport } from "./transport.ts";
import { TcpTransport, type TcpTransportOptions } from "./tcp.ts";
import {
  WebSocketTransport,
  type WebSocketTransportOptions,
} from "./websocket.ts";

/**
 * Options for {@link connectTcpTransportWithReconnect}.
 */
export interface ConnectTcpTransportWithReconnectOptions {
  /** Options forwarded to each {@link TcpTransport.connect} attempt. */
  transport?: TcpTransportOptions;
  /** Reconnection policy and options. */
  reconnect: ConnectWithReconnectOptions;
}

/**
 * Options for {@link connectWebSocketTransportWithReconnect}.
 */
export interface ConnectWebSocketTransportWithReconnectOptions {
  /** WebSocket sub-protocols to request during the handshake. */
  protocols?: string | string[];
  /** Options forwarded to each {@link WebSocketTransport.connect} attempt. */
  transport?: WebSocketTransportOptions;
  /** Reconnection policy and options. */
  reconnect: ConnectWithReconnectOptions;
}

/**
 * Options for {@link createRpcSessionWithReconnect}.
 *
 * @typeParam TTransport - The specific transport type being connected.
 */
export interface CreateRpcSessionWithReconnectOptions<
  TTransport extends RpcTransport,
> {
  /** Factory function that creates a new transport connection. */
  connectTransport: () => Promise<TTransport>;
  /** Reconnection policy and options for the transport connection. */
  reconnect: ConnectWithReconnectOptions;
  /** Options forwarded to the {@link RpcSession} constructor. */
  session?: RpcSessionOptions;
  /** Whether to automatically start the session. Defaults to `true`. */
  autoStart?: boolean;
  /** Optional runtime-module loading overrides for the internal session. */
  runtimeModule?: RpcRuntimeModuleOptions;
}

/**
 * Connect any {@link RpcTransport} with automatic reconnection on failure.
 *
 * @typeParam TTransport - The specific transport type.
 * @param connect - Factory function that creates a new transport.
 * @param reconnect - Reconnection policy and options.
 * @returns The connected transport.
 * @throws {TransportError} If all retry attempts are exhausted.
 */
export async function connectTransportWithReconnect<
  TTransport extends RpcTransport,
>(
  connect: () => Promise<TTransport>,
  reconnect: ConnectWithReconnectOptions,
): Promise<TTransport> {
  return await connectWithReconnect(connect, reconnect);
}

/**
 * Connect a {@link TcpTransport} to the given host and port with automatic
 * reconnection on failure.
 *
 * @param hostname - The TCP hostname to connect to.
 * @param port - The TCP port to connect to.
 * @param options - Transport and reconnection options.
 * @returns The connected TCP transport.
 * @throws {TransportError} If all retry attempts are exhausted.
 */
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

/**
 * Connect a {@link WebSocketTransport} to the given URL with automatic
 * reconnection on failure.
 *
 * @param url - The WebSocket URL to connect to.
 * @param options - Transport, protocol, and reconnection options.
 * @returns The connected WebSocket transport.
 * @throws {TransportError} If all retry attempts are exhausted.
 */
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

/**
 * Create a complete {@link RpcSession} with a reconnectable transport.
 *
 * This is a high-level convenience that connects the transport (with retries),
 * loads the runtime module internally, constructs an RPC session, and
 * optionally starts it. On failure, partially-created resources are cleaned
 * up automatically.
 *
 * @typeParam TTransport - The specific transport type.
 * @param options - Session, transport, runtime-module, and reconnection options.
 * @returns The created session and connected transport.
 * @throws {SessionError} If session creation fails after transport connection.
 */
export async function createRpcSessionWithReconnect<
  TTransport extends RpcTransport,
>(
  options: CreateRpcSessionWithReconnectOptions<TTransport>,
): Promise<{ session: RpcSession; transport: TTransport }> {
  const transport = await connectTransportWithReconnect(
    options.connectTransport,
    options.reconnect,
  );

  try {
    const session = await RpcSession.create(transport, {
      ...(options.session ?? {}),
      autoStart: options.autoStart ?? true,
      runtimeModule: options.runtimeModule,
    });
    return { session, transport };
  } catch (error) {
    try {
      await transport.close();
    } catch {
      // no-op while unwinding startup errors.
    }
    throw normalizeSessionError(error, "failed to create rpc session");
  }
}
