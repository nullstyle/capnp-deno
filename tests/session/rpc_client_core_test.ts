import {
  decodeBootstrapRequestFrame,
  decodeCallRequestFrame,
  decodeFinishFrame,
  decodeRpcMessageTag,
  encodeReturnExceptionFrame,
  encodeReturnResultsFrame,
  InMemoryRpcHarnessTransport,
  ProtocolError,
  RPC_MESSAGE_TAG_BOOTSTRAP,
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_FINISH,
  RpcSession,
  SessionError,
  SessionRpcClientTransport,
  WasmPeer,
} from "../../src/advanced.ts";
import { FakeCapnpWasm } from "../fake_wasm.ts";
import { assert, assertEquals } from "../test_utils.ts";

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

/** Helper to create a fully wired client transport with a FakeCapnpWasm. */
function createClient(
  onPushFrame: (frame: Uint8Array) => Uint8Array[],
  options?: {
    interfaceId?: bigint;
    nextQuestionId?: number;
    defaultTimeoutMs?: number;
    autoStart?: boolean;
  },
): {
  client: SessionRpcClientTransport;
  session: RpcSession;
  transport: InMemoryRpcHarnessTransport;
} {
  const fake = new FakeCapnpWasm({ onPushFrame });
  const peer = WasmPeer.fromExports(fake.exports, { expectedVersion: 1 });
  const transport = new InMemoryRpcHarnessTransport();
  const session = new RpcSession(peer, transport);
  const client = new SessionRpcClientTransport(session, transport, {
    interfaceId: options?.interfaceId ?? 0x1234n,
    nextQuestionId: options?.nextQuestionId,
    defaultTimeoutMs: options?.defaultTimeoutMs,
    autoStart: options?.autoStart,
  });
  return { client, session, transport };
}

// ---------------------------------------------------------------------------
// Basic call and response roundtrip
// ---------------------------------------------------------------------------

Deno.test("client core: basic call roundtrip returns correct content bytes", async () => {
  const params = encodeSingleU32StructMessage(42);
  const results = encodeSingleU32StructMessage(84);

  const { client, session } = createClient((frame) => {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_CALL) {
      const call = decodeCallRequestFrame(frame);
      assertEquals(decodeSingleU32StructMessage(call.paramsContent), 42);
      return [
        encodeReturnResultsFrame({
          answerId: call.questionId,
          content: results,
        }),
      ];
    }
    if (tag === RPC_MESSAGE_TAG_FINISH) return [];
    throw new Error(`unexpected tag=${tag}`);
  });

  try {
    const response = await client.call({ capabilityIndex: 0 }, 1, params);
    assertEquals(decodeSingleU32StructMessage(response), 84);
  } finally {
    await session.close();
  }
});

Deno.test("client core: callRaw roundtrip preserves answerId and cap table", async () => {
  const params = encodeSingleU32StructMessage(10);
  const results = encodeSingleU32StructMessage(20);

  const { client, session } = createClient((frame) => {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_CALL) {
      const call = decodeCallRequestFrame(frame);
      return [
        encodeReturnResultsFrame({
          answerId: call.questionId,
          content: results,
          capTable: [{ tag: 1, id: 55 }],
          releaseParamCaps: false,
          noFinishNeeded: true,
        }),
      ];
    }
    if (tag === RPC_MESSAGE_TAG_FINISH) return [];
    throw new Error(`unexpected tag=${tag}`);
  });

  try {
    const response = await client.callRaw(
      { capabilityIndex: 0 },
      3,
      params,
    );
    assertEquals(response.answerId, 1);
    assertEquals(decodeSingleU32StructMessage(response.contentBytes), 20);
    assertEquals(response.capTable.length, 1);
    assertEquals(response.capTable[0].tag, 1);
    assertEquals(response.capTable[0].id, 55);
    assertEquals(response.releaseParamCaps, false);
    assertEquals(response.noFinishNeeded, true);
  } finally {
    await session.close();
  }
});

// ---------------------------------------------------------------------------
// Error response handling (exception return frame)
// ---------------------------------------------------------------------------

Deno.test("client core: call throws ProtocolError on exception return", async () => {
  const params = encodeSingleU32StructMessage(1);

  const { client, session } = createClient((frame) => {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_CALL) {
      const call = decodeCallRequestFrame(frame);
      return [
        encodeReturnExceptionFrame({
          answerId: call.questionId,
          reason: "something went wrong",
        }),
      ];
    }
    if (tag === RPC_MESSAGE_TAG_FINISH) return [];
    throw new Error(`unexpected tag=${tag}`);
  });

  try {
    let thrown: unknown;
    try {
      await client.call({ capabilityIndex: 0 }, 0, params);
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof ProtocolError &&
        /rpc call failed: something went wrong/i.test(thrown.message),
      `expected ProtocolError with call failure, got: ${String(thrown)}`,
    );
  } finally {
    await session.close();
  }
});

Deno.test("client core: bootstrap throws ProtocolError on exception return", async () => {
  const { client, session } = createClient((frame) => {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_BOOTSTRAP) {
      const bootstrap = decodeBootstrapRequestFrame(frame);
      return [
        encodeReturnExceptionFrame({
          answerId: bootstrap.questionId,
          reason: "denied",
        }),
      ];
    }
    throw new Error(`unexpected tag=${tag}`);
  });

  try {
    let thrown: unknown;
    try {
      await client.bootstrap();
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof ProtocolError &&
        /rpc bootstrap failed: denied/i.test(thrown.message),
      `expected ProtocolError with bootstrap failure, got: ${String(thrown)}`,
    );
  } finally {
    await session.close();
  }
});

// ---------------------------------------------------------------------------
// Question ID allocation and cleanup after response
// ---------------------------------------------------------------------------

Deno.test("client core: question IDs increment sequentially starting from 1", async () => {
  const seenQuestionIds: number[] = [];

  const { client, session } = createClient((frame) => {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_CALL) {
      const call = decodeCallRequestFrame(frame);
      seenQuestionIds.push(call.questionId);
      return [
        encodeReturnResultsFrame({
          answerId: call.questionId,
          content: encodeSingleU32StructMessage(0),
        }),
      ];
    }
    if (tag === RPC_MESSAGE_TAG_FINISH) return [];
    throw new Error(`unexpected tag=${tag}`);
  });

  try {
    const params = encodeSingleU32StructMessage(0);
    await client.call({ capabilityIndex: 0 }, 0, params);
    await client.call({ capabilityIndex: 0 }, 0, params);
    await client.call({ capabilityIndex: 0 }, 0, params);

    assertEquals(seenQuestionIds.length, 3);
    assertEquals(seenQuestionIds[0], 1);
    assertEquals(seenQuestionIds[1], 2);
    assertEquals(seenQuestionIds[2], 3);
  } finally {
    await session.close();
  }
});

Deno.test("client core: question IDs start from custom value", async () => {
  const seenQuestionIds: number[] = [];

  const { client, session } = createClient(
    (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) {
        const call = decodeCallRequestFrame(frame);
        seenQuestionIds.push(call.questionId);
        return [
          encodeReturnResultsFrame({
            answerId: call.questionId,
            content: encodeSingleU32StructMessage(0),
          }),
        ];
      }
      if (tag === RPC_MESSAGE_TAG_FINISH) return [];
      throw new Error(`unexpected tag=${tag}`);
    },
    { nextQuestionId: 100 },
  );

  try {
    const params = encodeSingleU32StructMessage(0);
    await client.call({ capabilityIndex: 0 }, 0, params);
    await client.call({ capabilityIndex: 0 }, 0, params);

    assertEquals(seenQuestionIds[0], 100);
    assertEquals(seenQuestionIds[1], 101);
  } finally {
    await session.close();
  }
});

Deno.test("client core: onQuestionId callback fires before response", async () => {
  let reportedQuestionId = -1;

  const { client, session } = createClient((frame) => {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_CALL) {
      const call = decodeCallRequestFrame(frame);
      return [
        encodeReturnResultsFrame({
          answerId: call.questionId,
          content: encodeSingleU32StructMessage(0),
        }),
      ];
    }
    if (tag === RPC_MESSAGE_TAG_FINISH) return [];
    throw new Error(`unexpected tag=${tag}`);
  });

  try {
    await client.call(
      { capabilityIndex: 0 },
      0,
      encodeSingleU32StructMessage(0),
      {
        onQuestionId: (qid) => {
          reportedQuestionId = qid;
        },
      },
    );
    assertEquals(reportedQuestionId, 1);
  } finally {
    await session.close();
  }
});

Deno.test("client core: finish frame sent after successful call by default", async () => {
  let finishSeen = false;
  let finishQuestionId = -1;

  const { client, session } = createClient((frame) => {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_CALL) {
      const call = decodeCallRequestFrame(frame);
      return [
        encodeReturnResultsFrame({
          answerId: call.questionId,
          content: encodeSingleU32StructMessage(0),
        }),
      ];
    }
    if (tag === RPC_MESSAGE_TAG_FINISH) {
      finishSeen = true;
      finishQuestionId = decodeFinishFrame(frame).questionId;
      return [];
    }
    throw new Error(`unexpected tag=${tag}`);
  });

  try {
    await client.call(
      { capabilityIndex: 0 },
      0,
      encodeSingleU32StructMessage(0),
    );
    assertEquals(finishSeen, true);
    assertEquals(finishQuestionId, 1);
  } finally {
    await session.close();
  }
});

Deno.test("client core: noFinishNeeded suppresses auto-finish", async () => {
  let finishSeen = false;

  const { client, session } = createClient((frame) => {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_CALL) {
      const call = decodeCallRequestFrame(frame);
      return [
        encodeReturnResultsFrame({
          answerId: call.questionId,
          content: encodeSingleU32StructMessage(0),
          noFinishNeeded: true,
        }),
      ];
    }
    if (tag === RPC_MESSAGE_TAG_FINISH) {
      finishSeen = true;
      return [];
    }
    throw new Error(`unexpected tag=${tag}`);
  });

  try {
    await client.callRaw(
      { capabilityIndex: 0 },
      0,
      encodeSingleU32StructMessage(0),
    );
    assertEquals(finishSeen, false);
  } finally {
    await session.close();
  }
});

// ---------------------------------------------------------------------------
// Multiple concurrent calls (serialized through op chain)
// ---------------------------------------------------------------------------

Deno.test("client core: sequential calls are serialized correctly", async () => {
  const callOrder: number[] = [];

  const { client, session } = createClient((frame) => {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_CALL) {
      const call = decodeCallRequestFrame(frame);
      callOrder.push(call.questionId);
      return [
        encodeReturnResultsFrame({
          answerId: call.questionId,
          content: encodeSingleU32StructMessage(call.questionId * 10),
        }),
      ];
    }
    if (tag === RPC_MESSAGE_TAG_FINISH) return [];
    throw new Error(`unexpected tag=${tag}`);
  });

  try {
    const params = encodeSingleU32StructMessage(0);

    // Issue multiple calls sequentially.
    const r1 = await client.call({ capabilityIndex: 0 }, 0, params);
    const r2 = await client.call({ capabilityIndex: 0 }, 1, params);
    const r3 = await client.call({ capabilityIndex: 0 }, 2, params);

    assertEquals(decodeSingleU32StructMessage(r1), 10);
    assertEquals(decodeSingleU32StructMessage(r2), 20);
    assertEquals(decodeSingleU32StructMessage(r3), 30);

    assertEquals(callOrder.length, 3);
    assertEquals(callOrder[0], 1);
    assertEquals(callOrder[1], 2);
    assertEquals(callOrder[2], 3);
  } finally {
    await session.close();
  }
});

// ---------------------------------------------------------------------------
// Call after close throws appropriate error
// ---------------------------------------------------------------------------

Deno.test("client core: call after session close throws SessionError", async () => {
  const { client, session } = createClient((frame) => {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_CALL) {
      const call = decodeCallRequestFrame(frame);
      return [
        encodeReturnResultsFrame({
          answerId: call.questionId,
          content: encodeSingleU32StructMessage(0),
        }),
      ];
    }
    if (tag === RPC_MESSAGE_TAG_FINISH) return [];
    throw new Error(`unexpected tag=${tag}`);
  });

  // Start and immediately close the session.
  await session.start();
  await session.close();

  let thrown: unknown;
  try {
    await client.call(
      { capabilityIndex: 0 },
      0,
      encodeSingleU32StructMessage(0),
      { timeoutMs: 50 },
    );
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof SessionError ||
      thrown instanceof Error,
    `expected SessionError after close, got: ${String(thrown)}`,
  );
});

Deno.test("client core: bootstrap after session close throws", async () => {
  const { client, session } = createClient((frame) => {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_BOOTSTRAP) {
      const bootstrap = decodeBootstrapRequestFrame(frame);
      return [
        encodeReturnResultsFrame({
          answerId: bootstrap.questionId,
          capTable: [{ tag: 1, id: 0 }],
        }),
      ];
    }
    throw new Error(`unexpected tag=${tag}`);
  });

  await session.start();
  await session.close();

  let thrown: unknown;
  try {
    await client.bootstrap({ timeoutMs: 50 });
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof Error,
    `expected error after close, got: ${String(thrown)}`,
  );
});

// ---------------------------------------------------------------------------
// Malformed response handling
// ---------------------------------------------------------------------------

Deno.test("client core: skips undecodable outbound frames and finds correct return", async () => {
  const params = encodeSingleU32StructMessage(5);
  const results = encodeSingleU32StructMessage(15);

  const { client, session } = createClient((frame) => {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_CALL) {
      const call = decodeCallRequestFrame(frame);
      return [
        // Garbage frame that cannot be decoded as a return.
        new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]),
        // Another garbage frame, shorter.
        new Uint8Array([0xff]),
        // The real response.
        encodeReturnResultsFrame({
          answerId: call.questionId,
          content: results,
        }),
      ];
    }
    if (tag === RPC_MESSAGE_TAG_FINISH) return [];
    throw new Error(`unexpected tag=${tag}`);
  });

  try {
    const response = await client.call({ capabilityIndex: 0 }, 0, params);
    assertEquals(decodeSingleU32StructMessage(response), 15);
  } finally {
    await session.close();
  }
});

Deno.test("client core: skips return frames with mismatched answerId", async () => {
  const params = encodeSingleU32StructMessage(7);
  const results = encodeSingleU32StructMessage(14);

  const { client, session } = createClient((frame) => {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_CALL) {
      const call = decodeCallRequestFrame(frame);
      return [
        // Return for a different question ID.
        encodeReturnResultsFrame({
          answerId: call.questionId + 999,
          content: encodeSingleU32StructMessage(0),
        }),
        // The correct return.
        encodeReturnResultsFrame({
          answerId: call.questionId,
          content: results,
        }),
      ];
    }
    if (tag === RPC_MESSAGE_TAG_FINISH) return [];
    throw new Error(`unexpected tag=${tag}`);
  });

  try {
    const response = await client.call({ capabilityIndex: 0 }, 0, params);
    assertEquals(decodeSingleU32StructMessage(response), 14);
  } finally {
    await session.close();
  }
});

// ---------------------------------------------------------------------------
// Default timeout propagation
// ---------------------------------------------------------------------------

Deno.test("client core: defaultTimeoutMs causes timeout when no response arrives", async () => {
  const { client, session } = createClient(
    (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) {
        // Return no frames -- the call will never get a response.
        return [];
      }
      throw new Error(`unexpected tag=${tag}`);
    },
    { defaultTimeoutMs: 30 },
  );

  try {
    let thrown: unknown;
    try {
      await client.call(
        { capabilityIndex: 0 },
        0,
        encodeSingleU32StructMessage(0),
      );
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof SessionError &&
        /timed out/i.test(thrown.message),
      `expected timeout SessionError, got: ${String(thrown)}`,
    );
  } finally {
    await session.close();
  }
});

// ---------------------------------------------------------------------------
// autoStart=false requires manual start
// ---------------------------------------------------------------------------

Deno.test("client core: autoStart=false causes call to fail before start", async () => {
  const { client, session } = createClient(
    (_frame) => {
      return [];
    },
    { autoStart: false },
  );

  try {
    let thrown: unknown;
    try {
      await client.call(
        { capabilityIndex: 0 },
        0,
        encodeSingleU32StructMessage(0),
        { timeoutMs: 30 },
      );
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof SessionError &&
        /transport is not started/i.test(thrown.message),
      `expected not-started SessionError, got: ${String(thrown)}`,
    );
  } finally {
    await session.close();
  }
});

// ---------------------------------------------------------------------------
// autoFinish=false suppresses the finish frame
// ---------------------------------------------------------------------------

Deno.test("client core: autoFinish=false does not send finish, manual finish works", async () => {
  let finishCount = 0;
  let finishQuestionId = -1;

  const { client, session } = createClient((frame) => {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_CALL) {
      const call = decodeCallRequestFrame(frame);
      return [
        encodeReturnResultsFrame({
          answerId: call.questionId,
          content: encodeSingleU32StructMessage(0),
        }),
      ];
    }
    if (tag === RPC_MESSAGE_TAG_FINISH) {
      finishCount += 1;
      finishQuestionId = decodeFinishFrame(frame).questionId;
      return [];
    }
    throw new Error(`unexpected tag=${tag}`);
  });

  try {
    const result = await client.callRaw(
      { capabilityIndex: 0 },
      0,
      encodeSingleU32StructMessage(0),
      { autoFinish: false },
    );
    assertEquals(finishCount, 0);

    // Manually send a finish.
    await client.finish(result.answerId);
    assertEquals(finishCount, 1);
    assertEquals(finishQuestionId, result.answerId);
  } finally {
    await session.close();
  }
});

// ---------------------------------------------------------------------------
// Multiple exception returns - each call gets its own error
// ---------------------------------------------------------------------------

Deno.test("client core: sequential exception calls each get their own error", async () => {
  let callCount = 0;

  const { client, session } = createClient((frame) => {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_CALL) {
      callCount += 1;
      const call = decodeCallRequestFrame(frame);
      return [
        encodeReturnExceptionFrame({
          answerId: call.questionId,
          reason: `error-${callCount}`,
        }),
      ];
    }
    if (tag === RPC_MESSAGE_TAG_FINISH) return [];
    throw new Error(`unexpected tag=${tag}`);
  });

  try {
    const params = encodeSingleU32StructMessage(0);

    let err1: unknown;
    try {
      await client.call({ capabilityIndex: 0 }, 0, params);
    } catch (e) {
      err1 = e;
    }
    assert(
      err1 instanceof ProtocolError && /error-1/.test(err1.message),
      `expected error-1, got: ${String(err1)}`,
    );

    let err2: unknown;
    try {
      await client.call({ capabilityIndex: 0 }, 0, params);
    } catch (e) {
      err2 = e;
    }
    assert(
      err2 instanceof ProtocolError && /error-2/.test(err2.message),
      `expected error-2, got: ${String(err2)}`,
    );
  } finally {
    await session.close();
  }
});
