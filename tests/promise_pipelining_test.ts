import {
  decodeCallRequestFrame,
  decodeRpcMessageTag,
  encodeCallRequestFrame,
  encodeReturnResultsFrame,
  InMemoryRpcHarnessTransport,
  RPC_CALL_TARGET_TAG_PROMISED_ANSWER,
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_FINISH,
  RpcPipeline,
  RpcServerBridge,
  RpcSession,
  SessionRpcClientTransport,
  WasmPeer,
} from "../mod.ts";
import { FakeCapnpWasm } from "./fake_wasm.ts";
import { assert, assertEquals } from "./test_utils.ts";

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

// --- RpcPipeline unit tests ---

Deno.test("RpcPipeline creates correct call target with no transform", () => {
  const pipeline = new RpcPipeline(42);
  const target = pipeline.toCallTarget();
  assertEquals(target.tag, RPC_CALL_TARGET_TAG_PROMISED_ANSWER);
  if (target.tag === RPC_CALL_TARGET_TAG_PROMISED_ANSWER) {
    assertEquals(target.promisedAnswer.questionId, 42);
    assertEquals(target.promisedAnswer.transform, undefined);
  }
});

Deno.test("RpcPipeline getPointerField creates correct transform chain", () => {
  const pipeline = new RpcPipeline(10);
  const field2 = pipeline.getPointerField(2);
  const target = field2.toCallTarget();
  assertEquals(target.tag, RPC_CALL_TARGET_TAG_PROMISED_ANSWER);
  if (target.tag === RPC_CALL_TARGET_TAG_PROMISED_ANSWER) {
    assertEquals(target.promisedAnswer.questionId, 10);
    assertEquals(target.promisedAnswer.transform?.length, 1);
    assertEquals(target.promisedAnswer.transform?.[0].tag, 1);
    assertEquals(target.promisedAnswer.transform?.[0].pointerIndex, 2);
  }
});

Deno.test("RpcPipeline chained getPointerField builds compound transform", () => {
  const pipeline = new RpcPipeline(5);
  const deep = pipeline.getPointerField(0).getPointerField(3);
  const target = deep.toCallTarget();
  if (target.tag === RPC_CALL_TARGET_TAG_PROMISED_ANSWER) {
    assertEquals(target.promisedAnswer.transform?.length, 2);
    assertEquals(target.promisedAnswer.transform?.[0].pointerIndex, 0);
    assertEquals(target.promisedAnswer.transform?.[1].pointerIndex, 3);
  }
});

// --- Server-side promise pipelining via RpcServerBridge ---

Deno.test("RpcServerBridge: full pipelining flow with factory pattern", async () => {
  const bridge = new RpcServerBridge();

  // The "factory" returns a capability in its cap table.
  bridge.exportCapability({
    interfaceId: 0xAAAAn,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(1),
        capTable: [{ tag: 1, id: 50 }],
      }),
  }, { capabilityIndex: 1 });

  // The "service" capability that the factory returns.
  let serviceCalled = false;
  bridge.exportCapability({
    interfaceId: 0xBBBBn,
    dispatch: (_method, params, ctx) => {
      serviceCalled = true;
      assertEquals(ctx.target.tag, RPC_CALL_TARGET_TAG_PROMISED_ANSWER);
      return Promise.resolve(encodeSingleU32StructMessage(
        decodeSingleU32StructMessage(params) + 100,
      ));
    },
  }, { capabilityIndex: 50 });

  // Step 1: Call the factory.
  const factoryFrame = await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 1,
      interfaceId: 0xAAAAn,
      methodId: 0,
      targetImportedCap: 1,
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );
  assert(factoryFrame !== null, "expected factory response");

  // Step 2: Make a pipelined call targeting question 1's result.
  const pipelinedFrame = await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 2,
      interfaceId: 0xBBBBn,
      methodId: 5,
      target: {
        tag: 1,
        promisedAnswer: {
          questionId: 1,
          transform: [],
        },
      },
      paramsContent: encodeSingleU32StructMessage(42),
    }),
  );
  assert(pipelinedFrame !== null, "expected pipelined response");

  assertEquals(serviceCalled, true);
});

// --- Client-side pipeline API tests ---

Deno.test("SessionRpcClientTransport callRawPipelined returns pipeline and result", async () => {
  const params = encodeSingleU32StructMessage(7);
  const results = encodeSingleU32StructMessage(77);
  let seenQuestionId = -1;

  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) {
        const call = decodeCallRequestFrame(frame);
        seenQuestionId = call.questionId;
        return [
          encodeReturnResultsFrame({
            answerId: call.questionId,
            content: results,
            capTable: [{ tag: 1, id: 42 }],
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
    const { pipeline, result } = await client.callRawPipelined(
      { capabilityIndex: 0 },
      9,
      params,
    );

    // The pipeline should have the correct question ID.
    assertEquals(pipeline.questionId, seenQuestionId);

    // The result should eventually resolve.
    const response = await result;
    assertEquals(decodeSingleU32StructMessage(response.contentBytes), 77);
    assertEquals(response.capTable.length, 1);
    assertEquals(response.capTable[0].id, 42);

    // Clean up: send finish.
    await client.finish(pipeline.questionId);
  } finally {
    await session.close();
  }
});

Deno.test("SessionRpcClientTransport pipeline target is sent correctly on the wire", async () => {
  let seenPipelinedTarget = false;
  const params = encodeSingleU32StructMessage(55);

  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) {
        const call = decodeCallRequestFrame(frame);

        // Check if this is the pipelined call (question 2).
        if (call.questionId === 2) {
          assertEquals(call.target.tag, RPC_CALL_TARGET_TAG_PROMISED_ANSWER);
          if (call.target.tag === RPC_CALL_TARGET_TAG_PROMISED_ANSWER) {
            assertEquals(call.target.promisedAnswer.questionId, 1);
            seenPipelinedTarget = true;
          }
        }

        return [
          encodeReturnResultsFrame({
            answerId: call.questionId,
            content: encodeSingleU32StructMessage(call.questionId * 10),
            capTable: [{ tag: 1, id: call.questionId + 100 }],
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
    // First call: get a pipeline handle.
    const { pipeline, result: result1 } = await client.callRawPipelined(
      { capabilityIndex: 0 },
      1,
      params,
    );

    // Second call: use the pipeline to make a pipelined call.
    const target = pipeline.toCallTarget();
    const result2 = await client.callRaw(
      { capabilityIndex: 0 },
      2,
      params,
      { target, autoFinish: true },
    );

    // Verify the first call completed.
    const resp1 = await result1;
    assertEquals(decodeSingleU32StructMessage(resp1.contentBytes), 10);

    // Verify the pipelined call completed.
    assertEquals(decodeSingleU32StructMessage(result2.contentBytes), 20);
    assertEquals(seenPipelinedTarget, true);

    // Clean up the first question's finish.
    await client.finish(pipeline.questionId);
  } finally {
    await session.close();
  }
});

Deno.test("RpcPipeline getPointerField produces correct wire target", async () => {
  let seenTransform = false;
  const params = encodeSingleU32StructMessage(0);

  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) {
        const call = decodeCallRequestFrame(frame);
        if (call.questionId === 2) {
          assertEquals(call.target.tag, RPC_CALL_TARGET_TAG_PROMISED_ANSWER);
          if (call.target.tag === RPC_CALL_TARGET_TAG_PROMISED_ANSWER) {
            assertEquals(call.target.promisedAnswer.questionId, 1);
            assertEquals(call.target.promisedAnswer.transform?.length, 1);
            assertEquals(
              call.target.promisedAnswer.transform?.[0].pointerIndex,
              2,
            );
            seenTransform = true;
          }
        }
        return [
          encodeReturnResultsFrame({
            answerId: call.questionId,
            content: encodeSingleU32StructMessage(0),
            capTable: [
              { tag: 1, id: 100 },
              { tag: 1, id: 101 },
              { tag: 1, id: 102 },
            ],
          }),
        ];
      }
      if (tag === RPC_MESSAGE_TAG_FINISH) return [];
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
    const { pipeline, result: _result1 } = await client.callRawPipelined(
      { capabilityIndex: 0 },
      1,
      params,
    );

    // Use getPointerField(2) to select the third capability.
    const target = pipeline.getPointerField(2).toCallTarget();
    await client.callRaw(
      { capabilityIndex: 0 },
      2,
      params,
      { target, autoFinish: true },
    );

    assertEquals(seenTransform, true);
    await _result1; // consume the promise
    await client.finish(pipeline.questionId);
  } finally {
    await session.close();
  }
});
