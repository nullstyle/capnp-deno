import { serve, TcpTransport } from "@nullstyle/capnp";
import type { RpcPeer, RpcStub } from "@nullstyle/capnp";
import { Pinger } from "./gen/types.ts";
import type { Ponger } from "./gen/types.ts";

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

serve(
  Pinger,
  TcpTransport.listen({ hostname: "127.0.0.1", port: 4000 }),
  ({ peer }) => new PingServer(peer),
);
