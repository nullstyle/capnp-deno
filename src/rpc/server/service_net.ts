import { SessionError } from "../../errors.ts";
import type { RpcPeerAddress } from "./service_types.ts";

export function formatPeerAddress(address: RpcPeerAddress | null): string {
  if (!address) return "unknown";
  if (address.hostname && address.port !== undefined) {
    return `${address.hostname}:${address.port}`;
  }
  if (address.path) return address.path;
  return "unknown";
}

export function toRpcPeerAddress(input: unknown): RpcPeerAddress | null {
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

export function toWebSocketLocalAddress(request: Request): RpcPeerAddress {
  const url = new URL(request.url);
  const parsedPort = url.port.length > 0 ? Number(url.port) : undefined;
  return {
    transport: "websocket",
    hostname: url.hostname,
    port: Number.isInteger(parsedPort) ? parsedPort : undefined,
    path: url.pathname,
  };
}

export function toWebTransportLocalAddress(url: URL): RpcPeerAddress {
  const parsedPort = url.port.length > 0 ? Number(url.port) : undefined;
  return {
    transport: "webtransport",
    hostname: url.hostname,
    port: Number.isInteger(parsedPort) ? parsedPort : undefined,
    path: url.pathname,
  };
}

export function toWebTransportRemoteAddress(input: unknown): RpcPeerAddress {
  return {
    ...(toRpcPeerAddress(input) ?? {}),
    transport: "webtransport",
  };
}

export function requireDenoServe(): typeof Deno.serve {
  const maybeServe = (Deno as unknown as { serve?: typeof Deno.serve }).serve;
  if (typeof maybeServe !== "function") {
    throw new SessionError(
      "Deno.serve is unavailable; run with a runtime that supports HTTP/WebSocket serve",
    );
  }
  return maybeServe;
}

export function requireDenoQuicEndpoint(): typeof Deno.QuicEndpoint {
  const maybeQuicEndpoint = (Deno as unknown as {
    QuicEndpoint?: typeof Deno.QuicEndpoint;
  }).QuicEndpoint;
  if (typeof maybeQuicEndpoint !== "function") {
    throw new SessionError(
      "Deno.QuicEndpoint is unavailable; run Deno with --unstable-net to serve WebTransport",
    );
  }
  return maybeQuicEndpoint;
}

export function requireDenoUpgradeWebTransport(): typeof Deno.upgradeWebTransport {
  const maybeUpgrade = (Deno as unknown as {
    upgradeWebTransport?: typeof Deno.upgradeWebTransport;
  }).upgradeWebTransport;
  if (typeof maybeUpgrade !== "function") {
    throw new SessionError(
      "Deno.upgradeWebTransport is unavailable; run Deno with --unstable-net to serve WebTransport",
    );
  }
  return maybeUpgrade;
}

export function isWebSocketUpgradeRequest(request: Request): boolean {
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

export function resolveWebSocketProtocol(
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
