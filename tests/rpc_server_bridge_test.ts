import {
  decodeReturnFrame,
  encodeBootstrapRequestFrame,
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

Deno.test("RpcServerBridge validates capability registration and ref-count operations", () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(1),
  }, { capabilityIndex: 1, referenceCount: 1 });

  let duplicateThrown: unknown;
  try {
    bridge.exportCapability({
      interfaceId: 0x1234n,
      dispatch: () => encodeSingleU32StructMessage(1),
    }, { capabilityIndex: 1 });
  } catch (error) {
    duplicateThrown = error;
  }
  assert(
    duplicateThrown instanceof Error &&
      /already has a registered server dispatch/i.test(duplicateThrown.message),
    `expected duplicate capability error, got: ${String(duplicateThrown)}`,
  );

  let invalidExportRefCount: unknown;
  try {
    bridge.exportCapability({
      interfaceId: 0x1234n,
      dispatch: () => encodeSingleU32StructMessage(1),
    }, { capabilityIndex: 2, referenceCount: 0 });
  } catch (error) {
    invalidExportRefCount = error;
  }
  assert(
    invalidExportRefCount instanceof Error &&
      /referenceCount must be a positive integer/i.test(
        invalidExportRefCount.message,
      ),
    `expected invalid referenceCount error, got: ${
      String(invalidExportRefCount)
    }`,
  );

  let retainUnknown: unknown;
  try {
    bridge.retainCapability(99, 1);
  } catch (error) {
    retainUnknown = error;
  }
  assert(
    retainUnknown instanceof Error &&
      /unknown capability 99/i.test(retainUnknown.message),
    `expected unknown capability retain error, got: ${String(retainUnknown)}`,
  );

  let invalidReleaseRefCount: unknown;
  try {
    bridge.releaseCapability(1, 0);
  } catch (error) {
    invalidReleaseRefCount = error;
  }
  assert(
    invalidReleaseRefCount instanceof Error &&
      /referenceCount must be a positive integer/i.test(
        invalidReleaseRefCount.message,
      ),
    `expected invalid release referenceCount, got: ${
      String(invalidReleaseRefCount)
    }`,
  );
});

Deno.test("RpcServerBridge rejects unsupported inbound message tags", async () => {
  const bridge = new RpcServerBridge();
  const bootstrap = encodeBootstrapRequestFrame({ questionId: 1 });

  let thrown: unknown;
  try {
    await bridge.handleFrame(bootstrap);
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof Error &&
      /unsupported rpc message tag/i.test(thrown.message),
    `expected unsupported-tag error, got: ${String(thrown)}`,
  );
});

Deno.test("RpcServerBridge validates pumpWasmHostCalls options and host call metadata", async () => {
  const bridge = new RpcServerBridge();

  let invalidMaxCalls: unknown;
  try {
    await bridge.pumpWasmHostCalls({
      handle: 1,
      abi: new MockWasmHostAbi(),
    }, { maxCalls: 0 });
  } catch (error) {
    invalidMaxCalls = error;
  }
  assert(
    invalidMaxCalls instanceof Error &&
      /maxCalls must be a positive integer/i.test(invalidMaxCalls.message),
    `expected invalid maxCalls error, got: ${String(invalidMaxCalls)}`,
  );

  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(3),
  }, { capabilityIndex: 2 });

  const hostAbi = new MockWasmHostAbi();
  hostAbi.calls.push({
    questionId: 7,
    interfaceId: 0x1234n,
    methodId: 1,
    frame: new Uint8Array([0x01, 0x02, 0x03]), // decode failure path
  });
  hostAbi.calls.push({
    questionId: 8,
    interfaceId: 0x1234n,
    methodId: 1,
    frame: encodeCallRequestFrame({
      questionId: 9, // mismatch path
      interfaceId: 0x1234n,
      methodId: 1,
      targetImportedCap: 2,
      paramsContent: encodeSingleU32StructMessage(1),
    }),
  });

  const handled = await bridge.pumpWasmHostCalls({
    handle: 1,
    abi: hostAbi,
  });
  assertEquals(handled, 2);
  assertEquals(hostAbi.results.length, 0);
  assertEquals(hostAbi.exceptions.length, 2);
  assert(
    (/invalid host call frame/i.test(hostAbi.exceptions[0].reason)) ||
      (/rpc frame is too short/i.test(hostAbi.exceptions[0].reason)),
    `expected decode failure reason, got: ${hostAbi.exceptions[0].reason}`,
  );
  assert(
    /questionId mismatch/i.test(hostAbi.exceptions[1].reason),
    `expected questionId mismatch reason, got: ${hostAbi.exceptions[1].reason}`,
  );
});

Deno.test("RpcServerBridge reports interface mismatch and forwards unhandled dispatch errors", async () => {
  const seenUnhandled: Array<{ questionId: number; message: string }> = [];
  const bridge = new RpcServerBridge({
    onUnhandledError: (error, call) => {
      const message = error instanceof Error ? error.message : String(error);
      seenUnhandled.push({ questionId: call.questionId, message });
    },
  });

  bridge.exportCapability({
    interfaceId: 0x1111n,
    dispatch: () => encodeSingleU32StructMessage(1),
  }, { capabilityIndex: 3 });

  const mismatch = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 4,
    interfaceId: 0x2222n,
    methodId: 1,
    targetImportedCap: 3,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  if (!mismatch) {
    throw new Error("expected mismatch return frame");
  }
  const mismatchDecoded = decodeReturnFrame(mismatch);
  assertEquals(mismatchDecoded.kind, "exception");
  if (mismatchDecoded.kind === "exception") {
    assert(
      /interface mismatch/i.test(mismatchDecoded.reason),
      `expected interface mismatch reason, got: ${mismatchDecoded.reason}`,
    );
  }

  bridge.releaseCapability(3);
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => {
      throw new Error("dispatch exploded");
    },
  }, { capabilityIndex: 3 });

  const failed = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 5,
    interfaceId: 0x1234n,
    methodId: 1,
    targetImportedCap: 3,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  if (!failed) {
    throw new Error("expected dispatch failure return frame");
  }
  const failedDecoded = decodeReturnFrame(failed);
  assertEquals(failedDecoded.kind, "exception");
  if (failedDecoded.kind === "exception") {
    assert(
      /dispatch exploded/i.test(failedDecoded.reason),
      `expected dispatch exception reason, got: ${failedDecoded.reason}`,
    );
  }
  assertEquals(seenUnhandled.length, 1);
  assertEquals(seenUnhandled[0].questionId, 5);
  assertEquals(seenUnhandled[0].message, "dispatch exploded");
});
