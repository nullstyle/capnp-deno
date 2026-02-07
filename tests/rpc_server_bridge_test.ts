import {
  decodeReturnFrame,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  RpcServerBridge,
  type RpcServerWasmHost,
  type WasmHostCallRecord,
} from "../mod.ts";
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

class MockWasmHostAbi {
  readonly calls: WasmHostCallRecord[] = [];
  readonly results: Array<{ questionId: number; payload: Uint8Array }> = [];
  readonly exceptions: Array<{ questionId: number; reason: string }> = [];

  popHostCall(_peer: number): WasmHostCallRecord | null {
    if (this.calls.length === 0) return null;
    return this.calls.shift() ?? null;
  }

  respondHostCallResults(
    _peer: number,
    questionId: number,
    payloadFrame: Uint8Array,
  ): void {
    this.results.push({
      questionId,
      payload: new Uint8Array(payloadFrame),
    });
  }

  respondHostCallException(
    _peer: number,
    questionId: number,
    reason: string | Uint8Array,
  ): void {
    const text = typeof reason === "string"
      ? reason
      : new TextDecoder().decode(reason);
    this.exceptions.push({ questionId, reason: text });
  }
}

Deno.test("RpcServerBridge dispatches call frames via registered server", async () => {
  const bridge = new RpcServerBridge();
  const expectedParams = encodeSingleU32StructMessage(77);
  const expectedResults = encodeSingleU32StructMessage(88);
  let seenCtx: Record<string, unknown> | undefined;

  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: (methodOrdinal, params, ctx) => {
      assertEquals(methodOrdinal, 9);
      assertEquals(decodeSingleU32StructMessage(params), 77);
      seenCtx = {
        capabilityIndex: ctx.capability.capabilityIndex,
        methodOrdinal: ctx.methodOrdinal,
        questionId: ctx.questionId,
        interfaceId: ctx.interfaceId,
        paramsCapTable: ctx.paramsCapTable,
      };
      return Promise.resolve({
        content: expectedResults,
        capTable: [{ tag: 1, id: 6 }],
      });
    },
  }, { capabilityIndex: 5 });

  const callFrame = encodeCallRequestFrame({
    questionId: 11,
    interfaceId: 0x1234n,
    methodId: 9,
    targetImportedCap: 5,
    paramsContent: expectedParams,
    paramsCapTable: [{ tag: 3, id: 4 }],
  });

  const response = await bridge.handleFrame(callFrame);
  if (!response) {
    throw new Error("expected response frame");
  }

  const decoded = decodeReturnFrame(response);
  assertEquals(decoded.kind, "results");
  assertEquals(decoded.answerId, 11);
  if (decoded.kind === "results") {
    assertEquals(decodeSingleU32StructMessage(decoded.contentBytes), 88);
    assertEquals(decoded.capTable.length, 1);
    assertEquals(decoded.capTable[0].tag, 1);
    assertEquals(decoded.capTable[0].id, 6);
  }

  assertEquals(seenCtx?.capabilityIndex as number, 5);
  assertEquals(seenCtx?.methodOrdinal as number, 9);
  assertEquals(seenCtx?.questionId as number, 11);
  assertEquals(seenCtx?.interfaceId as bigint, 0x1234n);
  assertEquals(
    (seenCtx?.paramsCapTable as Array<{ tag: number; id: number }>)[0].tag,
    3,
  );
  assertEquals(
    (seenCtx?.paramsCapTable as Array<{ tag: number; id: number }>)[0].id,
    4,
  );
});

Deno.test("RpcServerBridge returns exception for unknown capability", async () => {
  const bridge = new RpcServerBridge();
  const callFrame = encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 999,
    paramsContent: encodeSingleU32StructMessage(0),
  });

  const response = await bridge.handleFrame(callFrame);
  if (!response) {
    throw new Error("expected response frame");
  }

  const decoded = decodeReturnFrame(response);
  assertEquals(decoded.kind, "exception");
  assertEquals(decoded.answerId, 1);
  if (decoded.kind === "exception") {
    assertEquals(
      /unknown capability index/.test(decoded.reason),
      true,
    );
  }
});

Deno.test("RpcServerBridge handles release and finish lifecycle frames", async () => {
  let finishQuestionId = -1;
  const bridge = new RpcServerBridge({
    onFinish: (finish) => {
      finishQuestionId = finish.questionId;
    },
  });

  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => Promise.resolve(encodeSingleU32StructMessage(1)),
  }, {
    capabilityIndex: 7,
    referenceCount: 2,
  });

  assertEquals(bridge.hasCapability(7), true);

  const release1 = await bridge.handleFrame(
    encodeReleaseFrame({ id: 7, referenceCount: 1 }),
  );
  assertEquals(release1, null);
  assertEquals(bridge.hasCapability(7), true);

  const release2 = await bridge.handleFrame(
    encodeReleaseFrame({ id: 7, referenceCount: 1 }),
  );
  assertEquals(release2, null);
  assertEquals(bridge.hasCapability(7), false);

  const finish = await bridge.handleFrame(
    encodeFinishFrame({ questionId: 42 }),
  );
  assertEquals(finish, null);
  assertEquals(finishQuestionId, 42);
});

Deno.test("RpcServerBridge pumps wasm host calls and responds with results payload", async () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: (_methodOrdinal, _params, _ctx) =>
      Promise.resolve(encodeSingleU32StructMessage(321)),
  }, { capabilityIndex: 5 });

  const hostAbi = new MockWasmHostAbi();
  hostAbi.calls.push({
    questionId: 9,
    interfaceId: 0x1234n,
    methodId: 7,
    frame: encodeCallRequestFrame({
      questionId: 9,
      interfaceId: 0x1234n,
      methodId: 7,
      targetImportedCap: 5,
      paramsContent: encodeSingleU32StructMessage(123),
    }),
  });
  const wasmHost: RpcServerWasmHost = {
    handle: 1,
    abi: hostAbi,
  };

  const handled = await bridge.pumpWasmHostCalls(wasmHost);
  assertEquals(handled, 1);
  assertEquals(hostAbi.exceptions.length, 0);
  assertEquals(hostAbi.results.length, 1);
  assertEquals(hostAbi.results[0].questionId, 9);
  assertEquals(decodeSingleU32StructMessage(hostAbi.results[0].payload), 321);
});

Deno.test("RpcServerBridge pumps wasm host calls and responds with exceptions", async () => {
  const bridge = new RpcServerBridge();
  const hostAbi = new MockWasmHostAbi();
  hostAbi.calls.push({
    questionId: 11,
    interfaceId: 0x1234n,
    methodId: 1,
    frame: encodeCallRequestFrame({
      questionId: 11,
      interfaceId: 0x1234n,
      methodId: 1,
      targetImportedCap: 999,
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  });
  const wasmHost: RpcServerWasmHost = {
    handle: 1,
    abi: hostAbi,
  };

  const handled = await bridge.pumpWasmHostCalls(wasmHost);
  assertEquals(handled, 1);
  assertEquals(hostAbi.results.length, 0);
  assertEquals(hostAbi.exceptions.length, 1);
  assertEquals(hostAbi.exceptions[0].questionId, 11);
  assert(
    /unknown capability index/.test(hostAbi.exceptions[0].reason),
    `unexpected exception reason: ${hostAbi.exceptions[0].reason}`,
  );
});

Deno.test("RpcServerBridge host-call pump rejects unsupported cap-table results", async () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(5),
        capTable: [{ tag: 1, id: 2 }],
      }),
  }, { capabilityIndex: 2 });

  const hostAbi = new MockWasmHostAbi();
  hostAbi.calls.push({
    questionId: 17,
    interfaceId: 0x1234n,
    methodId: 0,
    frame: encodeCallRequestFrame({
      questionId: 17,
      interfaceId: 0x1234n,
      methodId: 0,
      targetImportedCap: 2,
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  });

  const handled = await bridge.pumpWasmHostCalls({
    handle: 1,
    abi: hostAbi,
  });
  assertEquals(handled, 1);
  assertEquals(hostAbi.results.length, 0);
  assertEquals(hostAbi.exceptions.length, 1);
  assert(
    /does not support response cap tables/i.test(hostAbi.exceptions[0].reason),
    `unexpected exception reason: ${hostAbi.exceptions[0].reason}`,
  );
});
