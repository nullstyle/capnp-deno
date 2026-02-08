import {
  decodeCallRequestFrame,
  decodeFinishFrame,
  decodeReleaseFrame,
  decodeRpcMessageTag,
  encodeReturnResultsFrame,
  InMemoryRpcHarnessTransport,
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_FINISH,
  RPC_MESSAGE_TAG_RELEASE,
  type RpcCapDescriptor,
  RpcSession,
  SessionRpcClientTransport,
  WasmPeer,
} from "../advanced.ts";
import { FakeCapnpWasm } from "./fake_wasm.ts";
import { assert, assertEquals } from "./test_utils.ts";

function encodeSingleU32StructMessage(value: number): Uint8Array {
  const out = new Uint8Array(24);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, 0, true);
  view.setUint32(4, 2, true);
  view.setBigUint64(8, 0x0000_0001_0000_0000n, true);
  view.setUint32(16, value >>> 0, true);
  return out;
}

interface LifecycleHarnessState {
  events: string[];
  capsByAnswer: Map<number, number[]>;
  capRefCounts: Map<number, number>;
  nextCapId: number;
  finishCount: number;
  releaseCount: number;
}

function releaseCapability(
  state: LifecycleHarnessState,
  capId: number,
  referenceCount: number,
): void {
  const current = state.capRefCounts.get(capId);
  assert(current !== undefined, `release for unknown cap id ${capId}`);
  assert(
    current >= referenceCount,
    `release underflow for cap id ${capId}: have=${current} release=${referenceCount}`,
  );
  const next = current - referenceCount;
  if (next === 0) {
    state.capRefCounts.delete(capId);
    return;
  }
  state.capRefCounts.set(capId, next);
}

function createLifecycleHarness(
  options: { resultCapsPerCall?: number } = {},
): {
  state: LifecycleHarnessState;
  client: SessionRpcClientTransport;
  session: RpcSession;
} {
  const resultCapsPerCall = options.resultCapsPerCall ?? 2;
  const state: LifecycleHarnessState = {
    events: [],
    capsByAnswer: new Map<number, number[]>(),
    capRefCounts: new Map<number, number>(),
    nextCapId: 10_000,
    finishCount: 0,
    releaseCount: 0,
  };

  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) {
        const call = decodeCallRequestFrame(frame);
        const capTable: RpcCapDescriptor[] = [];
        for (let i = 0; i < resultCapsPerCall; i += 1) {
          const capId = state.nextCapId;
          state.nextCapId += 1;
          state.capRefCounts.set(capId, 1);
          capTable.push({ tag: i % 2 === 0 ? 1 : 3, id: capId });
        }
        state.capsByAnswer.set(
          call.questionId,
          capTable.map((entry) => entry.id),
        );
        state.events.push(`call:${call.questionId}`);
        return [
          encodeReturnResultsFrame({
            answerId: call.questionId,
            content: encodeSingleU32StructMessage(call.questionId),
            capTable,
          }),
        ];
      }
      if (tag === RPC_MESSAGE_TAG_FINISH) {
        const finish = decodeFinishFrame(frame);
        state.finishCount += 1;
        state.events.push(
          `finish:${finish.questionId}:${
            finish.releaseResultCaps ? "release" : "retain"
          }`,
        );
        const caps = state.capsByAnswer.get(finish.questionId) ?? [];
        if (finish.releaseResultCaps) {
          for (const capId of caps) {
            releaseCapability(state, capId, 1);
          }
        }
        state.capsByAnswer.delete(finish.questionId);
        return [];
      }
      if (tag === RPC_MESSAGE_TAG_RELEASE) {
        const release = decodeReleaseFrame(frame);
        state.releaseCount += 1;
        state.events.push(`release:${release.id}:${release.referenceCount}`);
        releaseCapability(state, release.id, release.referenceCount);
        return [];
      }
      throw new Error(`unexpected inbound rpc tag=${tag}`);
    },
  });

  const peer = WasmPeer.fromExports(fake.exports, { expectedVersion: 1 });
  const transport = new InMemoryRpcHarnessTransport();
  const session = new RpcSession(peer, transport);
  const client = new SessionRpcClientTransport(session, transport, {
    interfaceId: 0x1234n,
  });
  return { state, client, session };
}

Deno.test("rpc lifecycle: default finish eagerly releases result capabilities", async () => {
  const { state, client, session } = createLifecycleHarness({
    resultCapsPerCall: 3,
  });

  try {
    const iterations = 12;
    for (let i = 0; i < iterations; i += 1) {
      const response = await client.callRaw(
        { capabilityIndex: 0 },
        100 + i,
        encodeSingleU32StructMessage(i + 1),
      );
      assertEquals(response.capTable.length, 3);
    }

    assertEquals(state.capsByAnswer.size, 0);
    assertEquals(state.capRefCounts.size, 0);
    assertEquals(state.finishCount, 12);
    assertEquals(state.releaseCount, 0);
    assertEquals(state.events.length, 24);
  } finally {
    await session.close();
  }
});

Deno.test("rpc lifecycle: releaseResultCaps=false requires explicit release for leak-free completion", async () => {
  const { state, client, session } = createLifecycleHarness({
    resultCapsPerCall: 2,
  });

  try {
    const response = await client.callRaw(
      { capabilityIndex: 0 },
      9,
      encodeSingleU32StructMessage(77),
      {
        finish: { releaseResultCaps: false },
      },
    );

    assertEquals(response.capTable.length, 2);
    assertEquals(state.finishCount, 1);
    assertEquals(state.releaseCount, 0);
    assertEquals(state.capsByAnswer.size, 0);
    assertEquals(state.capRefCounts.size, 2);
    assertEquals(state.events[0], "call:1");
    assertEquals(state.events[1], "finish:1:retain");

    for (const cap of response.capTable) {
      await client.release({ capabilityIndex: cap.id }, 1);
    }

    assertEquals(state.capRefCounts.size, 0);
    assertEquals(state.releaseCount, 2);
    assertEquals(state.events.length, 4);
    assertEquals(state.events[2], `release:${response.capTable[0].id}:1`);
    assertEquals(state.events[3], `release:${response.capTable[1].id}:1`);
  } finally {
    await session.close();
  }
});

Deno.test("rpc lifecycle: autoFinish=false keeps answer live until explicit finish", async () => {
  const { state, client, session } = createLifecycleHarness({
    resultCapsPerCall: 2,
  });

  try {
    let questionId = -1;
    const response = await client.callRaw(
      { capabilityIndex: 0 },
      7,
      encodeSingleU32StructMessage(99),
      {
        autoFinish: false,
        onQuestionId: (id) => {
          questionId = id;
        },
      },
    );

    assertEquals(questionId, 1);
    assertEquals(response.capTable.length, 2);
    assertEquals(state.finishCount, 0);
    assertEquals(state.releaseCount, 0);
    assertEquals(state.capRefCounts.size, 2);
    assertEquals(state.capsByAnswer.size, 1);
    assertEquals(state.events.length, 1);
    assertEquals(state.events[0], "call:1");

    await client.finish(questionId, { releaseResultCaps: true });

    assertEquals(state.finishCount, 1);
    assertEquals(state.releaseCount, 0);
    assertEquals(state.capsByAnswer.size, 0);
    assertEquals(state.capRefCounts.size, 0);
    assertEquals(state.events.length, 2);
    assertEquals(state.events[1], "finish:1:release");
  } finally {
    await session.close();
  }
});
