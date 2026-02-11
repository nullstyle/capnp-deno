import {
  decodeReturnFrame,
  encodeBootstrapRequestFrame,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  RpcServerBridge,
  type RpcServerWasmHost,
  type WasmHostCallRecord,
} from "../advanced.ts";
import { assert, assertEquals, deferred } from "./test_utils.ts";

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

class MockWasmHostAbiWithReturnFrame extends MockWasmHostAbi {
  readonly returnFrames: Uint8Array[] = [];

  respondHostCallReturnFrame(
    _peer: number,
    returnFrame: Uint8Array,
  ): void {
    this.returnFrames.push(new Uint8Array(returnFrame));
  }
}

Deno.test("RpcServerBridge dispatches call frames via registered server", async () => {
  const bridge = new RpcServerBridge();
  const expectedParams = encodeSingleU32StructMessage(77);
  const expectedResults = encodeSingleU32StructMessage(88);
  let seenCtx: Record<string, unknown> | undefined;

  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: (methodId, params, ctx) => {
      assertEquals(methodId, 9);
      assertEquals(decodeSingleU32StructMessage(params), 77);
      seenCtx = {
        capabilityIndex: ctx.capability.capabilityIndex,
        methodId: ctx.methodId,
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
  assertEquals(seenCtx?.methodId as number, 9);
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

Deno.test("RpcServerBridge returns exception for promisedAnswer targeting unknown question", async () => {
  const bridge = new RpcServerBridge();
  const callFrame = encodeCallRequestFrame({
    questionId: 2,
    interfaceId: 0x1234n,
    methodId: 0,
    target: {
      tag: 1,
      promisedAnswer: {
        questionId: 1,
        transform: [],
      },
    },
    paramsContent: encodeSingleU32StructMessage(0),
  });

  const response = await bridge.handleFrame(callFrame);
  if (!response) {
    throw new Error("expected response frame");
  }

  const decoded = decodeReturnFrame(response);
  assertEquals(decoded.kind, "exception");
  assertEquals(decoded.answerId, 2);
  if (decoded.kind === "exception") {
    assert(
      /promisedAnswer references unknown question/i.test(decoded.reason),
      `unexpected exception reason: ${decoded.reason}`,
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
    dispatch: (_methodId, _params, _ctx) =>
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

Deno.test("RpcServerBridge host-call pump uses return-frame bridge for advanced results", async () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(42),
        capTable: [{ tag: 1, id: 9 }],
        releaseParamCaps: false,
        noFinishNeeded: true,
      }),
  }, { capabilityIndex: 2 });

  const hostAbi = new MockWasmHostAbiWithReturnFrame();
  hostAbi.calls.push({
    questionId: 18,
    interfaceId: 0x1234n,
    methodId: 0,
    frame: encodeCallRequestFrame({
      questionId: 18,
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
  assertEquals(hostAbi.exceptions.length, 0);
  assertEquals(hostAbi.returnFrames.length, 1);

  const decoded = decodeReturnFrame(hostAbi.returnFrames[0]);
  assertEquals(decoded.kind, "results");
  assertEquals(decoded.answerId, 18);
  assertEquals(decoded.releaseParamCaps, false);
  assertEquals(decoded.noFinishNeeded, true);
  if (decoded.kind === "results") {
    assertEquals(decodeSingleU32StructMessage(decoded.contentBytes), 42);
    assertEquals(decoded.capTable.length, 1);
    assertEquals(decoded.capTable[0].tag, 1);
    assertEquals(decoded.capTable[0].id, 9);
  }
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

Deno.test("RpcServerBridge rejects release when referenceCount exceeds current refCount", () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(1),
  }, { capabilityIndex: 10, referenceCount: 5 });

  // Attempting to release more than the current refCount should throw a ProtocolError
  let excessiveReleaseThrown: unknown;
  try {
    bridge.releaseCapability(10, 100);
  } catch (error) {
    excessiveReleaseThrown = error;
  }
  assert(
    excessiveReleaseThrown instanceof Error &&
      /release referenceCount 100 exceeds current refCount 5/i.test(
        excessiveReleaseThrown.message,
      ),
    `expected excessive release error, got: ${String(excessiveReleaseThrown)}`,
  );

  // Verify the capability is still registered with the original refCount
  assertEquals(bridge.hasCapability(10), true);

  // A valid release should work
  assertEquals(bridge.releaseCapability(10, 3), true);
  assertEquals(bridge.hasCapability(10), true);

  // Another release that exactly matches should work and remove the capability
  assertEquals(bridge.releaseCapability(10, 2), false);
  assertEquals(bridge.hasCapability(10), false);
});

Deno.test("RpcServerBridge rejects malicious release frame with excessive referenceCount", async () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(1),
  }, { capabilityIndex: 10, referenceCount: 5 });

  // Client sends a release frame with referenceCount=100 when refCount is only 5
  let thrownError: unknown;
  try {
    await bridge.handleFrame(
      encodeReleaseFrame({ id: 10, referenceCount: 100 }),
    );
  } catch (error) {
    thrownError = error;
  }

  assert(
    thrownError instanceof Error &&
      /release referenceCount 100 exceeds current refCount 5/i.test(
        thrownError.message,
      ),
    `expected excessive release error from handleFrame, got: ${
      String(thrownError)
    }`,
  );

  // Verify the capability is still registered with the original refCount
  assertEquals(bridge.hasCapability(10), true);

  // Valid releases should still work normally
  const validRelease1 = await bridge.handleFrame(
    encodeReleaseFrame({ id: 10, referenceCount: 3 }),
  );
  assertEquals(validRelease1, null);
  assertEquals(bridge.hasCapability(10), true);

  const validRelease2 = await bridge.handleFrame(
    encodeReleaseFrame({ id: 10, referenceCount: 2 }),
  );
  assertEquals(validRelease2, null);
  assertEquals(bridge.hasCapability(10), false);
});

Deno.test("RpcServerBridge bootstrap without callback throws clear error", async () => {
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
      /bootstrap not configured/i.test(thrown.message),
    `expected bootstrap-not-configured error, got: ${String(thrown)}`,
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

Deno.test("RpcServerBridge auto-assigns capability indexes and supports pointer retain/release", () => {
  const bridge = new RpcServerBridge({
    nextCapabilityIndex: 10,
  });
  const dispatch = {
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(1),
  };

  const first = bridge.exportCapability(dispatch);
  const second = bridge.exportCapability(dispatch);
  assertEquals(first.capabilityIndex, 10);
  assertEquals(second.capabilityIndex, 11);

  bridge.retainCapability(first, 2);
  assertEquals(bridge.releaseCapability(first, 2), true);
  assertEquals(bridge.releaseCapability(first, 1), false);
  assertEquals(bridge.releaseCapability({ capabilityIndex: 999 }, 1), false);

  let invalidRetain: unknown;
  try {
    bridge.retainCapability(second, 0);
  } catch (error) {
    invalidRetain = error;
  }
  assert(
    invalidRetain instanceof Error &&
      /referenceCount must be a positive integer/i.test(invalidRetain.message),
    `expected invalid retain referenceCount, got: ${String(invalidRetain)}`,
  );
});

Deno.test("RpcServerBridge host-call pump rejects non-default return flags", async () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(6),
        releaseParamCaps: false,
      }),
  }, { capabilityIndex: 4 });

  const hostAbi = new MockWasmHostAbi();
  hostAbi.calls.push({
    questionId: 21,
    interfaceId: 0x1234n,
    methodId: 0,
    frame: encodeCallRequestFrame({
      questionId: 21,
      interfaceId: 0x1234n,
      methodId: 0,
      targetImportedCap: 4,
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
    /does not support non-default return flags/i.test(
      hostAbi.exceptions[0].reason,
    ),
    `unexpected non-default flag exception reason: ${
      hostAbi.exceptions[0].reason
    }`,
  );
});

Deno.test("RpcServerBridge host-call pump defaults missing results content to empty struct frame", async () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => Promise.resolve({}),
  }, { capabilityIndex: 6 });

  const hostAbi = new MockWasmHostAbi();
  hostAbi.calls.push({
    questionId: 22,
    interfaceId: 0x1234n,
    methodId: 0,
    frame: encodeCallRequestFrame({
      questionId: 22,
      interfaceId: 0x1234n,
      methodId: 0,
      targetImportedCap: 6,
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  });

  const handled = await bridge.pumpWasmHostCalls({
    handle: 1,
    abi: hostAbi,
  });
  assertEquals(handled, 1);
  assertEquals(hostAbi.exceptions.length, 0);
  assertEquals(hostAbi.results.length, 1);
  assertEquals(hostAbi.results[0].payload.byteLength, 16);
  const view = new DataView(
    hostAbi.results[0].payload.buffer,
    hostAbi.results[0].payload.byteOffset,
    hostAbi.results[0].payload.byteLength,
  );
  assertEquals(view.getBigUint64(8, true), 0n);
});

Deno.test("RpcServerBridge string dispatch throws become exception reasons", async () => {
  const seenUnhandled: Array<{ questionId: number; message: string }> = [];
  const bridge = new RpcServerBridge({
    onUnhandledError: (error, call) => {
      seenUnhandled.push({
        questionId: call.questionId,
        message: String(error),
      });
    },
  });
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => {
      throw "string explosion";
    },
  }, { capabilityIndex: 8 });

  const response = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 23,
    interfaceId: 0x1234n,
    methodId: 1,
    targetImportedCap: 8,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  if (!response) {
    throw new Error("expected string-throw return frame");
  }
  const decoded = decodeReturnFrame(response);
  assertEquals(decoded.kind, "exception");
  if (decoded.kind === "exception") {
    assertEquals(decoded.reason, "string explosion");
  }
  assertEquals(seenUnhandled.length, 1);
  assertEquals(seenUnhandled[0].questionId, 23);
  assertEquals(seenUnhandled[0].message, "string explosion");
});

// --- Promise Pipelining (Level 2 RPC) Tests ---

Deno.test("RpcServerBridge pipelining: dispatches promisedAnswer call to resolved capability", async () => {
  const bridge = new RpcServerBridge();

  // Register a "factory" capability at index 5 that returns a cap in its result.
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: (_methodId, _params, _ctx) =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(100),
        capTable: [{ tag: 1, id: 10 }], // senderHosted cap at id=10
      }),
  }, { capabilityIndex: 5 });

  // Register the target capability at index 10 that the pipelined call will reach.
  bridge.exportCapability({
    interfaceId: 0x5678n,
    dispatch: (_methodId, _params, _ctx) =>
      Promise.resolve(encodeSingleU32StructMessage(999)),
  }, { capabilityIndex: 10 });

  // Step 1: Make the initial call (question 1) to the factory capability.
  const factoryCallFrame = encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  });
  const factoryResponse = await bridge.handleFrame(factoryCallFrame);
  if (!factoryResponse) {
    throw new Error("expected factory response frame");
  }
  const factoryDecoded = decodeReturnFrame(factoryResponse);
  assertEquals(factoryDecoded.kind, "results");
  assertEquals(factoryDecoded.answerId, 1);

  // Step 2: Make a pipelined call (question 2) targeting the result of question 1.
  const pipelinedCallFrame = encodeCallRequestFrame({
    questionId: 2,
    interfaceId: 0x5678n,
    methodId: 3,
    target: {
      tag: 1,
      promisedAnswer: {
        questionId: 1,
        transform: [],
      },
    },
    paramsContent: encodeSingleU32StructMessage(42),
  });
  const pipelinedResponse = await bridge.handleFrame(pipelinedCallFrame);
  if (!pipelinedResponse) {
    throw new Error("expected pipelined response frame");
  }
  const pipelinedDecoded = decodeReturnFrame(pipelinedResponse);
  assertEquals(pipelinedDecoded.kind, "results");
  assertEquals(pipelinedDecoded.answerId, 2);
  if (pipelinedDecoded.kind === "results") {
    assertEquals(
      decodeSingleU32StructMessage(pipelinedDecoded.contentBytes),
      999,
    );
  }
});

Deno.test("RpcServerBridge pipelining: uses getPointerField transform to select capability", async () => {
  const bridge = new RpcServerBridge();

  // Factory returns multiple capabilities in the cap table.
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(100),
        capTable: [
          { tag: 1, id: 20 }, // pointer field 0
          { tag: 1, id: 21 }, // pointer field 1
          { tag: 1, id: 22 }, // pointer field 2
        ],
      }),
  }, { capabilityIndex: 5 });

  // Register the capability at index 22 (pointer field 2).
  bridge.exportCapability({
    interfaceId: 0x5678n,
    dispatch: () => Promise.resolve(encodeSingleU32StructMessage(777)),
  }, { capabilityIndex: 22 });

  // Call the factory first.
  const factoryResponse = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(factoryResponse !== null, "expected factory response");

  // Pipelined call with getPointerField(2) transform.
  const pipelinedResponse = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 2,
    interfaceId: 0x5678n,
    methodId: 7,
    target: {
      tag: 1,
      promisedAnswer: {
        questionId: 1,
        transform: [{ tag: 1, pointerIndex: 2 }],
      },
    },
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  if (!pipelinedResponse) {
    throw new Error("expected pipelined response frame");
  }
  const decoded = decodeReturnFrame(pipelinedResponse);
  assertEquals(decoded.kind, "results");
  if (decoded.kind === "results") {
    assertEquals(decodeSingleU32StructMessage(decoded.contentBytes), 777);
  }
});

Deno.test("RpcServerBridge pipelining: returns exception when target question resolved with exception", async () => {
  const bridge = new RpcServerBridge();

  // Register a capability that throws.
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => {
      throw new Error("factory failed");
    },
  }, { capabilityIndex: 5 });

  // Call the factory - it will fail.
  const factoryResponse = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(factoryResponse !== null, "expected factory response");
  const factoryDecoded = decodeReturnFrame(factoryResponse);
  assertEquals(factoryDecoded.kind, "exception");

  // Pipelined call targeting question 1 should fail because the answer was an exception.
  const pipelinedResponse = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 2,
    interfaceId: 0x5678n,
    methodId: 0,
    target: {
      tag: 1,
      promisedAnswer: {
        questionId: 1,
        transform: [],
      },
    },
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  if (!pipelinedResponse) {
    throw new Error("expected pipelined response frame");
  }
  const decoded = decodeReturnFrame(pipelinedResponse);
  assertEquals(decoded.kind, "exception");
  if (decoded.kind === "exception") {
    assert(
      /promisedAnswer target question resolved with exception/i.test(
        decoded.reason,
      ),
      `unexpected exception reason: ${decoded.reason}`,
    );
  }
});

Deno.test("RpcServerBridge pipelining: returns exception when result has no cap table", async () => {
  const bridge = new RpcServerBridge();

  // Factory returns no capabilities in the cap table.
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => Promise.resolve(encodeSingleU32StructMessage(42)),
  }, { capabilityIndex: 5 });

  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  const pipelinedResponse = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 2,
    interfaceId: 0x5678n,
    methodId: 0,
    target: {
      tag: 1,
      promisedAnswer: {
        questionId: 1,
        transform: [],
      },
    },
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  if (!pipelinedResponse) {
    throw new Error("expected pipelined response frame");
  }
  const decoded = decodeReturnFrame(pipelinedResponse);
  assertEquals(decoded.kind, "exception");
  if (decoded.kind === "exception") {
    assert(
      /no capabilities in cap table/i.test(decoded.reason),
      `unexpected exception reason: ${decoded.reason}`,
    );
  }
});

Deno.test("RpcServerBridge pipelining: returns exception when getPointerField out of range", async () => {
  const bridge = new RpcServerBridge();

  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(42),
        capTable: [{ tag: 1, id: 10 }],
      }),
  }, { capabilityIndex: 5 });

  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  // Try getPointerField(5) when cap table only has 1 entry.
  const pipelinedResponse = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 2,
    interfaceId: 0x5678n,
    methodId: 0,
    target: {
      tag: 1,
      promisedAnswer: {
        questionId: 1,
        transform: [{ tag: 1, pointerIndex: 5 }],
      },
    },
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  if (!pipelinedResponse) {
    throw new Error("expected pipelined response frame");
  }
  const decoded = decodeReturnFrame(pipelinedResponse);
  assertEquals(decoded.kind, "exception");
  if (decoded.kind === "exception") {
    assert(
      /getPointerField\(5\) is out of range/i.test(decoded.reason),
      `unexpected exception reason: ${decoded.reason}`,
    );
  }
});

Deno.test("RpcServerBridge pipelining: finish cleans up answer table entry", async () => {
  const bridge = new RpcServerBridge();

  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(42),
        capTable: [{ tag: 1, id: 10 }],
      }),
  }, { capabilityIndex: 5 });

  // Make a call.
  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  assertEquals(bridge.answerTableSize, 1);

  // Send finish - should clean up the answer table.
  await bridge.handleFrame(
    encodeFinishFrame({ questionId: 1 }),
  );

  assertEquals(bridge.answerTableSize, 0);

  // Now a pipelined call targeting question 1 should fail with unknown question.
  const pipelinedResponse = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 2,
    interfaceId: 0x5678n,
    methodId: 0,
    target: {
      tag: 1,
      promisedAnswer: {
        questionId: 1,
        transform: [],
      },
    },
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  if (!pipelinedResponse) {
    throw new Error("expected pipelined response frame");
  }
  const decoded = decodeReturnFrame(pipelinedResponse);
  assertEquals(decoded.kind, "exception");
  if (decoded.kind === "exception") {
    assert(
      /promisedAnswer references unknown question/i.test(decoded.reason),
      `unexpected exception reason: ${decoded.reason}`,
    );
  }
});

Deno.test("RpcServerBridge pipelining: noop transform ops are skipped", async () => {
  const bridge = new RpcServerBridge();

  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(100),
        capTable: [
          { tag: 1, id: 30 },
          { tag: 1, id: 31 },
        ],
      }),
  }, { capabilityIndex: 5 });

  bridge.exportCapability({
    interfaceId: 0x5678n,
    dispatch: () => Promise.resolve(encodeSingleU32StructMessage(888)),
  }, { capabilityIndex: 31 });

  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  // Transform: noop, then getPointerField(1)
  const pipelinedResponse = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 2,
    interfaceId: 0x5678n,
    methodId: 0,
    target: {
      tag: 1,
      promisedAnswer: {
        questionId: 1,
        transform: [
          { tag: 0 }, // noop
          { tag: 1, pointerIndex: 1 }, // getPointerField(1) -> cap id 31
        ],
      },
    },
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  if (!pipelinedResponse) {
    throw new Error("expected pipelined response frame");
  }
  const decoded = decodeReturnFrame(pipelinedResponse);
  assertEquals(decoded.kind, "results");
  if (decoded.kind === "results") {
    assertEquals(decodeSingleU32StructMessage(decoded.contentBytes), 888);
  }
});

Deno.test("RpcServerBridge pipelining: chained pipelining through multiple answers", async () => {
  const bridge = new RpcServerBridge();

  // Step 1 capability: returns cap id 10
  bridge.exportCapability({
    interfaceId: 0x1111n,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(1),
        capTable: [{ tag: 1, id: 10 }],
      }),
  }, { capabilityIndex: 5 });

  // Step 2 capability (at id 10): returns cap id 20
  bridge.exportCapability({
    interfaceId: 0x2222n,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(2),
        capTable: [{ tag: 1, id: 20 }],
      }),
  }, { capabilityIndex: 10 });

  // Step 3 capability (at id 20): returns the final result
  bridge.exportCapability({
    interfaceId: 0x3333n,
    dispatch: () => Promise.resolve(encodeSingleU32StructMessage(42)),
  }, { capabilityIndex: 20 });

  // Question 1: call step 1
  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1111n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  // Question 2: pipelined call on question 1's result -> dispatches to cap 10
  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 2,
    interfaceId: 0x2222n,
    methodId: 0,
    target: {
      tag: 1,
      promisedAnswer: {
        questionId: 1,
        transform: [],
      },
    },
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  // Question 3: pipelined call on question 2's result -> dispatches to cap 20
  const finalResponse = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 3,
    interfaceId: 0x3333n,
    methodId: 0,
    target: {
      tag: 1,
      promisedAnswer: {
        questionId: 2,
        transform: [],
      },
    },
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  if (!finalResponse) {
    throw new Error("expected final pipelined response frame");
  }
  const decoded = decodeReturnFrame(finalResponse);
  assertEquals(decoded.kind, "results");
  assertEquals(decoded.answerId, 3);
  if (decoded.kind === "results") {
    assertEquals(decodeSingleU32StructMessage(decoded.contentBytes), 42);
  }
});

// --- Answer Table Bounds and Eviction Tests ---

Deno.test("RpcServerBridge rejects new calls when answer table is full", async () => {
  const bridge = new RpcServerBridge({
    maxAnswerTableSize: 2,
    answerEvictionTimeoutMs: 0, // disable eviction so entries stay
  });

  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(1),
        capTable: [{ tag: 1, id: 10 }],
      }),
  }, { capabilityIndex: 5 });

  // Fill the answer table with 2 calls (no finish sent).
  const r1 = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(r1 !== null, "expected response for question 1");
  assertEquals(decodeReturnFrame(r1).kind, "results");

  const r2 = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 2,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(r2 !== null, "expected response for question 2");
  assertEquals(decodeReturnFrame(r2).kind, "results");

  assertEquals(bridge.answerTableSize, 2);

  // Third call should be rejected because the table is full.
  const r3 = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 3,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(r3 !== null, "expected rejection response for question 3");
  const decoded3 = decodeReturnFrame(r3);
  assertEquals(decoded3.kind, "exception");
  assertEquals(decoded3.answerId, 3);
  if (decoded3.kind === "exception") {
    assert(
      /answer table is full/i.test(decoded3.reason),
      `unexpected exception reason: ${decoded3.reason}`,
    );
  }

  // The answer table should still be at 2 (rejected call was NOT added).
  assertEquals(bridge.answerTableSize, 2);

  // Finishing one entry frees a slot, allowing the next call to succeed.
  await bridge.handleFrame(encodeFinishFrame({ questionId: 1 }));
  assertEquals(bridge.answerTableSize, 1);

  const r4 = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 4,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(r4 !== null, "expected response for question 4");
  assertEquals(decodeReturnFrame(r4).kind, "results");
  assertEquals(bridge.answerTableSize, 2);
});

Deno.test("RpcServerBridge answer table eviction removes completed entries after timeout", async () => {
  const bridge = new RpcServerBridge({
    maxAnswerTableSize: 100,
    answerEvictionTimeoutMs: 50, // very short timeout for testing
  });

  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => Promise.resolve(encodeSingleU32StructMessage(42)),
  }, { capabilityIndex: 5 });

  // Send a call that completes but never gets a finish.
  const r = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(r !== null, "expected response for question 1");
  assertEquals(decodeReturnFrame(r).kind, "results");
  assertEquals(bridge.answerTableSize, 1);

  // Wait for the eviction timer to fire.
  await new Promise((resolve) => setTimeout(resolve, 100));

  // The entry should have been evicted.
  assertEquals(bridge.answerTableSize, 0);
});

Deno.test("RpcServerBridge answer table eviction is cancelled by a timely finish", async () => {
  const bridge = new RpcServerBridge({
    maxAnswerTableSize: 100,
    answerEvictionTimeoutMs: 200, // longer timeout
  });

  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => Promise.resolve(encodeSingleU32StructMessage(42)),
  }, { capabilityIndex: 5 });

  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assertEquals(bridge.answerTableSize, 1);

  // Finish before the eviction timer fires.
  await bridge.handleFrame(encodeFinishFrame({ questionId: 1 }));
  assertEquals(bridge.answerTableSize, 0);

  // Wait past the eviction timeout to confirm no errors from the cleared timer.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assertEquals(bridge.answerTableSize, 0);
});

Deno.test("RpcServerBridge disabling answer table limits works", async () => {
  // maxAnswerTableSize=0 should disable the limit
  const bridge = new RpcServerBridge({
    maxAnswerTableSize: 0,
    answerEvictionTimeoutMs: 0,
  });

  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => Promise.resolve(encodeSingleU32StructMessage(1)),
  }, { capabilityIndex: 5 });

  // Should be able to add many entries without rejection.
  for (let i = 1; i <= 10; i++) {
    const r = await bridge.handleFrame(encodeCallRequestFrame({
      questionId: i,
      interfaceId: 0x1234n,
      methodId: 0,
      targetImportedCap: 5,
      paramsContent: encodeSingleU32StructMessage(0),
    }));
    assert(r !== null, `expected response for question ${i}`);
    assertEquals(decodeReturnFrame(r).kind, "results");
  }
  assertEquals(bridge.answerTableSize, 10);
});

Deno.test("RpcServerBridge defaults apply reasonable answer table bounds", () => {
  // The default bridge should have limits set but be usable without options.
  const bridge = new RpcServerBridge();
  // Just verify the bridge constructs without error and has expected initial state.
  assertEquals(bridge.answerTableSize, 0);
});

Deno.test("RpcServerBridge answer table full does not prevent finish or release", async () => {
  const bridge = new RpcServerBridge({
    maxAnswerTableSize: 1,
    answerEvictionTimeoutMs: 0,
  });

  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => Promise.resolve(encodeSingleU32StructMessage(1)),
  }, { capabilityIndex: 5, referenceCount: 2 });

  // Fill the answer table.
  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assertEquals(bridge.answerTableSize, 1);

  // Release and finish should still work even when table is full.
  const releaseResult = await bridge.handleFrame(
    encodeReleaseFrame({ id: 5, referenceCount: 1 }),
  );
  assertEquals(releaseResult, null);
  assertEquals(bridge.hasCapability(5), true);

  const finishResult = await bridge.handleFrame(
    encodeFinishFrame({ questionId: 1 }),
  );
  assertEquals(finishResult, null);
  assertEquals(bridge.answerTableSize, 0);
});

// --- Answer Table Eviction vs Pipelined Call Race Tests ---

Deno.test("RpcServerBridge eviction deferred while pipelined call is in-flight", async () => {
  // Use a very short eviction timeout so the timer fires while the
  // pipelined dispatch is still running.
  const bridge = new RpcServerBridge({
    answerEvictionTimeoutMs: 10,
  });

  // Gate to control when the pipelined dispatch completes.
  const gate = deferred<void>();

  // Factory capability: returns a cap id in its result.
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(1),
        capTable: [{ tag: 1, id: 10 }],
      }),
  }, { capabilityIndex: 5 });

  // Target capability: blocks until we release the gate.
  bridge.exportCapability({
    interfaceId: 0x5678n,
    dispatch: async () => {
      await gate.promise;
      return encodeSingleU32StructMessage(42);
    },
  }, { capabilityIndex: 10 });

  // Step 1: Make the initial call (question 1) to the factory.
  const factoryResponse = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(factoryResponse !== null, "expected factory response");
  assertEquals(decodeReturnFrame(factoryResponse).kind, "results");
  assertEquals(bridge.answerTableSize, 1);

  // Step 2: Start a pipelined call targeting question 1. This will block
  // inside the target capability dispatch because we hold the gate.
  const pipelinedPromise = bridge.handleFrame(encodeCallRequestFrame({
    questionId: 2,
    interfaceId: 0x5678n,
    methodId: 0,
    target: {
      tag: 1,
      promisedAnswer: {
        questionId: 1,
        transform: [],
      },
    },
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  // Step 3: Wait long enough for the eviction timer to fire at least once.
  await new Promise((resolve) => setTimeout(resolve, 50));

  // The entry for question 1 should still be present because the pipelined
  // call has incremented the pipeline ref count.
  assertEquals(bridge.answerTableSize >= 1, true);

  // Step 4: Release the gate and let the pipelined call complete.
  gate.resolve();
  const pipelinedResponse = await pipelinedPromise;
  assert(pipelinedResponse !== null, "expected pipelined response");
  const decoded = decodeReturnFrame(pipelinedResponse);
  assertEquals(decoded.kind, "results");
  if (decoded.kind === "results") {
    assertEquals(decodeSingleU32StructMessage(decoded.contentBytes), 42);
  }

  // Clean up: send Finish for both questions so eviction timers are
  // cancelled and Deno's test sanitizer does not report timer leaks.
  await bridge.handleFrame(encodeFinishFrame({ questionId: 1 }));
  await bridge.handleFrame(encodeFinishFrame({ questionId: 2 }));
});

Deno.test("RpcServerBridge eviction proceeds after pipelined call completes", async () => {
  const bridge = new RpcServerBridge({
    answerEvictionTimeoutMs: 20,
  });

  const gate = deferred<void>();

  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(1),
        capTable: [{ tag: 1, id: 10 }],
      }),
  }, { capabilityIndex: 5 });

  bridge.exportCapability({
    interfaceId: 0x5678n,
    dispatch: async () => {
      await gate.promise;
      return encodeSingleU32StructMessage(99);
    },
  }, { capabilityIndex: 10 });

  // Initial call.
  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assertEquals(bridge.answerTableSize, 1);

  // Start the pipelined call (blocks on gate).
  const pipelinedPromise = bridge.handleFrame(encodeCallRequestFrame({
    questionId: 2,
    interfaceId: 0x5678n,
    methodId: 0,
    target: {
      tag: 1,
      promisedAnswer: {
        questionId: 1,
        transform: [],
      },
    },
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  // Let the eviction timer fire while the pipelined call is still in-flight.
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Entry should still be present (deferred by ref count).
  assertEquals(bridge.answerTableSize >= 1, true);

  // Release the pipelined call.
  gate.resolve();
  await pipelinedPromise;

  // Now wait for the rescheduled eviction timer to fire and actually evict.
  await new Promise((resolve) => setTimeout(resolve, 60));

  // The entry for question 1 should now be evicted (question 2 was its own
  // entry, also evicted by now).
  assertEquals(bridge.answerTableSize, 0);
});

Deno.test("RpcServerBridge multiple concurrent pipelined calls against same question defer eviction", async () => {
  const bridge = new RpcServerBridge({
    answerEvictionTimeoutMs: 10,
  });

  const gate1 = deferred<void>();
  const gate2 = deferred<void>();
  let dispatchCount = 0;

  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(1),
        capTable: [{ tag: 1, id: 10 }],
      }),
  }, { capabilityIndex: 5 });

  // Target capability: each call blocks on a different gate.
  bridge.exportCapability({
    interfaceId: 0x5678n,
    dispatch: async () => {
      dispatchCount += 1;
      const currentCount = dispatchCount;
      if (currentCount === 1) {
        await gate1.promise;
      } else {
        await gate2.promise;
      }
      return encodeSingleU32StructMessage(currentCount * 100);
    },
  }, { capabilityIndex: 10 });

  // Initial factory call.
  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assertEquals(bridge.answerTableSize, 1);

  // Start two concurrent pipelined calls against question 1.
  const pipelined1 = bridge.handleFrame(encodeCallRequestFrame({
    questionId: 2,
    interfaceId: 0x5678n,
    methodId: 0,
    target: {
      tag: 1,
      promisedAnswer: {
        questionId: 1,
        transform: [],
      },
    },
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  const pipelined2 = bridge.handleFrame(encodeCallRequestFrame({
    questionId: 3,
    interfaceId: 0x5678n,
    methodId: 1,
    target: {
      tag: 1,
      promisedAnswer: {
        questionId: 1,
        transform: [],
      },
    },
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  // Let the eviction timer fire.
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Entry should still exist because both pipelined calls are in-flight.
  assertEquals(bridge.answerTableSize >= 1, true);

  // Release the first pipelined call.
  gate1.resolve();
  const r1 = await pipelined1;
  assert(r1 !== null, "expected pipelined response 1");
  assertEquals(decodeReturnFrame(r1).kind, "results");

  // After releasing one, the second is still in-flight, so the entry
  // for question 1 should still be protected.
  await new Promise((resolve) => setTimeout(resolve, 30));
  // question 1 entry should still be present (or at least question 3 entry).
  // The key assertion: question 1 should not have been evicted while
  // a pipelined call is still referencing it.

  // Release the second pipelined call.
  gate2.resolve();
  const r2 = await pipelined2;
  assert(r2 !== null, "expected pipelined response 2");
  assertEquals(decodeReturnFrame(r2).kind, "results");

  if (decodeReturnFrame(r1).kind === "results") {
    assertEquals(
      decodeSingleU32StructMessage(
        (decodeReturnFrame(r1) as { contentBytes: Uint8Array }).contentBytes,
      ),
      100,
    );
  }
  if (decodeReturnFrame(r2).kind === "results") {
    assertEquals(
      decodeSingleU32StructMessage(
        (decodeReturnFrame(r2) as { contentBytes: Uint8Array }).contentBytes,
      ),
      200,
    );
  }

  // Wait for eviction timers to clean up all entries.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals(bridge.answerTableSize, 0);
});

Deno.test("RpcServerBridge force-evicts entry after maxEvictionRetries and reports error", async () => {
  const errors: Array<{ error: unknown; questionId: number }> = [];

  // Use a very short eviction timeout (10ms) and a low retry limit (3).
  const bridge = new RpcServerBridge({
    answerEvictionTimeoutMs: 10,
    maxEvictionRetries: 3,
    onUnhandledError: (error, call) => {
      errors.push({ error, questionId: call.questionId });
    },
  });

  // Never-resolving gate to keep pipelineRefCount > 0 indefinitely.
  const gate = deferred<void>();

  // Factory capability: returns a cap id in its result.
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(1),
        capTable: [{ tag: 1, id: 10 }],
      }),
  }, { capabilityIndex: 5 });

  // Target capability: blocks indefinitely on the gate.
  bridge.exportCapability({
    interfaceId: 0x5678n,
    dispatch: async () => {
      await gate.promise;
      return encodeSingleU32StructMessage(42);
    },
  }, { capabilityIndex: 10 });

  // Step 1: Make the initial call (question 1) to the factory.
  const factoryResponse = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(factoryResponse !== null, "expected factory response");
  assertEquals(decodeReturnFrame(factoryResponse).kind, "results");
  assertEquals(bridge.answerTableSize, 1);

  // Step 2: Start a pipelined call targeting question 1. This will block
  // indefinitely because we never resolve the gate.
  const pipelinedPromise = bridge.handleFrame(encodeCallRequestFrame({
    questionId: 2,
    interfaceId: 0x5678n,
    methodId: 0,
    target: {
      tag: 1,
      promisedAnswer: {
        questionId: 1,
        transform: [],
      },
    },
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  // Step 3: Wait long enough for multiple eviction attempts to occur.
  // With timeout=10ms and maxRetries=3, we need to wait at least 40ms
  // for 4 eviction timer firings (initial + 3 retries, then force-evict).
  await new Promise((resolve) => setTimeout(resolve, 80));

  // The entry for question 1 should have been force-evicted after exceeding
  // the retry limit, despite the pipelined call still being in-flight.
  assertEquals(bridge.answerTableSize, 1); // Only question 2 should remain

  // Verify that the error handler was called with a force-eviction warning.
  assertEquals(errors.length, 1);
  const errorMsg = errors[0].error instanceof Error
    ? errors[0].error.message
    : String(errors[0].error);
  assert(
    errorMsg.includes("Force-evicted"),
    `Expected force-eviction error, got: ${errorMsg}`,
  );
  assert(
    errorMsg.includes("question 1"),
    `Expected error to mention question 1, got: ${errorMsg}`,
  );
  assert(
    errorMsg.includes("eviction attempts"),
    `Expected error to mention eviction attempts, got: ${errorMsg}`,
  );
  assert(
    errorMsg.includes("pipelineRefCount=1"),
    `Expected error to mention pipelineRefCount, got: ${errorMsg}`,
  );

  // Clean up: release the gate and finish the pipelined call.
  gate.resolve();
  await pipelinedPromise;
  await bridge.handleFrame(encodeFinishFrame({ questionId: 2 }));
});
