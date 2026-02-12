import {
  decodeBootstrapRequestFrame,
  decodeCallRequestFrame,
  decodeFinishFrame,
  decodeReleaseFrame,
  decodeRpcMessageTag,
  EMPTY_STRUCT_MESSAGE,
  encodeReturnExceptionFrame,
  encodeReturnResultsFrame,
  InMemoryRpcHarnessTransport,
  RPC_MESSAGE_TAG_BOOTSTRAP,
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_FINISH,
  RPC_MESSAGE_TAG_RELEASE,
  RpcSession,
  SessionError,
  SessionRpcClientTransport,
  WasmPeer,
} from "../../src/advanced.ts";
import { FakeCapnpWasm } from "../fake_wasm.ts";
import {
  BOOTSTRAP_Q1_SUCCESS_INBOUND,
  BOOTSTRAP_Q1_SUCCESS_OUTBOUND,
  CALL_BOOTSTRAP_CAP_Q2_INBOUND,
  CALL_BOOTSTRAP_CAP_Q2_OUTBOUND,
} from "../fixtures/rpc_frames.ts";
import { assert, assertBytes, assertEquals } from "../test_utils.ts";

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

Deno.test("SessionRpcClientTransport can override call target with promisedAnswer", async () => {
  const params = encodeSingleU32StructMessage(7);
  let seenPromisedTarget = false;

  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) {
        const call = decodeCallRequestFrame(frame);
        assertEquals(call.questionId, 1);
        assertEquals(call.target.tag, 1);
        if (call.target.tag !== 1) {
          throw new Error(
            `expected promisedAnswer target, got: ${call.target.tag}`,
          );
        }
        assertEquals(call.target.promisedAnswer.questionId, 55);
        assertEquals(call.target.promisedAnswer.transform?.length, 1);
        assertEquals(call.target.promisedAnswer.transform?.[0].tag, 1);
        assertEquals(call.target.promisedAnswer.transform?.[0].pointerIndex, 2);
        seenPromisedTarget = true;
        return [
          encodeReturnResultsFrame({
            answerId: call.questionId,
            content: encodeSingleU32StructMessage(8),
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
        target: {
          tag: 1,
          promisedAnswer: {
            questionId: 55,
            transform: [{ tag: 1, pointerIndex: 2 }],
          },
        },
      },
    );
    assertEquals(decodeSingleU32StructMessage(response.contentBytes), 8);
    assertEquals(seenPromisedTarget, true);
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

Deno.test("InMemoryRpcHarnessTransport nextOutboundFrame rejects on timeout", async () => {
  const transport = new InMemoryRpcHarnessTransport();
  transport.start(() => {});

  let thrown: unknown;
  try {
    await transport.nextOutboundFrame({ timeoutMs: 10 });
  } catch (error) {
    thrown = error;
  } finally {
    transport.close();
  }

  assert(
    thrown instanceof SessionError &&
      /rpc wait timed out after 10ms/i.test(thrown.message),
    `expected timeout SessionError, got: ${String(thrown)}`,
  );
});

Deno.test("InMemoryRpcHarnessTransport removes timed-out waiter before next send", async () => {
  const transport = new InMemoryRpcHarnessTransport();
  transport.start(() => {});

  try {
    let thrown: unknown;
    try {
      await transport.nextOutboundFrame({ timeoutMs: 10 });
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof SessionError &&
        /rpc wait timed out after 10ms/i.test(thrown.message),
      `expected timeout SessionError, got: ${String(thrown)}`,
    );

    transport.send(new Uint8Array([0xde, 0xad]));
    const frame = await transport.nextOutboundFrame({ timeoutMs: 50 });
    assertBytes(frame, [0xde, 0xad]);
  } finally {
    transport.close();
  }
});

Deno.test("InMemoryRpcHarnessTransport removes aborted waiter before next send", async () => {
  const transport = new InMemoryRpcHarnessTransport();
  transport.start(() => {});

  try {
    const controller = new AbortController();
    const pending = transport.nextOutboundFrame({ signal: controller.signal });
    controller.abort();

    let thrown: unknown;
    try {
      await pending;
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof SessionError &&
        /rpc wait aborted/i.test(thrown.message),
      `expected aborted SessionError, got: ${String(thrown)}`,
    );

    transport.send(new Uint8Array([0xbe, 0xef]));
    const frame = await transport.nextOutboundFrame({ timeoutMs: 50 });
    assertBytes(frame, [0xbe, 0xef]);
  } finally {
    transport.close();
  }
});

Deno.test("InMemoryRpcHarnessTransport nextOutboundFrame rejects on abort and close", async () => {
  const abortTransport = new InMemoryRpcHarnessTransport();
  abortTransport.start(() => {});
  const controller = new AbortController();
  controller.abort();

  let abortErr: unknown;
  try {
    await abortTransport.nextOutboundFrame({ signal: controller.signal });
  } catch (error) {
    abortErr = error;
  } finally {
    abortTransport.close();
  }
  assert(
    abortErr instanceof SessionError &&
      /rpc wait aborted/i.test(abortErr.message),
    `expected aborted SessionError, got: ${String(abortErr)}`,
  );

  const closeTransport = new InMemoryRpcHarnessTransport();
  closeTransport.start(() => {});
  const wait = closeTransport.nextOutboundFrame();
  closeTransport.close();
  let closeErr: unknown;
  try {
    await wait;
  } catch (error) {
    closeErr = error;
  }
  assert(
    closeErr instanceof SessionError &&
      /transport is closed/i.test(closeErr.message),
    `expected closed SessionError, got: ${String(closeErr)}`,
  );
});

Deno.test("InMemoryRpcHarnessTransport rejects start/send/emitInbound after close", async () => {
  const transport = new InMemoryRpcHarnessTransport();
  transport.close();

  let startErr: unknown;
  try {
    transport.start(() => {});
  } catch (error) {
    startErr = error;
  }
  assert(
    startErr instanceof SessionError &&
      /transport is closed/i.test(startErr.message),
    `expected start closed SessionError, got: ${String(startErr)}`,
  );

  let sendErr: unknown;
  try {
    transport.send(new Uint8Array([0x01]));
  } catch (error) {
    sendErr = error;
  }
  assert(
    sendErr instanceof SessionError &&
      /transport is closed/i.test(sendErr.message),
    `expected send closed SessionError, got: ${String(sendErr)}`,
  );

  let inboundErr: unknown;
  try {
    await transport.emitInbound(new Uint8Array([0x02]));
  } catch (error) {
    inboundErr = error;
  }
  assert(
    inboundErr instanceof SessionError &&
      /transport is closed/i.test(inboundErr.message),
    `expected emitInbound closed SessionError, got: ${String(inboundErr)}`,
  );
});

Deno.test("SessionRpcClientTransport skips undecodable and mismatched return frames", async () => {
  const params = encodeSingleU32StructMessage(777);
  const results = encodeSingleU32StructMessage(888);

  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) {
        const call = decodeCallRequestFrame(frame);
        return [
          new Uint8Array([0x00, 0x01, 0x02]),
          encodeReturnResultsFrame({
            answerId: call.questionId + 100,
            content: encodeSingleU32StructMessage(111),
          }),
          encodeReturnResultsFrame({
            answerId: call.questionId,
            content: results,
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
    const response = await client.call({ capabilityIndex: 0 }, 7, params);
    assertEquals(decodeSingleU32StructMessage(response), 888);
  } finally {
    await session.close();
  }
});

Deno.test("SessionRpcClientTransport respects autoStart=false and supports manual start", async () => {
  const params = encodeSingleU32StructMessage(111);
  const results = encodeSingleU32StructMessage(222);
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
    autoStart: false,
  });

  try {
    let notStartedErr: unknown;
    try {
      await client.call({ capabilityIndex: 0 }, 3, params, { timeoutMs: 20 });
    } catch (error) {
      notStartedErr = error;
    }
    assert(
      notStartedErr instanceof SessionError &&
        /transport is not started/i.test(notStartedErr.message),
      `expected not-started SessionError, got: ${String(notStartedErr)}`,
    );

    await session.start();
    const response = await client.call({ capabilityIndex: 0 }, 3, params);
    assertEquals(decodeSingleU32StructMessage(response), 222);
  } finally {
    await session.close();
  }
});

Deno.test("SessionRpcClientTransport.create can start internal session without explicit peer wiring", async () => {
  const transport = new InMemoryRpcHarnessTransport();
  const client = await SessionRpcClientTransport.create(transport, {
    interfaceId: 0x1234n,
    startSession: true,
  });

  try {
    assertEquals(client.session.started, true);
  } finally {
    await client.session.close();
  }
});

Deno.test("SessionRpcClientTransport surfaces wait timeout when no response arrives", async () => {
  const params = encodeSingleU32StructMessage(5);
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
  });

  try {
    let thrown: unknown;
    try {
      await client.call({ capabilityIndex: 0 }, 1, params, { timeoutMs: 10 });
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof SessionError &&
        /timed out after 10ms/i.test(thrown.message),
      `expected wait-timeout SessionError, got: ${String(thrown)}`,
    );
  } finally {
    await session.close();
  }
});

Deno.test("InMemoryRpcHarnessTransport resolves pending waiter via send and supports abort listener wiring", async () => {
  const transport = new InMemoryRpcHarnessTransport();
  transport.start(() => {});

  try {
    const controller = new AbortController();
    const pending = transport.nextOutboundFrame({
      signal: controller.signal,
      timeoutMs: 500,
    });
    transport.send(new Uint8Array([0xaa, 0xbb]));
    const frame = await pending;
    assertBytes(frame, [0xaa, 0xbb]);
  } finally {
    transport.close();
  }
});

Deno.test("InMemoryRpcHarnessTransport aborts pending waiter and close is idempotent", async () => {
  const transport = new InMemoryRpcHarnessTransport();
  transport.start(() => {});

  const controller = new AbortController();
  const pending = transport.nextOutboundFrame({ signal: controller.signal });
  controller.abort();

  let abortErr: unknown;
  try {
    await pending;
  } catch (error) {
    abortErr = error;
  }
  assert(
    abortErr instanceof SessionError &&
      /rpc wait aborted/i.test(abortErr.message),
    `expected aborted SessionError, got: ${String(abortErr)}`,
  );

  transport.close();
  transport.close();

  let closedErr: unknown;
  try {
    await transport.nextOutboundFrame();
  } catch (error) {
    closedErr = error;
  }
  assert(
    closedErr instanceof SessionError &&
      /transport is closed/i.test(closedErr.message),
    `expected closed SessionError, got: ${String(closedErr)}`,
  );
});

Deno.test("SessionRpcClientTransport bootstrap surfaces exception and reports question id", async () => {
  let seenQuestionId = -1;
  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag !== RPC_MESSAGE_TAG_BOOTSTRAP) {
        throw new Error(`unexpected inbound rpc tag=${tag}`);
      }
      const bootstrap = decodeBootstrapRequestFrame(frame);
      return [
        encodeReturnExceptionFrame({
          answerId: bootstrap.questionId,
          reason: "bootstrap denied",
        }),
      ];
    },
  });

  const peer = WasmPeer.fromExports(fake.exports, { expectedVersion: 1 });
  const transport = new InMemoryRpcHarnessTransport();
  const session = new RpcSession(peer, transport);
  const client = new SessionRpcClientTransport(session, transport, {
    interfaceId: 0x1234,
  });

  try {
    let thrown: unknown;
    try {
      await client.bootstrap({
        onQuestionId: (questionId) => {
          seenQuestionId = questionId;
        },
      });
    } catch (error) {
      thrown = error;
    }
    assertEquals(seenQuestionId, 1);
    assert(
      thrown instanceof Error &&
        /rpc bootstrap failed: bootstrap denied/i.test(thrown.message),
      `expected bootstrap exception propagation, got: ${String(thrown)}`,
    );
  } finally {
    await session.close();
  }
});

Deno.test("SessionRpcClientTransport callRaw reports question ids and explicit finish flags", async () => {
  const params = encodeSingleU32StructMessage(55);
  const results = encodeSingleU32StructMessage(66);
  const seenQuestionIds: number[] = [];
  const seenFinishFlags: Array<{
    releaseResultCaps: boolean;
    requireEarlyCancellation: boolean;
  }> = [];

  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) {
        const call = decodeCallRequestFrame(frame);
        return [
          encodeReturnResultsFrame({
            answerId: call.questionId,
            content: results,
            noFinishNeeded: true,
          }),
        ];
      }
      if (tag === RPC_MESSAGE_TAG_FINISH) {
        const finish = decodeFinishFrame(frame);
        seenFinishFlags.push({
          releaseResultCaps: finish.releaseResultCaps,
          requireEarlyCancellation: finish.requireEarlyCancellation,
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
    const response = await client.callRaw(
      { capabilityIndex: 7 },
      3,
      params,
      {
        onQuestionId: (questionId) => {
          seenQuestionIds.push(questionId);
        },
      },
    );
    assertEquals(decodeSingleU32StructMessage(response.contentBytes), 66);
    assertEquals(seenQuestionIds.join(","), "1");
    assertEquals(seenFinishFlags.length, 0);

    await client.finish(response.answerId, {
      releaseResultCaps: false,
      requireEarlyCancellation: true,
    });
    assertEquals(seenFinishFlags.length, 1);
    assertEquals(seenFinishFlags[0].releaseResultCaps, false);
    assertEquals(seenFinishFlags[0].requireEarlyCancellation, true);
  } finally {
    await session.close();
  }
});
