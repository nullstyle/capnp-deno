import {
  decodeCallRequestFrame,
  decodeFinishFrame,
  decodeReleaseFrame,
  decodeRpcMessageTag,
  EMPTY_STRUCT_MESSAGE,
  encodeReturnResultsFrame,
  InMemoryRpcHarnessTransport,
  RPC_MESSAGE_TAG_BOOTSTRAP,
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_FINISH,
  RPC_MESSAGE_TAG_RELEASE,
  RpcSession,
  SessionRpcClientTransport,
  WasmPeer,
} from "../mod.ts";
import { FakeCapnpWasm } from "./fake_wasm.ts";
import {
  BOOTSTRAP_Q1_SUCCESS_INBOUND,
  BOOTSTRAP_Q1_SUCCESS_OUTBOUND,
  CALL_BOOTSTRAP_CAP_Q2_INBOUND,
  CALL_BOOTSTRAP_CAP_Q2_OUTBOUND,
} from "./fixtures/rpc_frames.ts";
import { assert, assertBytes, assertEquals } from "./test_utils.ts";

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

Deno.test("SessionRpcClientTransport drives fixture bootstrap/call flow", async () => {
  let bootstrapFinished = false;
  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_BOOTSTRAP) {
        assertBytes(frame, Array.from(BOOTSTRAP_Q1_SUCCESS_INBOUND));
        return [BOOTSTRAP_Q1_SUCCESS_OUTBOUND];
      }
      if (tag === RPC_MESSAGE_TAG_CALL) {
        assertBytes(frame, Array.from(CALL_BOOTSTRAP_CAP_Q2_INBOUND));
        return [CALL_BOOTSTRAP_CAP_Q2_OUTBOUND];
      }
      if (tag === RPC_MESSAGE_TAG_FINISH) {
        const finish = decodeFinishFrame(frame);
        assertEquals(finish.questionId, 1);
        bootstrapFinished = true;
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

  try {
    const cap = await client.bootstrap();
    assertEquals(cap.capabilityIndex, 1);
    assertEquals(bootstrapFinished, true);

    let thrown: unknown;
    try {
      await client.call(
        { capabilityIndex: cap.capabilityIndex },
        9,
        EMPTY_STRUCT_MESSAGE,
      );
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof Error) || !/bootstrap stub/.test(thrown.message)) {
      throw new Error(`expected bootstrap stub error, got: ${String(thrown)}`);
    }
  } finally {
    await session.close();
  }
});

Deno.test("SessionRpcClientTransport transports non-empty payload and sends finish", async () => {
  const params = encodeSingleU32StructMessage(77);
  const results = encodeSingleU32StructMessage(88);
  let seenCall = false;
  let seenFinish = false;

  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) {
        const call = decodeCallRequestFrame(frame);
        assertEquals(call.questionId, 1);
        assertEquals(decodeSingleU32StructMessage(call.paramsContent), 77);
        assertEquals(call.paramsCapTable.length, 0);
        seenCall = true;
        return [
          encodeReturnResultsFrame({
            answerId: call.questionId,
            content: results,
          }),
        ];
      }
      if (tag === RPC_MESSAGE_TAG_FINISH) {
        const finish = decodeFinishFrame(frame);
        assertEquals(finish.questionId, 1);
        seenFinish = true;
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

  try {
    const response = await client.call({ capabilityIndex: 0 }, 9, params);
    assertEquals(decodeSingleU32StructMessage(response), 88);
    assertEquals(seenCall, true);
    assertEquals(seenFinish, true);
  } finally {
    await session.close();
  }
});

Deno.test("SessionRpcClientTransport callRaw preserves call/result cap tables", async () => {
  const params = encodeSingleU32StructMessage(111);
  const results = encodeSingleU32StructMessage(222);
  let seenCall = false;

  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) {
        const call = decodeCallRequestFrame(frame);
        assertEquals(call.questionId, 1);
        assertEquals(decodeSingleU32StructMessage(call.paramsContent), 111);
        assertEquals(call.paramsCapTable.length, 2);
        assertEquals(call.paramsCapTable[0].tag, 1);
        assertEquals(call.paramsCapTable[0].id, 10);
        assertEquals(call.paramsCapTable[1].tag, 3);
        assertEquals(call.paramsCapTable[1].id, 11);
        seenCall = true;
        return [
          encodeReturnResultsFrame({
            answerId: call.questionId,
            content: results,
            capTable: [
              { tag: 1, id: 20 },
              { tag: 3, id: 21 },
            ],
          }),
        ];
      }
      if (tag === RPC_MESSAGE_TAG_FINISH) {
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

  try {
    const response = await client.callRaw(
      { capabilityIndex: 0 },
      9,
      params,
      {
        paramsCapTable: [
          { tag: 1, id: 10 },
          { tag: 3, id: 11 },
        ],
      },
    );
    assertEquals(decodeSingleU32StructMessage(response.contentBytes), 222);
    assertEquals(response.capTable.length, 2);
    assertEquals(response.capTable[0].tag, 1);
    assertEquals(response.capTable[0].id, 20);
    assertEquals(response.capTable[1].tag, 3);
    assertEquals(response.capTable[1].id, 21);
    assertEquals(seenCall, true);
  } finally {
    await session.close();
  }
});

Deno.test("SessionRpcClientTransport sends release frames", async () => {
  let seenRelease = false;

  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_RELEASE) {
        const release = decodeReleaseFrame(frame);
        assertEquals(release.id, 9);
        assertEquals(release.referenceCount, 2);
        seenRelease = true;
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

  try {
    await client.release({ capabilityIndex: 9 }, 2);
    assertEquals(seenRelease, true);
  } finally {
    await session.close();
  }
});

Deno.test("SessionRpcClientTransport stress: large cap-table lifecycle ordering is deterministic", async () => {
  const iterations = 4;
  const capTableSize = 48;
  const params = encodeSingleU32StructMessage(777);

  type Event =
    | { kind: "call"; questionId: number; paramsCapCount: number }
    | { kind: "finish"; questionId: number }
    | { kind: "release"; id: number; referenceCount: number };
  const events: Event[] = [];

  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) {
        const call = decodeCallRequestFrame(frame);
        events.push({
          kind: "call",
          questionId: call.questionId,
          paramsCapCount: call.paramsCapTable.length,
        });

        const iteration = call.methodId - 100;
        if (iteration < 0 || iteration >= iterations) {
          throw new Error(`unexpected methodId=${call.methodId}`);
        }
        const resultCapBase = 10_000 + (iteration * capTableSize);
        const resultCapTable = Array.from({ length: capTableSize }, (_, i) => ({
          tag: i % 2 === 0 ? 1 : 3,
          id: resultCapBase + i,
        }));

        return [
          encodeReturnResultsFrame({
            answerId: call.questionId,
            content: encodeSingleU32StructMessage(2_000 + iteration),
            capTable: resultCapTable,
          }),
        ];
      }
      if (tag === RPC_MESSAGE_TAG_FINISH) {
        const finish = decodeFinishFrame(frame);
        events.push({
          kind: "finish",
          questionId: finish.questionId,
        });
        return [];
      }
      if (tag === RPC_MESSAGE_TAG_RELEASE) {
        const release = decodeReleaseFrame(frame);
        events.push({
          kind: "release",
          id: release.id,
          referenceCount: release.referenceCount,
        });
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

  try {
    for (let iter = 0; iter < iterations; iter += 1) {
      const paramsCapBase = 1_000 + (iter * capTableSize);
      const paramsCapTable = Array.from({ length: capTableSize }, (_, i) => ({
        tag: i % 2 === 0 ? 1 : 3,
        id: paramsCapBase + i,
      }));

      const response = await client.callRaw(
        { capabilityIndex: 0 },
        100 + iter,
        params,
        { paramsCapTable },
      );
      assertEquals(response.answerId, iter + 1);
      assertEquals(response.capTable.length, capTableSize);
      for (let i = 0; i < capTableSize; i += 1) {
        const expectedId = 10_000 + (iter * capTableSize) + i;
        assertEquals(response.capTable[i].id, expectedId);
      }

      for (const cap of response.capTable) {
        await client.release({ capabilityIndex: cap.id }, 2);
      }
    }

    let cursor = 0;
    for (let iter = 0; iter < iterations; iter += 1) {
      const expectedQuestionId = iter + 1;
      const call = events[cursor++];
      assert(
        call?.kind === "call",
        `expected call event, got ${String(call?.kind)}`,
      );
      assertEquals(call.questionId, expectedQuestionId);
      assertEquals(call.paramsCapCount, capTableSize);

      const finish = events[cursor++];
      assert(
        finish?.kind === "finish",
        `expected finish event, got ${String(finish?.kind)}`,
      );
      assertEquals(finish.questionId, expectedQuestionId);

      const releaseBase = 10_000 + (iter * capTableSize);
      for (let i = 0; i < capTableSize; i += 1) {
        const release = events[cursor++];
        assert(
          release?.kind === "release",
          `expected release event, got ${String(release?.kind)}`,
        );
        assertEquals(release.id, releaseBase + i);
        assertEquals(release.referenceCount, 2);
      }
    }
    assertEquals(cursor, events.length);
  } finally {
    await session.close();
  }
});
