import { serve, TcpTransport } from "@nullstyle/capnp";
import type { RpcCallContext, RpcPeer } from "@nullstyle/capnp";
import { CounterSink } from "./gen/schema_types.ts";
import type { CounterSinkService, TotalResults } from "./gen/schema_types.ts";

class CounterServer implements CounterSinkService {
  readonly peer: RpcPeer;
  sum = 0n;
  count = 0;

  constructor(peer: RpcPeer) {
    this.peer = peer;
    console.log(`streaming peer connected ${peer}`);
  }

  [Symbol.dispose]() {
    console.log(`streaming peer disconnected ${this.peer}`);
  }

  add(value: number, ctx: RpcCallContext): void {
    if (ctx.signal.aborted) return;
    this.sum += BigInt(value);
    this.count++;
    console.log(`received ${value}`);
  }

  total(_ctx: RpcCallContext): TotalResults {
    return { sum: this.sum, count: this.count };
  }
}

serve(
  CounterSink,
  TcpTransport.listen({ hostname: "127.0.0.1", port: 4010 }),
  ({ peer }) => new CounterServer(peer),
);
