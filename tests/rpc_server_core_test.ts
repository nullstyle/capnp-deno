import {
  decodeReturnFrame,
  encodeBootstrapRequestFrame,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  RpcServerBridge,
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

// ---------------------------------------------------------------------------
// Bootstrap request dispatching
// ---------------------------------------------------------------------------

Deno.test("server core: bootstrap request is rejected as unsupported message tag", async () => {
  const bridge = new RpcServerBridge();
  const bootstrapFrame = encodeBootstrapRequestFrame({ questionId: 1 });

  let thrown: unknown;
  try {
    await bridge.handleFrame(bootstrapFrame);
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof Error &&
      /unsupported rpc message tag/i.test(thrown.message),
    `expected unsupported-tag error, got: ${String(thrown)}`,
  );
});

// ---------------------------------------------------------------------------
// Call dispatch to correct capability
// ---------------------------------------------------------------------------

Deno.test("server core: dispatches to the correct capability by index", async () => {
  const bridge = new RpcServerBridge();
  const dispatched: Array<{
    capIndex: number;
    methodOrdinal: number;
    paramValue: number;
  }> = [];

  // Export two capabilities at different indices.
  bridge.exportCapability({
    interfaceId: 0xAAAAn,
    dispatch: (methodOrdinal, params, ctx) => {
      dispatched.push({
        capIndex: ctx.capability.capabilityIndex,
        methodOrdinal,
        paramValue: decodeSingleU32StructMessage(params),
      });
      return encodeSingleU32StructMessage(100 + methodOrdinal);
    },
  }, { capabilityIndex: 3 });

  bridge.exportCapability({
    interfaceId: 0xBBBBn,
    dispatch: (methodOrdinal, params, ctx) => {
      dispatched.push({
        capIndex: ctx.capability.capabilityIndex,
        methodOrdinal,
        paramValue: decodeSingleU32StructMessage(params),
      });
      return encodeSingleU32StructMessage(200 + methodOrdinal);
    },
  }, { capabilityIndex: 7 });

  // Call capability 3, method 5.
  const r1 = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0xAAAAn,
    methodId: 5,
    targetImportedCap: 3,
    paramsContent: encodeSingleU32StructMessage(11),
  }));
  assert(r1 !== null, "expected response for call to cap 3");
  const d1 = decodeReturnFrame(r1);
  assertEquals(d1.kind, "results");
  assertEquals(d1.answerId, 1);
  if (d1.kind === "results") {
    assertEquals(decodeSingleU32StructMessage(d1.contentBytes), 105);
  }

  // Call capability 7, method 2.
  const r2 = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 2,
    interfaceId: 0xBBBBn,
    methodId: 2,
    targetImportedCap: 7,
    paramsContent: encodeSingleU32StructMessage(22),
  }));
  assert(r2 !== null, "expected response for call to cap 7");
  const d2 = decodeReturnFrame(r2);
  assertEquals(d2.kind, "results");
  assertEquals(d2.answerId, 2);
  if (d2.kind === "results") {
    assertEquals(decodeSingleU32StructMessage(d2.contentBytes), 202);
  }

  // Verify dispatch routing.
  assertEquals(dispatched.length, 2);
  assertEquals(dispatched[0].capIndex, 3);
  assertEquals(dispatched[0].methodOrdinal, 5);
  assertEquals(dispatched[0].paramValue, 11);
  assertEquals(dispatched[1].capIndex, 7);
  assertEquals(dispatched[1].methodOrdinal, 2);
  assertEquals(dispatched[1].paramValue, 22);
});

Deno.test("server core: dispatch context includes interfaceId and paramsCapTable", async () => {
  const bridge = new RpcServerBridge();
  let seenInterfaceId: bigint = 0n;
  let seenParamsCapTable: Array<{ tag: number; id: number }> = [];

  bridge.exportCapability({
    interfaceId: 0xDEADn,
    dispatch: (_methodOrdinal, _params, ctx) => {
      seenInterfaceId = ctx.interfaceId;
      seenParamsCapTable = [...ctx.paramsCapTable];
      return encodeSingleU32StructMessage(0);
    },
  }, { capabilityIndex: 1 });

  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0xDEADn,
    methodId: 0,
    targetImportedCap: 1,
    paramsContent: encodeSingleU32StructMessage(0),
    paramsCapTable: [{ tag: 1, id: 10 }, { tag: 3, id: 20 }],
  }));

  assertEquals(seenInterfaceId, 0xDEADn);
  assertEquals(seenParamsCapTable.length, 2);
  assertEquals(seenParamsCapTable[0].tag, 1);
  assertEquals(seenParamsCapTable[0].id, 10);
  assertEquals(seenParamsCapTable[1].tag, 3);
  assertEquals(seenParamsCapTable[1].id, 20);
});

// ---------------------------------------------------------------------------
// Answer table entry creation and cleanup
// ---------------------------------------------------------------------------

Deno.test("server core: answer table grows with calls and shrinks with finish", async () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(1),
  }, { capabilityIndex: 0 });

  assertEquals(bridge.answerTableSize, 0);

  // Make three calls.
  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 0,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assertEquals(bridge.answerTableSize, 1);

  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 2,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 0,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assertEquals(bridge.answerTableSize, 2);

  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 3,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 0,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assertEquals(bridge.answerTableSize, 3);

  // Finish question 2 in the middle.
  await bridge.handleFrame(encodeFinishFrame({ questionId: 2 }));
  assertEquals(bridge.answerTableSize, 2);

  // Finish question 1.
  await bridge.handleFrame(encodeFinishFrame({ questionId: 1 }));
  assertEquals(bridge.answerTableSize, 1);

  // Finish question 3.
  await bridge.handleFrame(encodeFinishFrame({ questionId: 3 }));
  assertEquals(bridge.answerTableSize, 0);
});

Deno.test("server core: finishing a nonexistent question is silently ignored", async () => {
  let finishCallbackFired = false;
  const bridge = new RpcServerBridge({
    onFinish: () => {
      finishCallbackFired = true;
    },
  });

  // Finishing a question that was never registered should not throw.
  const result = await bridge.handleFrame(
    encodeFinishFrame({ questionId: 999 }),
  );
  assertEquals(result, null);
  assertEquals(finishCallbackFired, true);
});

// ---------------------------------------------------------------------------
// Answer table size limit enforcement
// ---------------------------------------------------------------------------

Deno.test("server core: answer table rejects new calls when full", async () => {
  const bridge = new RpcServerBridge({
    maxAnswerTableSize: 2,
  });

  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(1),
  }, { capabilityIndex: 0 });

  // Fill the table.
  const r1 = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 0,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(r1 !== null, "expected response 1");
  assertEquals(decodeReturnFrame(r1).kind, "results");

  const r2 = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 2,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 0,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(r2 !== null, "expected response 2");
  assertEquals(decodeReturnFrame(r2).kind, "results");
  assertEquals(bridge.answerTableSize, 2);

  // Third call should be rejected.
  const r3 = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 3,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 0,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(r3 !== null, "expected rejection response 3");
  const d3 = decodeReturnFrame(r3);
  assertEquals(d3.kind, "exception");
  assertEquals(d3.answerId, 3);
  if (d3.kind === "exception") {
    assert(
      /answer table is full/i.test(d3.reason),
      `expected full-table reason, got: ${d3.reason}`,
    );
  }
  // Rejected call should NOT be added to the answer table.
  assertEquals(bridge.answerTableSize, 2);

  // Finishing one entry should allow a new call.
  await bridge.handleFrame(encodeFinishFrame({ questionId: 1 }));
  assertEquals(bridge.answerTableSize, 1);

  const r4 = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 4,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 0,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(r4 !== null, "expected response 4 after freeing slot");
  assertEquals(decodeReturnFrame(r4).kind, "results");
  assertEquals(bridge.answerTableSize, 2);
});

Deno.test("server core: maxAnswerTableSize=Infinity disables limit", async () => {
  const bridge = new RpcServerBridge({
    maxAnswerTableSize: Infinity,
  });

  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(1),
  }, { capabilityIndex: 0 });

  // Should accept many calls without rejection.
  for (let i = 1; i <= 20; i++) {
    const r = await bridge.handleFrame(encodeCallRequestFrame({
      questionId: i,
      interfaceId: 0x1234n,
      methodId: 0,
      targetImportedCap: 0,
      paramsContent: encodeSingleU32StructMessage(0),
    }));
    assert(r !== null, `expected response for question ${i}`);
    assertEquals(decodeReturnFrame(r).kind, "results");
  }
  assertEquals(bridge.answerTableSize, 20);
});

// ---------------------------------------------------------------------------
// Finish frame releases answer entry
// ---------------------------------------------------------------------------

Deno.test("server core: finish frame clears answer table and invokes onFinish callback", async () => {
  const finishedQuestions: number[] = [];
  const bridge = new RpcServerBridge({
    onFinish: (finish) => {
      finishedQuestions.push(finish.questionId);
    },
  });

  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(1),
        capTable: [{ tag: 1, id: 10 }],
      }),
  }, { capabilityIndex: 0 });

  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 10,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 0,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assertEquals(bridge.answerTableSize, 1);

  await bridge.handleFrame(encodeFinishFrame({ questionId: 10 }));
  assertEquals(bridge.answerTableSize, 0);
  assertEquals(finishedQuestions.length, 1);
  assertEquals(finishedQuestions[0], 10);
});

// ---------------------------------------------------------------------------
// Release frame decrements reference count
// ---------------------------------------------------------------------------

Deno.test("server core: release frame decrements refcount and removes capability at zero", async () => {
  const bridge = new RpcServerBridge();

  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(0),
  }, { capabilityIndex: 5, referenceCount: 3 });

  assertEquals(bridge.hasCapability(5), true);

  // Release 1 of 3 references.
  await bridge.handleFrame(
    encodeReleaseFrame({ id: 5, referenceCount: 1 }),
  );
  assertEquals(bridge.hasCapability(5), true);

  // Release another 1 -- 1 remaining.
  await bridge.handleFrame(
    encodeReleaseFrame({ id: 5, referenceCount: 1 }),
  );
  assertEquals(bridge.hasCapability(5), true);

  // Release the last 1 -- capability should be removed.
  await bridge.handleFrame(
    encodeReleaseFrame({ id: 5, referenceCount: 1 }),
  );
  assertEquals(bridge.hasCapability(5), false);
});

Deno.test("server core: release frame with count larger than refcount removes capability", async () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(0),
  }, { capabilityIndex: 2, referenceCount: 2 });

  assertEquals(bridge.hasCapability(2), true);

  // Release more references than exist.
  await bridge.handleFrame(
    encodeReleaseFrame({ id: 2, referenceCount: 5 }),
  );
  assertEquals(bridge.hasCapability(2), false);
});

Deno.test("server core: release for unknown capability is silently ignored", async () => {
  const bridge = new RpcServerBridge();
  // No capability 99 registered, should not throw.
  const result = await bridge.handleFrame(
    encodeReleaseFrame({ id: 99, referenceCount: 1 }),
  );
  assertEquals(result, null);
});

// ---------------------------------------------------------------------------
// Error during dispatch sends exception return
// ---------------------------------------------------------------------------

Deno.test("server core: dispatch Error becomes exception return with message", async () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => {
      throw new Error("dispatch kaboom");
    },
  }, { capabilityIndex: 0 });

  const response = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 0,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(response !== null, "expected exception return frame");
  const decoded = decodeReturnFrame(response);
  assertEquals(decoded.kind, "exception");
  assertEquals(decoded.answerId, 1);
  if (decoded.kind === "exception") {
    assert(
      /dispatch kaboom/i.test(decoded.reason),
      `expected 'dispatch kaboom' in reason, got: ${decoded.reason}`,
    );
  }
});

Deno.test("server core: dispatch string throw becomes exception reason", async () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => {
      throw "raw string error";
    },
  }, { capabilityIndex: 0 });

  const response = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 0,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(response !== null, "expected exception return frame");
  const decoded = decodeReturnFrame(response);
  assertEquals(decoded.kind, "exception");
  if (decoded.kind === "exception") {
    assertEquals(decoded.reason, "raw string error");
  }
});

Deno.test("server core: async dispatch rejection becomes exception return", async () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => Promise.reject(new Error("async failure")),
  }, { capabilityIndex: 0 });

  const response = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 5,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 0,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(response !== null, "expected exception return frame");
  const decoded = decodeReturnFrame(response);
  assertEquals(decoded.kind, "exception");
  assertEquals(decoded.answerId, 5);
  if (decoded.kind === "exception") {
    assert(
      /async failure/i.test(decoded.reason),
      `expected 'async failure' in reason, got: ${decoded.reason}`,
    );
  }
});

Deno.test("server core: onUnhandledError callback receives dispatch errors", async () => {
  const seenErrors: Array<{ questionId: number; message: string }> = [];
  const bridge = new RpcServerBridge({
    onUnhandledError: (error, call) => {
      const msg = error instanceof Error ? error.message : String(error);
      seenErrors.push({ questionId: call.questionId, message: msg });
    },
  });
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => {
      throw new Error("error for callback");
    },
  }, { capabilityIndex: 0 });

  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 42,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 0,
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  assertEquals(seenErrors.length, 1);
  assertEquals(seenErrors[0].questionId, 42);
  assertEquals(seenErrors[0].message, "error for callback");
});

// ---------------------------------------------------------------------------
// Unknown capability ID handling
// ---------------------------------------------------------------------------

Deno.test("server core: call to unregistered capability returns exception", async () => {
  const bridge = new RpcServerBridge();
  // No capabilities registered.

  const response = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 42,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(response !== null, "expected exception return frame");
  const decoded = decodeReturnFrame(response);
  assertEquals(decoded.kind, "exception");
  assertEquals(decoded.answerId, 1);
  if (decoded.kind === "exception") {
    assert(
      /unknown capability index: 42/i.test(decoded.reason),
      `expected 'unknown capability index' in reason, got: ${decoded.reason}`,
    );
  }
});

Deno.test("server core: call to released capability returns exception", async () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(1),
  }, { capabilityIndex: 3, referenceCount: 1 });

  // Release the capability.
  bridge.releaseCapability(3, 1);
  assertEquals(bridge.hasCapability(3), false);

  // Now try to call it.
  const response = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 3,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(response !== null, "expected exception return frame");
  const decoded = decodeReturnFrame(response);
  assertEquals(decoded.kind, "exception");
  if (decoded.kind === "exception") {
    assert(
      /unknown capability index: 3/i.test(decoded.reason),
      `expected unknown cap reason, got: ${decoded.reason}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Interface mismatch
// ---------------------------------------------------------------------------

Deno.test("server core: interface mismatch returns exception", async () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0xAAAAn,
    dispatch: () => encodeSingleU32StructMessage(0),
  }, { capabilityIndex: 1 });

  const response = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0xBBBBn,
    methodId: 0,
    targetImportedCap: 1,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(response !== null, "expected exception return frame");
  const decoded = decodeReturnFrame(response);
  assertEquals(decoded.kind, "exception");
  if (decoded.kind === "exception") {
    assert(
      /interface mismatch/i.test(decoded.reason),
      `expected interface mismatch reason, got: ${decoded.reason}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Capability registration edge cases
// ---------------------------------------------------------------------------

Deno.test("server core: auto-assigned capability indexes increment correctly", () => {
  const bridge = new RpcServerBridge({ nextCapabilityIndex: 5 });
  const dispatch = {
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(0),
  };

  const c1 = bridge.exportCapability(dispatch);
  const c2 = bridge.exportCapability(dispatch);
  const c3 = bridge.exportCapability(dispatch);

  assertEquals(c1.capabilityIndex, 5);
  assertEquals(c2.capabilityIndex, 6);
  assertEquals(c3.capabilityIndex, 7);
});

Deno.test("server core: retainCapability increases refcount", () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(0),
  }, { capabilityIndex: 0, referenceCount: 1 });

  bridge.retainCapability(0, 2);
  // Now refcount is 3. Release 2 -- should still be alive.
  assertEquals(bridge.releaseCapability(0, 2), true);
  assertEquals(bridge.hasCapability(0), true);
  // Release last one.
  assertEquals(bridge.releaseCapability(0, 1), false);
  assertEquals(bridge.hasCapability(0), false);
});

Deno.test("server core: duplicate export throws", () => {
  const bridge = new RpcServerBridge();
  const dispatch = {
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(0),
  };

  bridge.exportCapability(dispatch, { capabilityIndex: 5 });

  let thrown: unknown;
  try {
    bridge.exportCapability(dispatch, { capabilityIndex: 5 });
  } catch (e) {
    thrown = e;
  }
  assert(
    thrown instanceof Error &&
      /already has a registered server dispatch/i.test(thrown.message),
    `expected duplicate export error, got: ${String(thrown)}`,
  );
});

// ---------------------------------------------------------------------------
// Response with cap table and return flags
// ---------------------------------------------------------------------------

Deno.test("server core: dispatch response with capTable and return flags is encoded correctly", async () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => ({
      content: encodeSingleU32StructMessage(55),
      capTable: [{ tag: 1, id: 10 }, { tag: 3, id: 20 }],
      releaseParamCaps: false,
      noFinishNeeded: true,
    }),
  }, { capabilityIndex: 0 });

  const response = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 0,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(response !== null, "expected response frame");
  const decoded = decodeReturnFrame(response);
  assertEquals(decoded.kind, "results");
  assertEquals(decoded.answerId, 1);
  assertEquals(decoded.releaseParamCaps, false);
  assertEquals(decoded.noFinishNeeded, true);
  if (decoded.kind === "results") {
    assertEquals(decodeSingleU32StructMessage(decoded.contentBytes), 55);
    assertEquals(decoded.capTable.length, 2);
    assertEquals(decoded.capTable[0].tag, 1);
    assertEquals(decoded.capTable[0].id, 10);
    assertEquals(decoded.capTable[1].tag, 3);
    assertEquals(decoded.capTable[1].id, 20);
  }
});

// ---------------------------------------------------------------------------
// Multiple calls and interleaved finish/release
// ---------------------------------------------------------------------------

Deno.test("server core: interleaved calls, finishes, and releases work correctly", async () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: (methodOrdinal) =>
      encodeSingleU32StructMessage(methodOrdinal * 10),
  }, { capabilityIndex: 0, referenceCount: 5 });

  // Call 1.
  const r1 = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 1,
    targetImportedCap: 0,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(r1 !== null);
  assertEquals(decodeReturnFrame(r1).kind, "results");

  // Release 2 refs.
  await bridge.handleFrame(
    encodeReleaseFrame({ id: 0, referenceCount: 2 }),
  );
  assertEquals(bridge.hasCapability(0), true);

  // Call 2.
  const r2 = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 2,
    interfaceId: 0x1234n,
    methodId: 2,
    targetImportedCap: 0,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(r2 !== null);
  assertEquals(decodeReturnFrame(r2).kind, "results");

  // Finish call 1.
  await bridge.handleFrame(encodeFinishFrame({ questionId: 1 }));
  assertEquals(bridge.answerTableSize, 1);

  // Release remaining 3 refs -- cap should be removed.
  await bridge.handleFrame(
    encodeReleaseFrame({ id: 0, referenceCount: 3 }),
  );
  assertEquals(bridge.hasCapability(0), false);

  // Finish call 2.
  await bridge.handleFrame(encodeFinishFrame({ questionId: 2 }));
  assertEquals(bridge.answerTableSize, 0);
});

// ---------------------------------------------------------------------------
// Answer table eviction timeout
// ---------------------------------------------------------------------------

Deno.test("server core: answer table entry is evicted after timeout when no finish arrives", async () => {
  const bridge = new RpcServerBridge({
    answerEvictionTimeoutMs: 30,
  });

  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(1),
  }, { capabilityIndex: 0 });

  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 0,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assertEquals(bridge.answerTableSize, 1);

  // Wait for the eviction timer.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assertEquals(bridge.answerTableSize, 0);
});

// ---------------------------------------------------------------------------
// Dispatch returning Uint8Array directly (convenience form)
// ---------------------------------------------------------------------------

Deno.test("server core: dispatch returning raw Uint8Array is treated as content-only response", async () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(77),
  }, { capabilityIndex: 0 });

  const response = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 0,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(response !== null, "expected response frame");
  const decoded = decodeReturnFrame(response);
  assertEquals(decoded.kind, "results");
  if (decoded.kind === "results") {
    assertEquals(decodeSingleU32StructMessage(decoded.contentBytes), 77);
    assertEquals(decoded.capTable.length, 0);
    assertEquals(decoded.releaseParamCaps, true);
    assertEquals(decoded.noFinishNeeded, false);
  }
});

// ---------------------------------------------------------------------------
// Exception answers still get added to answer table
// ---------------------------------------------------------------------------

Deno.test("server core: exception dispatch still creates answer table entry", async () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => {
      throw new Error("boom");
    },
  }, { capabilityIndex: 0 });

  const response = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 0,
    paramsContent: encodeSingleU32StructMessage(0),
  }));
  assert(response !== null, "expected exception response");
  assertEquals(decodeReturnFrame(response).kind, "exception");

  // The answer table should still track this question (for pipelining purposes).
  assertEquals(bridge.answerTableSize, 1);

  // Finishing it should clear the table.
  await bridge.handleFrame(encodeFinishFrame({ questionId: 1 }));
  assertEquals(bridge.answerTableSize, 0);
});
