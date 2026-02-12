import {
  type ClientMiddlewareContext,
  decodeCallRequestFrame,
  decodeRpcMessageTag,
  encodeReturnExceptionFrame,
  encodeReturnResultsFrame,
  InMemoryRpcHarnessTransport,
  ProtocolError,
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_FINISH,
  type RpcClientMiddleware,
  RpcSession,
  SessionRpcClientTransport,
  WasmPeer,
} from "../../src/advanced.ts";
import { FakeCapnpWasm } from "../fake_wasm.ts";
import { assert, assertEquals } from "../test_utils.ts";

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

function signed30(value: bigint): number {
  const raw = Number(value & MASK_30);
  return (raw & (1 << 29)) !== 0 ? raw - (1 << 30) : raw;
}

function decodeSingleU32StructMessage(frame: Uint8Array): number {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const root = view.getBigUint64(8, true);
  const offset = signed30((root >> 2n) & MASK_30);
  const dataWord = 1 + offset;
  return view.getUint32(8 + dataWord * 8, true);
}

/** Create a fake wasm that echoes calls with a result value. */
function createEchoFake(resultValue: number): FakeCapnpWasm {
  return new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) {
        const call = decodeCallRequestFrame(frame);
        return [
          encodeReturnResultsFrame({
            answerId: call.questionId,
            content: encodeSingleU32StructMessage(resultValue),
          }),
        ];
      }
      if (tag === RPC_MESSAGE_TAG_FINISH) {
        return [];
      }
      throw new Error(`unexpected inbound rpc tag=${tag}`);
    },
  });
}

/** Create a fake wasm that returns an exception. */
function createExceptionFake(reason: string): FakeCapnpWasm {
  return new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) {
        const call = decodeCallRequestFrame(frame);
        return [
          encodeReturnExceptionFrame({
            answerId: call.questionId,
            reason,
          }),
        ];
      }
      if (tag === RPC_MESSAGE_TAG_FINISH) {
        return [];
      }
      throw new Error(`unexpected inbound rpc tag=${tag}`);
    },
  });
}

function setupClient(
  fake: FakeCapnpWasm,
  middleware: RpcClientMiddleware[],
  interfaceId: bigint = 0x1234n,
): {
  session: RpcSession;
  client: SessionRpcClientTransport;
} {
  const peer = WasmPeer.fromExports(fake.exports, { expectedVersion: 1 });
  const transport = new InMemoryRpcHarnessTransport();
  const session = new RpcSession(peer, transport);
  const client = new SessionRpcClientTransport(session, transport, {
    interfaceId,
    middleware,
  });
  return { session, client };
}

Deno.test("middleware onCall is called with correct context", async () => {
  const fake = createEchoFake(42);
  const seen: ClientMiddlewareContext[] = [];
  const mw: RpcClientMiddleware = {
    onCall(ctx) {
      seen.push(ctx);
    },
  };
  const { session, client } = setupClient(fake, [mw], 0xABCDn);

  try {
    const params = encodeSingleU32StructMessage(1);
    await client.call({ capabilityIndex: 5 }, 7, params);

    assertEquals(seen.length, 1);
    assertEquals(seen[0].questionId, 1);
    assertEquals(seen[0].interfaceId, 0xABCDn);
    assertEquals(seen[0].methodId, 7);
    assertEquals(seen[0].capabilityIndex, 5);
    assert(seen[0].state instanceof Map, "state should be a Map");
    assertEquals(seen[0].state.size, 0);
  } finally {
    await session.close();
  }
});

Deno.test("middleware onResponse is called with correct context and result bytes", async () => {
  const fake = createEchoFake(99);
  const seenResults: number[] = [];
  const seenContexts: ClientMiddlewareContext[] = [];
  const mw: RpcClientMiddleware = {
    onResponse(result, ctx) {
      seenResults.push(decodeSingleU32StructMessage(result));
      seenContexts.push(ctx);
      return null; // do not transform
    },
  };
  const { session, client } = setupClient(fake, [mw]);

  try {
    const params = encodeSingleU32StructMessage(1);
    const response = await client.call({ capabilityIndex: 0 }, 3, params);
    assertEquals(decodeSingleU32StructMessage(response), 99);
    assertEquals(seenResults.length, 1);
    assertEquals(seenResults[0], 99);
    assertEquals(seenContexts[0].questionId, 1);
    assertEquals(seenContexts[0].methodId, 3);
  } finally {
    await session.close();
  }
});

Deno.test("middleware onResponse can transform result bytes", async () => {
  const fake = createEchoFake(100);
  const mw: RpcClientMiddleware = {
    onResponse(_result, _ctx) {
      // Replace the response with a different value
      return encodeSingleU32StructMessage(200);
    },
  };
  const { session, client } = setupClient(fake, [mw]);

  try {
    const params = encodeSingleU32StructMessage(1);
    const response = await client.call({ capabilityIndex: 0 }, 3, params);
    assertEquals(decodeSingleU32StructMessage(response), 200);
  } finally {
    await session.close();
  }
});

Deno.test("multiple middleware execute onCall in order", async () => {
  const fake = createEchoFake(42);
  const order: string[] = [];

  const mw1: RpcClientMiddleware = {
    onCall(ctx) {
      order.push("mw1-call");
      ctx.state.set("mw1", true);
    },
  };
  const mw2: RpcClientMiddleware = {
    onCall(ctx) {
      order.push("mw2-call");
      assert(ctx.state.get("mw1") === true, "mw2 should see mw1 state");
    },
  };
  const { session, client } = setupClient(fake, [mw1, mw2]);

  try {
    const params = encodeSingleU32StructMessage(1);
    await client.call({ capabilityIndex: 0 }, 1, params);
    assertEquals(order.length, 2);
    assertEquals(order[0], "mw1-call");
    assertEquals(order[1], "mw2-call");
  } finally {
    await session.close();
  }
});

Deno.test("multiple middleware execute onResponse in order and chain transforms", async () => {
  const fake = createEchoFake(10);
  const order: string[] = [];

  const mw1: RpcClientMiddleware = {
    onResponse(result, _ctx) {
      order.push("mw1-response");
      // Double the value
      const val = decodeSingleU32StructMessage(result);
      return encodeSingleU32StructMessage(val * 2);
    },
  };
  const mw2: RpcClientMiddleware = {
    onResponse(result, _ctx) {
      order.push("mw2-response");
      // Add 1 to the value (should receive the doubled value from mw1)
      const val = decodeSingleU32StructMessage(result);
      return encodeSingleU32StructMessage(val + 1);
    },
  };
  const { session, client } = setupClient(fake, [mw1, mw2]);

  try {
    const params = encodeSingleU32StructMessage(1);
    const response = await client.call({ capabilityIndex: 0 }, 1, params);
    // Server returns 10, mw1 doubles to 20, mw2 adds 1 to get 21
    assertEquals(decodeSingleU32StructMessage(response), 21);
    assertEquals(order.length, 2);
    assertEquals(order[0], "mw1-response");
    assertEquals(order[1], "mw2-response");
  } finally {
    await session.close();
  }
});

Deno.test("middleware onError is called on server exception", async () => {
  const fake = createExceptionFake("server exploded");
  const seenErrors: unknown[] = [];
  const seenContexts: ClientMiddlewareContext[] = [];
  const mw: RpcClientMiddleware = {
    onError(error, ctx) {
      seenErrors.push(error);
      seenContexts.push(ctx);
    },
  };
  const { session, client } = setupClient(fake, [mw]);

  try {
    const params = encodeSingleU32StructMessage(1);
    let thrown: unknown;
    try {
      await client.call({ capabilityIndex: 0 }, 5, params);
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof ProtocolError &&
        /rpc call failed: server exploded/.test(thrown.message),
      `expected ProtocolError, got: ${String(thrown)}`,
    );
    assertEquals(seenErrors.length, 1);
    const err0 = seenErrors[0] as Error;
    assert(
      /server exploded/.test(err0.message),
      `expected error about server explosion, got: ${err0.message}`,
    );
    assertEquals(seenContexts[0].questionId, 1);
    assertEquals(seenContexts[0].methodId, 5);
  } finally {
    await session.close();
  }
});

Deno.test("multiple middleware execute onError in order", async () => {
  const fake = createExceptionFake("kaboom");
  const order: string[] = [];

  const mw1: RpcClientMiddleware = {
    onError(_error, _ctx) {
      order.push("mw1-error");
    },
  };
  const mw2: RpcClientMiddleware = {
    onError(_error, _ctx) {
      order.push("mw2-error");
    },
  };
  const { session, client } = setupClient(fake, [mw1, mw2]);

  try {
    const params = encodeSingleU32StructMessage(1);
    try {
      await client.call({ capabilityIndex: 0 }, 1, params);
    } catch {
      // expected
    }
    assertEquals(order.length, 2);
    assertEquals(order[0], "mw1-error");
    assertEquals(order[1], "mw2-error");
  } finally {
    await session.close();
  }
});

Deno.test("middleware hooks fire in correct lifecycle order: onCall then onResponse", async () => {
  const fake = createEchoFake(55);
  const events: string[] = [];

  const mw: RpcClientMiddleware = {
    onCall(_ctx) {
      events.push("onCall");
    },
    onResponse(_result, _ctx) {
      events.push("onResponse");
      return null;
    },
    onError(_error, _ctx) {
      events.push("onError");
    },
  };
  const { session, client } = setupClient(fake, [mw]);

  try {
    const params = encodeSingleU32StructMessage(1);
    await client.call({ capabilityIndex: 0 }, 1, params);
    assertEquals(events.length, 2);
    assertEquals(events[0], "onCall");
    assertEquals(events[1], "onResponse");
  } finally {
    await session.close();
  }
});

Deno.test("middleware hooks fire in correct lifecycle order: onCall then onError", async () => {
  const fake = createExceptionFake("fail");
  const events: string[] = [];

  const mw: RpcClientMiddleware = {
    onCall(_ctx) {
      events.push("onCall");
    },
    onResponse(_result, _ctx) {
      events.push("onResponse");
      return null;
    },
    onError(_error, _ctx) {
      events.push("onError");
    },
  };
  const { session, client } = setupClient(fake, [mw]);

  try {
    const params = encodeSingleU32StructMessage(1);
    try {
      await client.call({ capabilityIndex: 0 }, 1, params);
    } catch {
      // expected
    }
    assertEquals(events.length, 2);
    assertEquals(events[0], "onCall");
    assertEquals(events[1], "onError");
  } finally {
    await session.close();
  }
});

Deno.test("middleware context state is shared across hooks within a single call", async () => {
  const fake = createEchoFake(77);
  let responseState: Map<string, unknown> | undefined;

  const mw: RpcClientMiddleware = {
    onCall(ctx) {
      ctx.state.set("startedAt", 12345);
    },
    onResponse(_result, ctx) {
      responseState = ctx.state;
      return null;
    },
  };
  const { session, client } = setupClient(fake, [mw]);

  try {
    const params = encodeSingleU32StructMessage(1);
    await client.call({ capabilityIndex: 0 }, 1, params);
    assert(responseState !== undefined, "response state should be set");
    assertEquals(responseState!.get("startedAt"), 12345);
  } finally {
    await session.close();
  }
});

Deno.test("callRaw also triggers middleware hooks", async () => {
  const fake = createEchoFake(88);
  const seen: ClientMiddlewareContext[] = [];
  let responseReceived = false;

  const mw: RpcClientMiddleware = {
    onCall(ctx) {
      seen.push(ctx);
    },
    onResponse(_result, _ctx) {
      responseReceived = true;
      return null;
    },
  };
  const { session, client } = setupClient(fake, [mw]);

  try {
    const params = encodeSingleU32StructMessage(1);
    const result = await client.callRaw(
      { capabilityIndex: 3 },
      11,
      params,
    );
    assertEquals(seen.length, 1);
    assertEquals(seen[0].questionId, 1);
    assertEquals(seen[0].methodId, 11);
    assertEquals(seen[0].capabilityIndex, 3);
    assertEquals(responseReceived, true);
    assertEquals(decodeSingleU32StructMessage(result.contentBytes), 88);
  } finally {
    await session.close();
  }
});

Deno.test("middleware with no hooks is a no-op", async () => {
  const fake = createEchoFake(42);
  const emptyMw: RpcClientMiddleware = {};
  const { session, client } = setupClient(fake, [emptyMw]);

  try {
    const params = encodeSingleU32StructMessage(1);
    const response = await client.call({ capabilityIndex: 0 }, 1, params);
    assertEquals(decodeSingleU32StructMessage(response), 42);
  } finally {
    await session.close();
  }
});

Deno.test("async middleware hooks are awaited", async () => {
  const fake = createEchoFake(42);
  let callAwaited = false;
  let responseAwaited = false;

  const mw: RpcClientMiddleware = {
    async onCall(_ctx) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      callAwaited = true;
    },
    async onResponse(result, _ctx) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      responseAwaited = true;
      return result;
    },
  };
  const { session, client } = setupClient(fake, [mw]);

  try {
    const params = encodeSingleU32StructMessage(1);
    await client.call({ capabilityIndex: 0 }, 1, params);
    assertEquals(callAwaited, true);
    assertEquals(responseAwaited, true);
  } finally {
    await session.close();
  }
});

Deno.test("onError called on timeout errors", async () => {
  // Create a fake that never responds to calls
  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      const tag = decodeRpcMessageTag(frame);
      if (tag === RPC_MESSAGE_TAG_CALL) {
        return []; // no response
      }
      if (tag === RPC_MESSAGE_TAG_FINISH) {
        return [];
      }
      throw new Error(`unexpected inbound rpc tag=${tag}`);
    },
  });

  const seenErrors: unknown[] = [];
  const mw: RpcClientMiddleware = {
    onError(error, _ctx) {
      seenErrors.push(error);
    },
  };
  const { session, client } = setupClient(fake, [mw]);

  try {
    const params = encodeSingleU32StructMessage(1);
    try {
      await client.call({ capabilityIndex: 0 }, 1, params, { timeoutMs: 20 });
    } catch {
      // expected
    }
    assertEquals(seenErrors.length, 1);
    const err0 = seenErrors[0] as Error;
    assert(
      /timed out/.test(err0.message),
      `expected timeout error, got: ${err0.message}`,
    );
  } finally {
    await session.close();
  }
});
