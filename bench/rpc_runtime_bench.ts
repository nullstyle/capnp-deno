import {
  decodeBootstrapRequestFrame,
  decodeCallRequestFrame,
  decodeReturnFrame,
  decodeRpcMessageTag,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  encodeReturnResultsFrame,
  InMemoryRpcHarnessTransport,
  RPC_MESSAGE_TAG_BOOTSTRAP,
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_FINISH,
  RpcServerBridge,
  RpcSession,
  SessionRpcClientTransport,
  type WasmHostCallRecord,
  WasmPeer,
} from "../src/advanced.ts";
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
const bootstrapCapTable = [{ tag: 1, id: 5 }];

const spuriousUndecodableFrame = new Uint8Array([0xff, 0x00, 0xaa, 0x55]);
const spuriousMismatchedReturnFrame = encodeReturnResultsFrame({
  answerId: 0,
  content: resultPayload,
});

function makeSpuriousReturnPrefix(count: number): Uint8Array[] {
  return Array.from(
    { length: count },
    (_v, i) =>
      i % 2 === 0 ? spuriousUndecodableFrame : spuriousMismatchedReturnFrame,
  );
}

const spuriousPrefix8 = makeSpuriousReturnPrefix(8);
const spuriousPrefix64 = makeSpuriousReturnPrefix(64);

async function createLoopbackClient(
  onPushFrame: (frame: Uint8Array) => Uint8Array[],
): Promise<{
  session: RpcSession;
  client: SessionRpcClientTransport;
}> {
  const fake = new FakeCapnpWasm({ onPushFrame });
  const peer = WasmPeer.fromExports(fake.exports);
  const transport = new InMemoryRpcHarnessTransport();
  const session = new RpcSession(peer, transport);
  await session.start();
  const client = new SessionRpcClientTransport(session, transport, {
    interfaceId: 0x1234n,
    autoStart: false,
  });
  return { session, client };
}

const bridge = new RpcServerBridge();
bridge.exportCapability({
  interfaceId: 0x1234n,
  dispatch: (_methodId, _params, _ctx) => resultPayload,
}, { capabilityIndex: 5 });

let bridgeFinishCount = 0;
let bridgeReleaseCount = 0;
const bridgeControl = new RpcServerBridge({
  onFinish: () => {
    bridgeFinishCount += 1;
  },
});
bridgeControl.exportCapability({
  interfaceId: 0x1234n,
  dispatch: () => resultPayload,
}, {
  capabilityIndex: 77,
  referenceCount: 2_000_000,
});

const bridgeCallFrame = encodeCallRequestFrame({
  questionId: 11,
  interfaceId: 0x1234n,
  methodId: 9,
  targetImportedCap: 5,
  paramsContent: callPayload,
});
const bridgeFinishFrame = encodeFinishFrame({
  questionId: 42,
  releaseResultCaps: true,
  requireEarlyCancellation: false,
});
const bridgeReleaseFrame = encodeReleaseFrame({
  id: 77,
  referenceCount: 1,
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

const { session: clientSmallSession, client: clientSmall } =
  await createLoopbackClient((frame) => {
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
  });

const { session: clientCapTableSession, client: clientCapTable } =
  await createLoopbackClient((frame) => {
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
  });

const { session: clientBootstrapSession, client: clientBootstrap } =
  await createLoopbackClient((frame) => {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_BOOTSTRAP) {
      const request = decodeBootstrapRequestFrame(frame);
      return [
        encodeReturnResultsFrame({
          answerId: request.questionId,
          capTable: bootstrapCapTable,
        }),
      ];
    }
    if (tag === RPC_MESSAGE_TAG_FINISH) return [];
    throw new Error(`unexpected rpc tag=${tag}`);
  });

const { session: clientSpurious8Session, client: clientSpurious8 } =
  await createLoopbackClient((frame) => {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_CALL) {
      const call = decodeCallRequestFrame(frame);
      return [
        ...spuriousPrefix8,
        encodeReturnResultsFrame({
          answerId: call.questionId,
          content: resultPayload,
        }),
      ];
    }
    if (tag === RPC_MESSAGE_TAG_FINISH) return [];
    throw new Error(`unexpected rpc tag=${tag}`);
  });

const { session: clientSpurious64Session, client: clientSpurious64 } =
  await createLoopbackClient((frame) => {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_CALL) {
      const call = decodeCallRequestFrame(frame);
      return [
        ...spuriousPrefix64,
        encodeReturnResultsFrame({
          answerId: call.questionId,
          content: resultPayload,
        }),
      ];
    }
    if (tag === RPC_MESSAGE_TAG_FINISH) return [];
    throw new Error(`unexpected rpc tag=${tag}`);
  });

addEventListener("unload", () => {
  void clientSmallSession.close();
  void clientCapTableSession.close();
  void clientBootstrapSession.close();
  void clientSpurious8Session.close();
  void clientSpurious64Session.close();
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
  name: "rpc_server_bridge:handle_finish_frame",
  group: "rpc_server_bridge_control",
  baseline: true,
  n: 80_000,
  warmup: 2_000,
  async fn() {
    const response = await bridgeControl.handleFrame(bridgeFinishFrame);
    if (response !== null) throw new Error("finish should not emit response");
    blackhole ^= bridgeFinishCount;
  },
});

Deno.bench({
  name: "rpc_server_bridge:handle_release_frame",
  group: "rpc_server_bridge_control",
  n: 80_000,
  warmup: 2_000,
  async fn() {
    const response = await bridgeControl.handleFrame(bridgeReleaseFrame);
    if (response !== null) throw new Error("release should not emit response");
    bridgeReleaseCount += 1;
    blackhole ^= bridgeReleaseCount;
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
  name: "rpc_client_bootstrap:default_finish",
  group: "rpc_client_bootstrap",
  baseline: true,
  n: 4_000,
  warmup: 180,
  async fn() {
    const cap = await clientBootstrap.bootstrap();
    blackhole ^= cap.capabilityIndex;
  },
});

Deno.bench({
  name: "rpc_client_bootstrap:auto_finish_false",
  group: "rpc_client_bootstrap",
  n: 4_000,
  warmup: 180,
  async fn() {
    const cap = await clientBootstrap.bootstrap({ autoFinish: false });
    blackhole ^= cap.capabilityIndex;
  },
});

Deno.bench({
  name: "rpc_client_loopback:call_raw_spurious_returns_8",
  group: "rpc_client_spurious_returns",
  baseline: true,
  n: 2_000,
  warmup: 120,
  async fn() {
    const result = await clientSpurious8.callRaw(
      { capabilityIndex: 5 },
      9,
      callPayload,
    );
    blackhole ^= decodeSingleU32StructMessage(result.contentBytes);
  },
});

Deno.bench({
  name: "rpc_client_loopback:call_raw_spurious_returns_64",
  group: "rpc_client_spurious_returns",
  n: 700,
  warmup: 80,
  async fn() {
    const result = await clientSpurious64.callRaw(
      { capabilityIndex: 5 },
      9,
      callPayload,
    );
    blackhole ^= decodeSingleU32StructMessage(result.contentBytes);
  },
});

Deno.bench({
  name: "rpc_client_concurrency:call_raw_burst_8",
  group: "rpc_client_concurrency",
  baseline: true,
  n: 600,
  warmup: 30,
  async fn() {
    const calls = Array.from(
      { length: 8 },
      () => clientSmall.callRaw({ capabilityIndex: 5 }, 9, callPayload),
    );
    const results = await Promise.all(calls);
    for (const result of results) {
      blackhole ^= decodeSingleU32StructMessage(result.contentBytes);
    }
  },
});

Deno.bench({
  name: "rpc_client_concurrency:call_raw_burst_32",
  group: "rpc_client_concurrency",
  n: 180,
  warmup: 20,
  async fn() {
    const calls = Array.from(
      { length: 32 },
      () => clientSmall.callRaw({ capabilityIndex: 5 }, 9, callPayload),
    );
    const results = await Promise.all(calls);
    for (const result of results) {
      blackhole ^= decodeSingleU32StructMessage(result.contentBytes);
    }
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
