import { connect, WebSocketTransport } from "@nullstyle/capnp";
import { Pinger } from "./gen/types.ts";
import type { Ponger } from "./gen/types.ts";

const DEFAULT_URL = "ws://127.0.0.1:4001/rpc";
const DEFAULT_PROTOCOL = "capnp-rpc";
const DEFAULT_PING_COUNT = 3;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid positive integer: ${raw}`);
  }
  return parsed;
}

class ClientPing implements Ponger {
  pong(count: number): Promise<void> {
    console.log(`Received pong with count ${count}`);
    return Promise.resolve();
  }
}

const url = Deno.args[0] ?? DEFAULT_URL;
const protocol = Deno.args[1] ?? DEFAULT_PROTOCOL;
const pingCount = parsePositiveInt(Deno.args[2], DEFAULT_PING_COUNT);

using pinger = await connect(
  Pinger,
  await WebSocketTransport.connect(url, protocol),
);

const clientPing = new ClientPing();

for (let i = 0; i < pingCount; i++) {
  await pinger.ping(clientPing);
}

console.log(`completed ${pingCount} ping call(s) over ${url}`);
