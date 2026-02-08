import {
  encodeCallRequestFrame,
  RpcServerBridge,
  RpcServerRuntime,
  type RpcTransport,
  type WasmHostCallRecord,
  WasmPeer,
} from "../mod.ts";
import { FakeCapnpWasm } from "../tests/fake_wasm.ts";

function encodeSingleU32StructMessage(value: number): Uint8Array {
  const out = new Uint8Array(24);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, 0, true);
  view.setUint32(4, 2, true);
  view.setBigUint64(8, 0x0000_0001_0000_0000n, true);
  view.setUint32(16, value >>> 0, true);
  return out;
}

class BenchTransport implements RpcTransport {
  #onFrame: ((frame: Uint8Array) => void | Promise<void>) | null = null;

  start(onFrame: (frame: Uint8Array) => void | Promise<void>): void {
    this.#onFrame = onFrame;
  }

  send(_frame: Uint8Array): void {
    // Intentionally empty: auto-pumped host calls in this suite do not emit
    // peer outbound frames in our fake setup.
  }

  close(): void {
    // no-op
  }

  async emitInbound(frame: Uint8Array): Promise<void> {
    if (!this.#onFrame) {
      throw new Error("transport not started");
    }
    await this.#onFrame(frame);
  }
}

class BenchHostAbi {
  readonly calls: WasmHostCallRecord[] = [];
  cursor = 0;
  results = 0;
  exceptions = 0;

  reset(batch: WasmHostCallRecord[]): void {
    this.calls.length = 0;
    this.calls.push(...batch);
    this.cursor = 0;
    this.results = 0;
    this.exceptions = 0;
  }

  popHostCall(_peer: number): WasmHostCallRecord | null {
    if (this.cursor >= this.calls.length) return null;
    const next = this.calls[this.cursor];
    this.cursor += 1;
    return next;
  }

  respondHostCallResults(
    _peer: number,
    _questionId: number,
    payloadFrame: Uint8Array,
  ): void {
    this.results += 1;
    if (payloadFrame.byteLength === 0) {
      throw new Error("expected non-empty host-call response payload");
    }
  }

  respondHostCallException(
    _peer: number,
    _questionId: number,
    _reason: string | Uint8Array,
  ): void {
    this.exceptions += 1;
  }
}

function createHostCall(questionId: number): WasmHostCallRecord {
  return {
    questionId,
    interfaceId: 0x1234n,
    methodId: 7,
    frame: encodeCallRequestFrame({
      questionId,
      interfaceId: 0x1234n,
      methodId: 7,
      targetImportedCap: 5,
      paramsContent: encodeSingleU32StructMessage(questionId),
    }),
  };
}

function createHostCallBatch(size: number): WasmHostCallRecord[] {
  return Array.from({ length: size }, (_v, i) => createHostCall(i + 1));
}

let blackhole = 0;

const inboundFrame = new Uint8Array([0x01]);
const batch1 = createHostCallBatch(1);
const batch8 = createHostCallBatch(8);
const batch64 = createHostCallBatch(64);

const fake = new FakeCapnpWasm({
  onPushFrame: () => [],
});
const peer = WasmPeer.fromExports(fake.exports);
const transport = new BenchTransport();
const bridge = new RpcServerBridge();
bridge.exportCapability({
  interfaceId: 0x1234n,
  dispatch: () => encodeSingleU32StructMessage(88),
}, { capabilityIndex: 5 });

const hostAbi = new BenchHostAbi();
const runtime = new RpcServerRuntime(peer, transport, bridge, {
  wasmHost: {
    handle: peer.handle,
    abi: hostAbi,
  },
  hostCallPump: {
    maxCallsPerInboundFrame: 64,
  },
});
await runtime.start();

addEventListener("unload", () => {
  void runtime.close();
});

async function runAutoPumpIteration(
  batch: WasmHostCallRecord[],
): Promise<void> {
  hostAbi.reset(batch);
  await transport.emitInbound(inboundFrame);
  await runtime.flush();
  if (hostAbi.exceptions !== 0) {
    throw new Error(`unexpected host-call exceptions: ${hostAbi.exceptions}`);
  }
  blackhole ^= hostAbi.results;
}

Deno.bench({
  name: "rpc_server_runtime:auto_pump_after_inbound_1",
  group: "rpc_server_runtime_auto_pump",
  baseline: true,
  n: 4_000,
  warmup: 160,
  async fn() {
    await runAutoPumpIteration(batch1);
  },
});

Deno.bench({
  name: "rpc_server_runtime:auto_pump_after_inbound_8",
  group: "rpc_server_runtime_auto_pump",
  n: 2_400,
  warmup: 120,
  async fn() {
    await runAutoPumpIteration(batch8);
  },
});

Deno.bench({
  name: "rpc_server_runtime:auto_pump_after_inbound_64",
  group: "rpc_server_runtime_auto_pump",
  n: 800,
  warmup: 60,
  async fn() {
    await runAutoPumpIteration(batch64);
  },
});
