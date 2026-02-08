import {
  RpcSession,
  type RpcTransport,
  WasmAbi,
  WasmPeer,
} from "../advanced.ts";
import { FakeCapnpWasm } from "../tests/fake_wasm.ts";

class SinkTransport implements RpcTransport {
  sentBytes = 0;
  sentFrames = 0;

  start(
    _onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): void {
    // no-op
  }

  send(frame: Uint8Array): void {
    this.sentFrames += 1;
    this.sentBytes += frame.byteLength;
  }

  close(): void {
    // no-op
  }

  takeSentBytes(): number {
    const out = this.sentBytes;
    this.sentBytes = 0;
    this.sentFrames = 0;
    return out;
  }
}

let blackhole = 0;

function consumeBytes(bytes: Uint8Array[]): void {
  blackhole ^= bytes.length;
  for (const frame of bytes) {
    blackhole ^= frame.byteLength;
    if (frame.byteLength > 0) {
      blackhole ^= frame[0];
    }
  }
}

const inboundFrame = new Uint8Array([0x41, 0x42, 0x43, 0x44]);

const fakeAbiSingle = new FakeCapnpWasm({
  onPushFrame: (frame) => [new Uint8Array(frame)],
});
const abiSingle = new WasmAbi(fakeAbiSingle.exports);
const abiSinglePeer = abiSingle.createPeer();

const fakeAbiMulti = new FakeCapnpWasm({
  onPushFrame: (frame) => [
    new Uint8Array([frame[0], 0x10]),
    new Uint8Array([frame[0], 0x20]),
    new Uint8Array([frame[0], 0x30]),
  ],
});
const abiMulti = new WasmAbi(fakeAbiMulti.exports);
const abiMultiPeer = abiMulti.createPeer();

const fakeSessionSingle = new FakeCapnpWasm({
  onPushFrame: (frame) => [new Uint8Array(frame)],
});
const sessionSinglePeer = WasmPeer.fromExports(fakeSessionSingle.exports);
const sessionSingleTransport = new SinkTransport();
const sessionSingle = new RpcSession(sessionSinglePeer, sessionSingleTransport);

const fakeSessionObserved = new FakeCapnpWasm({
  onPushFrame: (frame) => [
    new Uint8Array([frame[0], 0x11]),
    new Uint8Array([frame[0], 0x22]),
  ],
});
const sessionObservedPeer = WasmPeer.fromExports(fakeSessionObserved.exports);
const sessionObservedTransport = new SinkTransport();
let observedEvents = 0;
const sessionObserved = new RpcSession(
  sessionObservedPeer,
  sessionObservedTransport,
  {
    observability: {
      onEvent: () => {
        observedEvents += 1;
      },
    },
  },
);

addEventListener("unload", () => {
  abiSingle.freePeer(abiSinglePeer);
  abiMulti.freePeer(abiMultiPeer);
  sessionSinglePeer.close();
  sessionObservedPeer.close();
});

Deno.bench({
  name: "abi:push_and_drain_single_outbound",
  group: "abi",
  baseline: true,
  n: 40_000,
  warmup: 1_000,
  fn() {
    abiSingle.pushFrame(abiSinglePeer, inboundFrame);
    const { frames: out } = abiSingle.drainOutFrames(abiSinglePeer);
    consumeBytes(out);
  },
});

Deno.bench({
  name: "abi:push_and_drain_three_outbound",
  group: "abi",
  n: 30_000,
  warmup: 1_000,
  fn() {
    abiMulti.pushFrame(abiMultiPeer, inboundFrame);
    const { frames: out } = abiMulti.drainOutFrames(abiMultiPeer);
    consumeBytes(out);
  },
});

Deno.bench({
  name: "session:pump_inbound_single_outbound",
  group: "session",
  baseline: true,
  n: 25_000,
  warmup: 1_000,
  async fn() {
    await sessionSingle.pumpInboundFrame(inboundFrame);
    blackhole ^= sessionSingleTransport.takeSentBytes();
  },
});

Deno.bench({
  name: "session:pump_inbound_with_observability",
  group: "session",
  n: 20_000,
  warmup: 800,
  async fn() {
    await sessionObserved.pumpInboundFrame(inboundFrame);
    blackhole ^= sessionObservedTransport.takeSentBytes();
    blackhole ^= observedEvents;
    observedEvents = 0;
  },
});
