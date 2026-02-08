import {
  decodeCallRequestFrame,
  decodeReturnFrame,
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

// --- Server-side pipelining edge cases and robustness tests ---

Deno.test("RpcServerBridge: pipelined call with empty transform uses capTable[0]", async () => {
  const bridge = new RpcServerBridge();

  // Factory that returns a capability in capTable[0]
  bridge.exportCapability({
    interfaceId: 0xAAAAn,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(1),
        capTable: [{ tag: 1, id: 50 }],
      }),
  }, { capabilityIndex: 1 });

  // The service capability
  let serviceCalled = false;
  bridge.exportCapability({
    interfaceId: 0xBBBBn,
    dispatch: (_method, params) => {
      serviceCalled = true;
      return encodeSingleU32StructMessage(
        decodeSingleU32StructMessage(params) + 100,
      );
    },
  }, { capabilityIndex: 50 });

  // Call the factory
  await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 1,
      interfaceId: 0xAAAAn,
      methodId: 0,
      targetImportedCap: 1,
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );

  // Pipelined call with empty transform (should use capTable[0])
  const pipelinedFrame = await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 2,
      interfaceId: 0xBBBBn,
      methodId: 0,
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

Deno.test("RpcServerBridge: pipelined call with getPointerField selecting different indices", async () => {
  const bridge = new RpcServerBridge();

  // Factory that returns multiple capabilities
  bridge.exportCapability({
    interfaceId: 0xAAAAn,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(0),
        capTable: [
          { tag: 1, id: 10 },
          { tag: 1, id: 20 },
          { tag: 1, id: 30 },
        ],
      }),
  }, { capabilityIndex: 1 });

  const callLog: number[] = [];

  // Service capabilities at different indices
  bridge.exportCapability({
    interfaceId: 0xBBBBn,
    dispatch: () => {
      callLog.push(10);
      return encodeSingleU32StructMessage(10);
    },
  }, { capabilityIndex: 10 });

  bridge.exportCapability({
    interfaceId: 0xBBBBn,
    dispatch: () => {
      callLog.push(20);
      return encodeSingleU32StructMessage(20);
    },
  }, { capabilityIndex: 20 });

  bridge.exportCapability({
    interfaceId: 0xBBBBn,
    dispatch: () => {
      callLog.push(30);
      return encodeSingleU32StructMessage(30);
    },
  }, { capabilityIndex: 30 });

  // Call the factory
  await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 1,
      interfaceId: 0xAAAAn,
      methodId: 0,
      targetImportedCap: 1,
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );

  // Pipelined call selecting index 0
  await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 2,
      interfaceId: 0xBBBBn,
      methodId: 0,
      target: {
        tag: 1,
        promisedAnswer: {
          questionId: 1,
          transform: [{ tag: 1, pointerIndex: 0 }],
        },
      },
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );

  // Pipelined call selecting index 2
  await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 3,
      interfaceId: 0xBBBBn,
      methodId: 0,
      target: {
        tag: 1,
        promisedAnswer: {
          questionId: 1,
          transform: [{ tag: 1, pointerIndex: 2 }],
        },
      },
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );

  // Pipelined call selecting index 1
  await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 4,
      interfaceId: 0xBBBBn,
      methodId: 0,
      target: {
        tag: 1,
        promisedAnswer: {
          questionId: 1,
          transform: [{ tag: 1, pointerIndex: 1 }],
        },
      },
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );

  assertEquals(callLog.length, 3);
  assertEquals(callLog[0], 10);
  assertEquals(callLog[1], 30);
  assertEquals(callLog[2], 20);
});

Deno.test("RpcServerBridge: pipelined call targeting exception returns exception", async () => {
  const bridge = new RpcServerBridge();

  // Factory that throws an error
  bridge.exportCapability({
    interfaceId: 0xAAAAn,
    dispatch: () => {
      throw new Error("factory failed");
    },
  }, { capabilityIndex: 1 });

  // Call the factory (which will fail)
  const factoryFrame = await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 1,
      interfaceId: 0xAAAAn,
      methodId: 0,
      targetImportedCap: 1,
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );
  assert(factoryFrame !== null);
  const factoryDecoded = decodeReturnFrame(factoryFrame);
  assertEquals(factoryDecoded.kind, "exception");

  // Pipelined call targeting the failed question
  const pipelinedFrame = await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 2,
      interfaceId: 0xBBBBn,
      methodId: 0,
      target: {
        tag: 1,
        promisedAnswer: {
          questionId: 1,
          transform: [],
        },
      },
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );
  assert(pipelinedFrame !== null);
  const pipelinedDecoded = decodeReturnFrame(pipelinedFrame);
  assertEquals(pipelinedDecoded.kind, "exception");
  if (pipelinedDecoded.kind === "exception") {
    assert(
      /resolved with exception.*factory failed/i.test(pipelinedDecoded.reason),
      `expected exception mentioning factory failure, got: ${pipelinedDecoded.reason}`,
    );
  }
});

Deno.test("RpcServerBridge: pipelined call with out-of-range pointer index returns exception", async () => {
  const bridge = new RpcServerBridge();

  // Factory that returns only one capability
  bridge.exportCapability({
    interfaceId: 0xAAAAn,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(0),
        capTable: [{ tag: 1, id: 50 }],
      }),
  }, { capabilityIndex: 1 });

  // Call the factory
  await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 1,
      interfaceId: 0xAAAAn,
      methodId: 0,
      targetImportedCap: 1,
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );

  // Pipelined call with out-of-range index (3, but only 1 capability in table)
  const pipelinedFrame = await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 2,
      interfaceId: 0xBBBBn,
      methodId: 0,
      target: {
        tag: 1,
        promisedAnswer: {
          questionId: 1,
          transform: [{ tag: 1, pointerIndex: 3 }],
        },
      },
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );
  assert(pipelinedFrame !== null);
  const decoded = decodeReturnFrame(pipelinedFrame);
  assertEquals(decoded.kind, "exception");
  if (decoded.kind === "exception") {
    assert(
      /out of range.*cap table has 1 entries/i.test(decoded.reason),
      `expected out-of-range error, got: ${decoded.reason}`,
    );
  }
});

Deno.test("RpcServerBridge: pipelined call with noop transform ops", async () => {
  const bridge = new RpcServerBridge();

  // Factory that returns multiple capabilities
  bridge.exportCapability({
    interfaceId: 0xAAAAn,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(0),
        capTable: [
          { tag: 1, id: 10 },
          { tag: 1, id: 20 },
        ],
      }),
  }, { capabilityIndex: 1 });

  let serviceCalledOnCap = -1;
  bridge.exportCapability({
    interfaceId: 0xBBBBn,
    dispatch: (_method, _params, ctx) => {
      serviceCalledOnCap = ctx.capability.capabilityIndex;
      return encodeSingleU32StructMessage(0);
    },
  }, { capabilityIndex: 20 });

  // Call the factory
  await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 1,
      interfaceId: 0xAAAAn,
      methodId: 0,
      targetImportedCap: 1,
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );

  // Pipelined call with mixed noop and getPointerField ops
  // The transform has: noop, getPointerField(1), noop
  // Should result in selecting capability at index 1 (id: 20)
  await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 2,
      interfaceId: 0xBBBBn,
      methodId: 0,
      target: {
        tag: 1,
        promisedAnswer: {
          questionId: 1,
          transform: [
            { tag: 0 }, // noop
            { tag: 1, pointerIndex: 1 }, // getPointerField
            { tag: 0 }, // noop
          ],
        },
      },
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );

  assertEquals(serviceCalledOnCap, 20);
});

Deno.test("RpcServerBridge: multiple pipelined calls against same question", async () => {
  const bridge = new RpcServerBridge();

  // Factory that returns a capability
  bridge.exportCapability({
    interfaceId: 0xAAAAn,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(0),
        capTable: [{ tag: 1, id: 50 }],
      }),
  }, { capabilityIndex: 1 });

  const callLog: number[] = [];
  bridge.exportCapability({
    interfaceId: 0xBBBBn,
    dispatch: (_method, params) => {
      const value = decodeSingleU32StructMessage(params);
      callLog.push(value);
      return encodeSingleU32StructMessage(value * 2);
    },
  }, { capabilityIndex: 50 });

  // Call the factory
  await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 1,
      interfaceId: 0xAAAAn,
      methodId: 0,
      targetImportedCap: 1,
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );

  // Make multiple pipelined calls against question 1
  await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 2,
      interfaceId: 0xBBBBn,
      methodId: 0,
      target: {
        tag: 1,
        promisedAnswer: { questionId: 1, transform: [] },
      },
      paramsContent: encodeSingleU32StructMessage(10),
    }),
  );

  await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 3,
      interfaceId: 0xBBBBn,
      methodId: 0,
      target: {
        tag: 1,
        promisedAnswer: { questionId: 1, transform: [] },
      },
      paramsContent: encodeSingleU32StructMessage(20),
    }),
  );

  await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 4,
      interfaceId: 0xBBBBn,
      methodId: 0,
      target: {
        tag: 1,
        promisedAnswer: { questionId: 1, transform: [] },
      },
      paramsContent: encodeSingleU32StructMessage(30),
    }),
  );

  assertEquals(callLog.length, 3);
  assertEquals(callLog[0], 10);
  assertEquals(callLog[1], 20);
  assertEquals(callLog[2], 30);
});

Deno.test("RpcServerBridge: pipelined call waits for target question to resolve", async () => {
  const bridge = new RpcServerBridge();

  let factoryResolve!: () => void;
  const factoryPromise = new Promise<void>((resolve) => {
    factoryResolve = resolve;
  });

  // Factory with delayed resolution
  bridge.exportCapability({
    interfaceId: 0xAAAAn,
    dispatch: async () => {
      await factoryPromise;
      return {
        content: encodeSingleU32StructMessage(1),
        capTable: [{ tag: 1, id: 50 }],
      };
    },
  }, { capabilityIndex: 1 });

  let serviceCalled = false;
  bridge.exportCapability({
    interfaceId: 0xBBBBn,
    dispatch: () => {
      serviceCalled = true;
      return encodeSingleU32StructMessage(42);
    },
  }, { capabilityIndex: 50 });

  // Start the factory call (but don't await yet)
  const factoryPromiseResult = bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 1,
      interfaceId: 0xAAAAn,
      methodId: 0,
      targetImportedCap: 1,
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );

  // Start pipelined call immediately (should wait for factory to complete)
  const pipelinedPromise = bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 2,
      interfaceId: 0xBBBBn,
      methodId: 0,
      target: {
        tag: 1,
        promisedAnswer: { questionId: 1, transform: [] },
      },
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );

  // Service should not be called yet
  assertEquals(serviceCalled, false);

  // Now resolve the factory
  factoryResolve();
  await factoryPromiseResult;

  // Pipelined call should now complete
  const pipelinedFrame = await pipelinedPromise;
  assert(pipelinedFrame !== null);
  assertEquals(serviceCalled, true);
});

Deno.test({
  name:
    "RpcServerBridge: pipelineRefCount prevents eviction during in-flight calls",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const bridge = new RpcServerBridge({
      answerEvictionTimeoutMs: 50,
    });

    let serviceResolve!: () => void;
    const servicePromise = new Promise<void>((resolve) => {
      serviceResolve = resolve;
    });

    // Factory that returns immediately
    bridge.exportCapability({
      interfaceId: 0xCCCCn,
      dispatch: () => ({
        content: encodeSingleU32StructMessage(1),
        capTable: [{ tag: 1, id: 50 }],
      }),
    }, { capabilityIndex: 2 });

    // Service with delayed resolution (this is what we pipeline to)
    bridge.exportCapability({
      interfaceId: 0xBBBBn,
      dispatch: async () => {
        await servicePromise;
        return encodeSingleU32StructMessage(42);
      },
    }, { capabilityIndex: 50 });

    // Call the factory (completes immediately)
    await bridge.handleFrame(
      encodeCallRequestFrame({
        questionId: 1,
        interfaceId: 0xCCCCn,
        methodId: 0,
        targetImportedCap: 2,
        paramsContent: encodeSingleU32StructMessage(0),
      }),
    );
    assertEquals(bridge.answerTableSize, 1);

    // Start a pipelined call with delayed service (will hold pipelineRefCount > 0)
    const pipelinedPromise = bridge.handleFrame(
      encodeCallRequestFrame({
        questionId: 2,
        interfaceId: 0xBBBBn,
        methodId: 0,
        target: {
          tag: 1,
          promisedAnswer: { questionId: 1, transform: [] },
        },
        paramsContent: encodeSingleU32StructMessage(0),
      }),
    );

    // Wait beyond the eviction timeout
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Both answer table entries should still exist (pipelined call is in-flight)
    // Question 1 (the factory) and Question 2 (the pipelined call)
    assertEquals(bridge.answerTableSize, 2);

    // Complete the pipelined call
    serviceResolve();
    await pipelinedPromise;

    // Now wait for eviction
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Entry should now be evicted
    assertEquals(bridge.answerTableSize, 0);
  },
});

Deno.test("RpcServerBridge: pipelineRefCount decrements on pipelined call error", async () => {
  const bridge = new RpcServerBridge();

  // Factory that returns empty cap table
  bridge.exportCapability({
    interfaceId: 0xAAAAn,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(1),
        capTable: [], // Empty cap table
      }),
  }, { capabilityIndex: 1 });

  // Call the factory
  await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 1,
      interfaceId: 0xAAAAn,
      methodId: 0,
      targetImportedCap: 1,
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );

  // Pipelined call with transform (should fail due to empty cap table)
  const pipelinedFrame = await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 2,
      interfaceId: 0xBBBBn,
      methodId: 0,
      target: {
        tag: 1,
        promisedAnswer: { questionId: 1, transform: [] },
      },
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );
  assert(pipelinedFrame !== null);
  const decoded = decodeReturnFrame(pipelinedFrame);
  assertEquals(decoded.kind, "exception");

  // Both answer table entries should still exist (question 1 and question 2)
  assertEquals(bridge.answerTableSize, 2);
});

Deno.test({
  name: "RpcServerBridge: finish deferred while pipelined call in-flight",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const bridge = new RpcServerBridge({
      answerEvictionTimeoutMs: 30,
    });

    let serviceResolve!: () => void;
    const servicePromise = new Promise<void>((resolve) => {
      serviceResolve = resolve;
    });

    // Factory that returns immediately
    bridge.exportCapability({
      interfaceId: 0xAAAAn,
      dispatch: () =>
        Promise.resolve({
          content: encodeSingleU32StructMessage(1),
          capTable: [{ tag: 1, id: 50 }],
        }),
    }, { capabilityIndex: 1 });

    // Service with delayed resolution
    bridge.exportCapability({
      interfaceId: 0xBBBBn,
      dispatch: async () => {
        await servicePromise;
        return encodeSingleU32StructMessage(42);
      },
    }, { capabilityIndex: 50 });

    // Call the factory
    await bridge.handleFrame(
      encodeCallRequestFrame({
        questionId: 1,
        interfaceId: 0xAAAAn,
        methodId: 0,
        targetImportedCap: 1,
        paramsContent: encodeSingleU32StructMessage(0),
      }),
    );
    assertEquals(bridge.answerTableSize, 1);

    // Start a long-running pipelined call
    const pipelinedPromise = bridge.handleFrame(
      encodeCallRequestFrame({
        questionId: 2,
        interfaceId: 0xBBBBn,
        methodId: 0,
        target: {
          tag: 1,
          promisedAnswer: { questionId: 1, transform: [] },
        },
        paramsContent: encodeSingleU32StructMessage(0),
      }),
    );

    // Wait for eviction timeout to pass
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Both entries should still be present (pipelined call is in-flight)
    // Question 1 and Question 2
    assertEquals(bridge.answerTableSize, 2);

    // Now complete the pipelined call
    serviceResolve();
    await pipelinedPromise;

    // Wait for next eviction timer
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Now both should be evicted
    assertEquals(bridge.answerTableSize, 0);
  },
});

Deno.test("RpcServerBridge: pipelined call to empty cap table returns exception", async () => {
  const bridge = new RpcServerBridge();

  // Factory that returns no capabilities
  bridge.exportCapability({
    interfaceId: 0xAAAAn,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(1),
        capTable: [],
      }),
  }, { capabilityIndex: 1 });

  // Call the factory
  await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 1,
      interfaceId: 0xAAAAn,
      methodId: 0,
      targetImportedCap: 1,
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );

  // Pipelined call with empty transform (should fail due to empty cap table)
  const pipelinedFrame = await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 2,
      interfaceId: 0xBBBBn,
      methodId: 0,
      target: {
        tag: 1,
        promisedAnswer: { questionId: 1, transform: [] },
      },
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );
  assert(pipelinedFrame !== null);
  const decoded = decodeReturnFrame(pipelinedFrame);
  assertEquals(decoded.kind, "exception");
  if (decoded.kind === "exception") {
    assert(
      /no capabilities in cap table/i.test(decoded.reason),
      `expected 'no capabilities' error, got: ${decoded.reason}`,
    );
  }
});

Deno.test("RpcServerBridge: pipelined call to unknown question returns exception", async () => {
  const bridge = new RpcServerBridge();

  // Pipelined call targeting non-existent question 999
  const pipelinedFrame = await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 1,
      interfaceId: 0xBBBBn,
      methodId: 0,
      target: {
        tag: 1,
        promisedAnswer: { questionId: 999, transform: [] },
      },
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );
  assert(pipelinedFrame !== null);
  const decoded = decodeReturnFrame(pipelinedFrame);
  assertEquals(decoded.kind, "exception");
  if (decoded.kind === "exception") {
    assert(
      /unknown question 999/i.test(decoded.reason),
      `expected 'unknown question' error, got: ${decoded.reason}`,
    );
  }
});

Deno.test("RpcServerBridge: multiple getPointerField transforms are rejected as unsupported", async () => {
  const bridge = new RpcServerBridge();

  // Factory that returns nested structure with capabilities
  bridge.exportCapability({
    interfaceId: 0xAAAAn,
    dispatch: () =>
      Promise.resolve({
        content: encodeSingleU32StructMessage(0),
        capTable: [
          { tag: 1, id: 10 },
          { tag: 1, id: 20 },
          { tag: 1, id: 30 },
          { tag: 1, id: 40 },
          { tag: 1, id: 50 },
        ],
      }),
  }, { capabilityIndex: 1 });

  // Call the factory to populate the answer table.
  await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 1,
      interfaceId: 0xAAAAn,
      methodId: 0,
      targetImportedCap: 1,
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );

  // Pipelined call with multiple getPointerField ops should be rejected
  // because multi-step transforms are not yet supported.
  const response = await bridge.handleFrame(
    encodeCallRequestFrame({
      questionId: 2,
      interfaceId: 0xBBBBn,
      methodId: 0,
      target: {
        tag: 1,
        promisedAnswer: {
          questionId: 1,
          transform: [
            { tag: 1, pointerIndex: 0 },
            { tag: 1, pointerIndex: 3 },
            { tag: 1, pointerIndex: 1 },
          ],
        },
      },
      paramsContent: encodeSingleU32StructMessage(0),
    }),
  );

  assert(
    response !== null,
    "expected exception return for multi-step transform",
  );
  const decoded = decodeReturnFrame(response);
  assertEquals(decoded.kind, "exception");
  if (decoded.kind === "exception") {
    assert(
      /multi-step promisedAnswer transforms.*not yet supported/i.test(
        decoded.reason,
      ),
      `expected multi-step transform error, got: ${decoded.reason}`,
    );
  }
});
