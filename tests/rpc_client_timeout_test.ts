import {
  decodeCallRequestFrame,
  decodeRpcMessageTag,
  encodeReturnResultsFrame,
  InMemoryRpcHarnessTransport,
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_FINISH,
  RpcSession,
  SessionError,
  SessionRpcClientTransport,
  WasmPeer,
} from "../mod.ts";
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

const MASK_30 = 0x3fff_ffffn;

function decodeSingleU32StructMessage(frame: Uint8Array): number {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const root = view.getBigUint64(8, true);
  const rawOffset = Number((root >> 2n) & MASK_30);
  const offset = (rawOffset & (1 << 29)) !== 0
    ? rawOffset - (1 << 30)
    : rawOffset;
  const dataWord = 1 + offset;
  return view.getUint32(8 + dataWord * 8, true);
}

Deno.test("defaultTimeoutMs causes call to time out when no response arrives", async () => {
  const params = encodeSingleU32StructMessage(42);
  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) return [];
      throw new Error(`unexpected inbound rpc tag=${tag}`);
    },
  });

  const peer = WasmPeer.fromExports(fake.exports, { expectedVersion: 1 });
  const transport = new InMemoryRpcHarnessTransport();
  const session = new RpcSession(peer, transport);
  const client = new SessionRpcClientTransport(session, transport, {
    interfaceId: 0x1234n,
    defaultTimeoutMs: 20,
  });

  try {
    let thrown: unknown;
    try {
      await client.call({ capabilityIndex: 0 }, 1, params);
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof SessionError &&
        /timed out after 20ms/i.test(thrown.message),
      `expected default-timeout SessionError, got: ${String(thrown)}`,
    );
  } finally {
    await session.close();
  }
});

Deno.test("per-call timeoutMs overrides defaultTimeoutMs", async () => {
  const params = encodeSingleU32StructMessage(42);
  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) return [];
      throw new Error(`unexpected inbound rpc tag=${tag}`);
    },
  });

  const peer = WasmPeer.fromExports(fake.exports, { expectedVersion: 1 });
  const transport = new InMemoryRpcHarnessTransport();
  const session = new RpcSession(peer, transport);
  const client = new SessionRpcClientTransport(session, transport, {
    interfaceId: 0x1234n,
    defaultTimeoutMs: 5000,
  });

  try {
    const start = Date.now();
    let thrown: unknown;
    try {
      await client.call({ capabilityIndex: 0 }, 1, params, { timeoutMs: 15 });
    } catch (error) {
      thrown = error;
    }
    const elapsed = Date.now() - start;
    assert(
      thrown instanceof SessionError &&
        /timed out after 15ms/i.test(thrown.message),
      `expected per-call timeout SessionError, got: ${String(thrown)}`,
    );
    assert(
      elapsed < 1000,
      `expected fast timeout via per-call override, elapsed=${elapsed}ms`,
    );
  } finally {
    await session.close();
  }
});

Deno.test("calls without any timeout still work (backward compat)", async () => {
  const params = encodeSingleU32StructMessage(77);
  const results = encodeSingleU32StructMessage(88);

  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) {
        const call = decodeCallRequestFrame(frame);
        return [
          encodeReturnResultsFrame({
            answerId: call.questionId,
            content: results,
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
    const response = await client.call({ capabilityIndex: 0 }, 9, params);
    const view = new DataView(
      response.buffer,
      response.byteOffset,
      response.byteLength,
    );
    const MASK_30 = 0x3fff_ffffn;
    const root = view.getBigUint64(8, true);
    const rawOffset = Number((root >> 2n) & MASK_30);
    const offset = (rawOffset & (1 << 29)) !== 0
      ? rawOffset - (1 << 30)
      : rawOffset;
    const dataWord = 1 + offset;
    const value = view.getUint32(8 + dataWord * 8, true);
    assertEquals(value, 88);
  } finally {
    await session.close();
  }
});

Deno.test("defaultTimeoutMs applies to bootstrap", async () => {
  const fake = new FakeCapnpWasm({
    onPushFrame: () => {
      return [];
    },
  });

  const peer = WasmPeer.fromExports(fake.exports, { expectedVersion: 1 });
  const transport = new InMemoryRpcHarnessTransport();
  const session = new RpcSession(peer, transport);
  const client = new SessionRpcClientTransport(session, transport, {
    interfaceId: 0x1234n,
    defaultTimeoutMs: 20,
  });

  try {
    let thrown: unknown;
    try {
      await client.bootstrap();
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof SessionError &&
        /timed out after 20ms/i.test(thrown.message),
      `expected bootstrap default-timeout SessionError, got: ${String(thrown)}`,
    );
  } finally {
    await session.close();
  }
});

Deno.test("defaultTimeoutMs applies to callRaw", async () => {
  const params = encodeSingleU32StructMessage(42);
  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) return [];
      throw new Error(`unexpected inbound rpc tag=${tag}`);
    },
  });

  const peer = WasmPeer.fromExports(fake.exports, { expectedVersion: 1 });
  const transport = new InMemoryRpcHarnessTransport();
  const session = new RpcSession(peer, transport);
  const client = new SessionRpcClientTransport(session, transport, {
    interfaceId: 0x1234n,
    defaultTimeoutMs: 20,
  });

  try {
    let thrown: unknown;
    try {
      await client.callRaw({ capabilityIndex: 0 }, 1, params);
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof SessionError &&
        /timed out after 20ms/i.test(thrown.message),
      `expected callRaw default-timeout SessionError, got: ${String(thrown)}`,
    );
  } finally {
    await session.close();
  }
});

Deno.test("defaultTimeoutMs applies to callRawPipelined response collection", async () => {
  const params = encodeSingleU32StructMessage(42);
  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) return [];
      throw new Error(`unexpected inbound rpc tag=${tag}`);
    },
  });

  const peer = WasmPeer.fromExports(fake.exports, { expectedVersion: 1 });
  const transport = new InMemoryRpcHarnessTransport();
  const session = new RpcSession(peer, transport);
  const client = new SessionRpcClientTransport(session, transport, {
    interfaceId: 0x1234n,
    defaultTimeoutMs: 20,
  });

  try {
    const { result } = await client.callRawPipelined(
      { capabilityIndex: 0 },
      1,
      params,
    );

    let thrown: unknown;
    try {
      await result;
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof SessionError &&
        /timed out after 20ms/i.test(thrown.message),
      `expected pipelined default-timeout SessionError, got: ${String(thrown)}`,
    );
  } finally {
    await session.close();
  }
});

Deno.test("call succeeds with defaultTimeoutMs when response arrives in time", async () => {
  const params = encodeSingleU32StructMessage(77);
  const results = encodeSingleU32StructMessage(88);

  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) {
        const call = decodeCallRequestFrame(frame);
        return [
          encodeReturnResultsFrame({
            answerId: call.questionId,
            content: results,
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
    defaultTimeoutMs: 5000,
  });

  try {
    const response = await client.call({ capabilityIndex: 0 }, 9, params);
    assertEquals(decodeSingleU32StructMessage(response), 88);
  } finally {
    await session.close();
  }
});

Deno.test("callRawPipelined and callRaw do not drop out-of-order return frames", async () => {
  const call1Params = encodeSingleU32StructMessage(1);
  const call2Params = encodeSingleU32StructMessage(2);
  const call1Results = encodeSingleU32StructMessage(101);
  const call2Results = encodeSingleU32StructMessage(202);
  let firstQuestionId = -1;

  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_FINISH) {
        return [];
      }
      if (tag !== RPC_MESSAGE_TAG_CALL) {
        throw new Error(`unexpected inbound rpc tag=${tag}`);
      }
      const call = decodeCallRequestFrame(frame);
      if (firstQuestionId === -1) {
        firstQuestionId = call.questionId;
        // Delay response for the first call to force out-of-order delivery.
        return [];
      }
      return [
        encodeReturnResultsFrame({
          answerId: call.questionId,
          content: call2Results,
        }),
        encodeReturnResultsFrame({
          answerId: firstQuestionId,
          content: call1Results,
        }),
      ];
    },
  });

  const peer = WasmPeer.fromExports(fake.exports, { expectedVersion: 1 });
  const transport = new InMemoryRpcHarnessTransport();
  const session = new RpcSession(peer, transport);
  const client = new SessionRpcClientTransport(session, transport, {
    interfaceId: 0x1234n,
    defaultTimeoutMs: 50,
  });

  try {
    const { pipeline, result } = await client.callRawPipelined(
      { capabilityIndex: 0 },
      1,
      call1Params,
    );
    const call2 = await client.callRaw(
      { capabilityIndex: 0 },
      2,
      call2Params,
      { autoFinish: false, timeoutMs: 30 },
    );
    const call1 = await result;

    assertEquals(pipeline.questionId, firstQuestionId);
    assertEquals(decodeSingleU32StructMessage(call2.contentBytes), 202);
    assertEquals(decodeSingleU32StructMessage(call1.contentBytes), 101);

    // callRawPipelined never auto-finishes, so explicitly clean up.
    await client.finish(pipeline.questionId);
  } finally {
    await session.close();
  }
});

Deno.test("callRaw ignores unexpected preplayed return for a future questionId", async () => {
  const call1Params = encodeSingleU32StructMessage(1);
  const call2Params = encodeSingleU32StructMessage(2);
  const call1Results = encodeSingleU32StructMessage(111);
  const forgedFutureResults = encodeSingleU32StructMessage(999);
  const call2Results = encodeSingleU32StructMessage(222);
  let firstQuestionId = -1;

  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_FINISH) {
        return [];
      }
      if (tag !== RPC_MESSAGE_TAG_CALL) {
        throw new Error(`unexpected inbound rpc tag=${tag}`);
      }
      const call = decodeCallRequestFrame(frame);
      if (firstQuestionId === -1) {
        firstQuestionId = call.questionId;
        // Inject a forged response for the next question before it is sent.
        return [
          encodeReturnResultsFrame({
            answerId: call.questionId + 1,
            content: forgedFutureResults,
          }),
          encodeReturnResultsFrame({
            answerId: call.questionId,
            content: call1Results,
          }),
        ];
      }
      return [
        encodeReturnResultsFrame({
          answerId: call.questionId,
          content: call2Results,
        }),
      ];
    },
  });

  const peer = WasmPeer.fromExports(fake.exports, { expectedVersion: 1 });
  const transport = new InMemoryRpcHarnessTransport();
  const session = new RpcSession(peer, transport);
  const client = new SessionRpcClientTransport(session, transport, {
    interfaceId: 0x1234n,
    defaultTimeoutMs: 100,
  });

  try {
    const call1 = await client.callRaw(
      { capabilityIndex: 0 },
      1,
      call1Params,
      { autoFinish: false },
    );
    const call2 = await client.callRaw(
      { capabilityIndex: 0 },
      2,
      call2Params,
      { autoFinish: false },
    );

    assertEquals(firstQuestionId, call1.answerId);
    assertEquals(decodeSingleU32StructMessage(call1.contentBytes), 111);
    assertEquals(decodeSingleU32StructMessage(call2.contentBytes), 222);

    await client.finish(call1.answerId);
    await client.finish(call2.answerId);
  } finally {
    await session.close();
  }
});
