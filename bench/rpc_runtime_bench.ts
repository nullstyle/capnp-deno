import {
  decodeCallRequestFrame,
  decodeReturnFrame,
  decodeRpcMessageTag,
  encodeCallRequestFrame,
  encodeReturnResultsFrame,
  InMemoryRpcHarnessTransport,
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_FINISH,
  RpcServerBridge,
  RpcSession,
  SessionRpcClientTransport,
  type WasmHostCallRecord,
  WasmPeer,
} from "../mod.ts";
import { FakeCapnpWasm } from "../tests/fake_wasm.ts";

const MASK_30 = 0x3fff_ffffn;

function encodeSingleU32StructMessage(value: number): Uint8Array {
  const out = new Uint8Array(24);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, 0, true);
  view.setUint32(4, 2, true);
  view.setBigUint64(8, 0x0000_0001_0000_0000n, true);
  view.setUint32(16, value >>> 0, true);
  return out;
}

function signed30(value: bigint): number {
  const raw = Number(value & MASK_30);
  return (raw & (1 << 29)) !== 0 ? raw - (1 << 30) : raw;
}

function decodeSingleU32StructMessage(frame: Uint8Array): number {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const root = view.getBigUint64(8, true);
  const offset = signed30((root >> 2n) & MASK_30);
  const dataWord = 1 + offset;
  return view.getUint32(8 + (dataWord * 8), true);
}

class MockHostAbi {
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
      throw new Error("expected non-empty host result payload");
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

let blackhole = 0;

const callPayload = encodeSingleU32StructMessage(77);
const resultPayload = encodeSingleU32StructMessage(88);
const capTable48 = Array.from({ length: 48 }, (_v, i) => ({
  tag: i % 2 === 0 ? 1 : 3,
  id: 10_000 + i,
}));

const bridge = new RpcServerBridge();
bridge.exportCapability({
  interfaceId: 0x1234n,
  dispatch: (_methodOrdinal, _params, _ctx) => resultPayload,
}, { capabilityIndex: 5 });

const bridgeCallFrame = encodeCallRequestFrame({
  questionId: 11,
  interfaceId: 0x1234n,
  methodId: 9,
  targetImportedCap: 5,
  paramsContent: callPayload,
});

const hostAbi = new MockHostAbi();
const hostCallBatch32: WasmHostCallRecord[] = Array.from(
  { length: 32 },
  (_v, i) => {
    const questionId = i + 1;
    return {
      questionId,
      interfaceId: 0x1234n,
      methodId: 7,
      frame: encodeCallRequestFrame({
        questionId,
        interfaceId: 0x1234n,
        methodId: 7,
        targetImportedCap: 5,
        paramsContent: callPayload,
      }),
    };
  },
);

const fakeClientSmall = new FakeCapnpWasm({
  onPushFrame: (frame) => {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_CALL) {
      const call = decodeCallRequestFrame(frame);
      return [
        encodeReturnResultsFrame({
          answerId: call.questionId,
          content: resultPayload,
        }),
      ];
    }
    if (tag === RPC_MESSAGE_TAG_FINISH) return [];
    throw new Error(`unexpected rpc tag=${tag}`);
  },
});
const clientSmallPeer = WasmPeer.fromExports(fakeClientSmall.exports);
const clientSmallTransport = new InMemoryRpcHarnessTransport();
const clientSmallSession = new RpcSession(
  clientSmallPeer,
  clientSmallTransport,
);
await clientSmallSession.start();
const clientSmall = new SessionRpcClientTransport(
  clientSmallSession,
  clientSmallTransport,
  {
    interfaceId: 0x1234n,
    autoStart: false,
  },
);

const fakeClientCapTable = new FakeCapnpWasm({
  onPushFrame: (frame) => {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_CALL) {
      const call = decodeCallRequestFrame(frame);
      return [
        encodeReturnResultsFrame({
          answerId: call.questionId,
          content: resultPayload,
          capTable: capTable48,
        }),
      ];
    }
    if (tag === RPC_MESSAGE_TAG_FINISH) return [];
    throw new Error(`unexpected rpc tag=${tag}`);
  },
});
const clientCapTablePeer = WasmPeer.fromExports(fakeClientCapTable.exports);
const clientCapTableTransport = new InMemoryRpcHarnessTransport();
const clientCapTableSession = new RpcSession(
  clientCapTablePeer,
  clientCapTableTransport,
);
await clientCapTableSession.start();
const clientCapTable = new SessionRpcClientTransport(
  clientCapTableSession,
  clientCapTableTransport,
  {
    interfaceId: 0x1234n,
    autoStart: false,
  },
);

addEventListener("unload", () => {
  void clientSmallSession.close();
  void clientCapTableSession.close();
});

Deno.bench({
  name: "rpc_server_bridge:handle_call_frame",
  group: "rpc_server_bridge",
  baseline: true,
  n: 30_000,
  warmup: 1_000,
  async fn() {
    const response = await bridge.handleFrame(bridgeCallFrame);
    if (!response) throw new Error("expected response frame");
    const decoded = decodeReturnFrame(response);
    blackhole ^= decoded.answerId;
  },
});

Deno.bench({
  name: "rpc_server_bridge:pump_host_calls_batch_32",
  group: "rpc_server_bridge",
  n: 6_000,
  warmup: 300,
  async fn() {
    hostAbi.reset(hostCallBatch32);
    const handled = await bridge.pumpWasmHostCalls(
      { handle: 1, abi: hostAbi },
      { maxCalls: 32 },
    );
    blackhole ^= handled;
    blackhole ^= hostAbi.results;
  },
});

Deno.bench({
  name: "rpc_client_loopback:call_raw_small_payload",
  group: "rpc_client_loopback",
  baseline: true,
  n: 4_000,
  warmup: 200,
  async fn() {
    const result = await clientSmall.callRaw(
      { capabilityIndex: 5 },
      9,
      callPayload,
    );
    blackhole ^= decodeSingleU32StructMessage(result.contentBytes);
  },
});

Deno.bench({
  name: "rpc_client_loopback:call_raw_with_cap_tables_48",
  group: "rpc_client_loopback",
  n: 2_000,
  warmup: 150,
  async fn() {
    const result = await clientCapTable.callRaw(
      { capabilityIndex: 5 },
      9,
      callPayload,
      { paramsCapTable: capTable48 },
    );
    blackhole ^= result.capTable.length;
    blackhole ^= decodeSingleU32StructMessage(result.contentBytes);
  },
});
