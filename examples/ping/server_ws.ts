import { WS } from "@nullstyle/capnp";
import type { RpcPeer, RpcStub } from "@nullstyle/capnp";
import { Pinger } from "./gen/types.ts";
import type { Ponger } from "./gen/types.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4001;
const DEFAULT_PATH = "/rpc";
const DEFAULT_PROTOCOL = "capnp-rpc";

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`invalid port: ${raw}`);
  }
  return parsed;
}

class PingServer implements Pinger {
  readonly peer: RpcPeer;
  pingCount = 0;

  constructor(peer: RpcPeer) {
    this.peer = peer;
    console.log(`peer connected ${peer}`);
  }

  [Symbol.dispose]() {
    console.log(`peer disconnected ${this.peer}`);
  }

  async ping(p: Ponger | RpcStub<Ponger>): Promise<void> {
    this.pingCount++;
    await p.pong(this.pingCount);
  }
}

const host = Deno.args[0] ?? DEFAULT_HOST;
const port = parsePort(Deno.args[1], DEFAULT_PORT);
const path = Deno.args[2] ?? DEFAULT_PATH;
const protocol = Deno.args[3] ?? DEFAULT_PROTOCOL;

WS.serve(Pinger, host, port, PingServer, {
  path,
  protocols: protocol,
  onConnectionError(error: unknown): void {
    console.error("connection error", error);
  },
});

console.log(
  `ping ws server listening on ws://${host}:${port}${path} (protocol: ${protocol})`,
);
