import { connect, TcpTransport } from "@nullstyle/capnp";
import { Pinger } from "./gen/types.ts";
import type { Ponger } from "./gen/types.ts";

using pinger = await connect(
  Pinger,
  await TcpTransport.connect("127.0.0.1", 4000),
);

class ClientPing implements Ponger {
  pong(count: number): Promise<void> {
    console.log(`Received pong with count ${count}`);
    return Promise.resolve();
  }
}

const clientPing = new ClientPing();

await pinger.ping(clientPing);
await pinger.ping(clientPing);
await pinger.ping(clientPing);
