import {
  decodeReturnFrame,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  RpcServerBridge,
  type RpcServerMiddleware,
  type ServerMiddlewareContext,
} from "../advanced.ts";
import { assert, assertEquals } from "./test_utils.ts";

function assertArrayEquals<T>(
  actual: T[],
  expected: T[],
  label = "arrays are not equal",
): void {
  assertEquals(actual.length, expected.length, `${label} (length)`);
  for (let i = 0; i < expected.length; i++) {
    assertEquals(actual[i], expected[i], `${label} (index ${i})`);
  }
}

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
  return view.getUint32(8 + (dataWord * 8), true);
}

// --- onIncomingFrame tests ---

Deno.test("ServerMiddleware onIncomingFrame is called for every inbound frame", async () => {
  const seenFrameSizes: number[] = [];
  const middleware: RpcServerMiddleware = {
    onIncomingFrame(frame, _ctx) {
      seenFrameSizes.push(frame.byteLength);
      return frame;
    },
  };

  const bridge = new RpcServerBridge({ middleware: [middleware] });
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(42),
  }, { capabilityIndex: 5 });

  const callFrame = encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  });

  await bridge.handleFrame(callFrame);
  assertEquals(seenFrameSizes.length, 1);
  assertEquals(seenFrameSizes[0], callFrame.byteLength);

  // Release and finish frames also go through onIncomingFrame.
  await bridge.handleFrame(
    encodeReleaseFrame({ id: 5, referenceCount: 1 }),
  );
  assertEquals(seenFrameSizes.length, 2);

  await bridge.handleFrame(encodeFinishFrame({ questionId: 1 }));
  assertEquals(seenFrameSizes.length, 3);
});

Deno.test("ServerMiddleware onIncomingFrame returning null drops the frame", async () => {
  let dispatchCalled = false;
  const middleware: RpcServerMiddleware = {
    onIncomingFrame(_frame, _ctx) {
      return null; // drop all frames
    },
  };

  const bridge = new RpcServerBridge({ middleware: [middleware] });
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => {
      dispatchCalled = true;
      return encodeSingleU32StructMessage(42);
    },
  }, { capabilityIndex: 5 });

  const result = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  assertEquals(result, null);
  assertEquals(dispatchCalled, false);
});

// --- onDispatch tests ---

Deno.test("ServerMiddleware onDispatch is called before handler with correct context", async () => {
  const seenContexts: ServerMiddlewareContext[] = [];
  const middleware: RpcServerMiddleware = {
    onDispatch(_method, params, ctx) {
      seenContexts.push({ ...ctx, state: new Map(ctx.state) });
      return params;
    },
  };

  const bridge = new RpcServerBridge({ middleware: [middleware] });
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(99),
  }, { capabilityIndex: 5 });

  const response = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 7,
    interfaceId: 0x1234n,
    methodId: 3,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(77),
  }));

  assert(response !== null, "expected response frame");
  assertEquals(decodeReturnFrame(response).kind, "results");

  assertEquals(seenContexts.length, 1);
  assertEquals(seenContexts[0].questionId, 7);
  assertEquals(seenContexts[0].interfaceId, 0x1234n);
  assertEquals(seenContexts[0].methodId, 3);
  assertEquals(seenContexts[0].capabilityIndex, 5);
});

Deno.test("ServerMiddleware onDispatch returning null skips handler and returns empty result", async () => {
  let dispatchCalled = false;
  const middleware: RpcServerMiddleware = {
    onDispatch(_method, _params, _ctx) {
      return null; // skip dispatch
    },
  };

  const bridge = new RpcServerBridge({ middleware: [middleware] });
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => {
      dispatchCalled = true;
      return encodeSingleU32StructMessage(42);
    },
  }, { capabilityIndex: 5 });

  const response = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  assert(response !== null, "expected response frame");
  assertEquals(decodeReturnFrame(response).kind, "results");
  assertEquals(dispatchCalled, false);
});

// --- onResponse tests ---

Deno.test("ServerMiddleware onResponse can inspect and transform response", async () => {
  const middleware: RpcServerMiddleware = {
    onResponse(result, _ctx) {
      // Transform the response content.
      return {
        ...result,
        content: encodeSingleU32StructMessage(999),
      };
    },
  };

  const bridge = new RpcServerBridge({ middleware: [middleware] });
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(42),
  }, { capabilityIndex: 5 });

  const response = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  assert(response !== null, "expected response frame");
  const decoded = decodeReturnFrame(response);
  assertEquals(decoded.kind, "results");
  if (decoded.kind === "results") {
    assertEquals(decodeSingleU32StructMessage(decoded.contentBytes), 999);
  }
});

// --- onError tests ---

Deno.test("ServerMiddleware onError is called when handler throws", async () => {
  const seenErrors: unknown[] = [];
  const middleware: RpcServerMiddleware = {
    onError(error, _ctx) {
      seenErrors.push(error);
    },
  };

  const bridge = new RpcServerBridge({ middleware: [middleware] });
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => {
      throw new Error("handler exploded");
    },
  }, { capabilityIndex: 5 });

  const response = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  assert(response !== null, "expected response frame");
  const decoded = decodeReturnFrame(response);
  assertEquals(decoded.kind, "exception");
  if (decoded.kind === "exception") {
    assert(
      /handler exploded/i.test(decoded.reason),
      `unexpected exception reason: ${decoded.reason}`,
    );
  }

  assertEquals(seenErrors.length, 1);
  assert(
    seenErrors[0] instanceof Error &&
      seenErrors[0].message === "handler exploded",
    `expected Error with message 'handler exploded', got: ${
      String(seenErrors[0])
    }`,
  );
});

Deno.test("ServerMiddleware onError failure does not mask original error", async () => {
  const middleware: RpcServerMiddleware = {
    onError(_error, _ctx) {
      throw new Error("onError itself exploded");
    },
  };

  const bridge = new RpcServerBridge({ middleware: [middleware] });
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => {
      throw new Error("original error");
    },
  }, { capabilityIndex: 5 });

  const response = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  assert(response !== null, "expected response frame");
  const decoded = decodeReturnFrame(response);
  assertEquals(decoded.kind, "exception");
  if (decoded.kind === "exception") {
    // The original error should be preserved, not the onError error.
    assert(
      /original error/i.test(decoded.reason),
      `expected original error reason, got: ${decoded.reason}`,
    );
  }
});

// --- Middleware ordering tests ---

Deno.test("ServerMiddleware onDispatch hooks execute in array order", async () => {
  const order: string[] = [];

  const mw1: RpcServerMiddleware = {
    onDispatch(_method, params, _ctx) {
      order.push("dispatch-1");
      return params;
    },
  };

  const mw2: RpcServerMiddleware = {
    onDispatch(_method, params, _ctx) {
      order.push("dispatch-2");
      return params;
    },
  };

  const mw3: RpcServerMiddleware = {
    onDispatch(_method, params, _ctx) {
      order.push("dispatch-3");
      return params;
    },
  };

  const bridge = new RpcServerBridge({ middleware: [mw1, mw2, mw3] });
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(1),
  }, { capabilityIndex: 5 });

  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  assertArrayEquals(order, ["dispatch-1", "dispatch-2", "dispatch-3"]);
});

Deno.test("ServerMiddleware onResponse hooks execute in forward order", async () => {
  const order: string[] = [];

  const mw1: RpcServerMiddleware = {
    onResponse(result, _ctx) {
      order.push("response-1");
      return result;
    },
  };

  const mw2: RpcServerMiddleware = {
    onResponse(result, _ctx) {
      order.push("response-2");
      return result;
    },
  };

  const mw3: RpcServerMiddleware = {
    onResponse(result, _ctx) {
      order.push("response-3");
      return result;
    },
  };

  const bridge = new RpcServerBridge({ middleware: [mw1, mw2, mw3] });
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(1),
  }, { capabilityIndex: 5 });

  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  assertArrayEquals(order, ["response-1", "response-2", "response-3"]);
});

Deno.test("ServerMiddleware onIncomingFrame hooks execute in array order and early null stops chain", async () => {
  const order: string[] = [];

  const mw1: RpcServerMiddleware = {
    onIncomingFrame(frame, _ctx) {
      order.push("frame-1");
      return frame;
    },
  };

  const mw2: RpcServerMiddleware = {
    onIncomingFrame(_frame, _ctx) {
      order.push("frame-2");
      return null; // drop the frame
    },
  };

  const mw3: RpcServerMiddleware = {
    onIncomingFrame(frame, _ctx) {
      order.push("frame-3");
      return frame;
    },
  };

  const bridge = new RpcServerBridge({ middleware: [mw1, mw2, mw3] });
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(1),
  }, { capabilityIndex: 5 });

  const result = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  assertEquals(result, null);
  // mw3 should NOT have been called because mw2 returned null.
  assertArrayEquals(order, ["frame-1", "frame-2"]);
});

Deno.test("ServerMiddleware onDispatch early null stops chain and skips later middleware", async () => {
  const order: string[] = [];

  const mw1: RpcServerMiddleware = {
    onDispatch(_method, params, _ctx) {
      order.push("dispatch-1");
      return params;
    },
  };

  const mw2: RpcServerMiddleware = {
    onDispatch(_method, _params, _ctx) {
      order.push("dispatch-2");
      return null; // skip dispatch
    },
  };

  const mw3: RpcServerMiddleware = {
    onDispatch(_method, params, _ctx) {
      order.push("dispatch-3");
      return params;
    },
  };

  const bridge = new RpcServerBridge({ middleware: [mw1, mw2, mw3] });
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(1),
  }, { capabilityIndex: 5 });

  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  assertArrayEquals(order, ["dispatch-1", "dispatch-2"]);
});

// --- Middleware state sharing tests ---

Deno.test("ServerMiddleware state map is shared across hooks within a single request", async () => {
  let stateInResponse: Map<string, unknown> | undefined;

  const middleware: RpcServerMiddleware = {
    onIncomingFrame(frame, ctx) {
      ctx.state.set("from-frame", "hello");
      return frame;
    },
    onDispatch(_method, params, ctx) {
      ctx.state.set("from-dispatch", 42);
      return params;
    },
    onResponse(result, ctx) {
      stateInResponse = new Map(ctx.state);
      return result;
    },
  };

  const bridge = new RpcServerBridge({ middleware: [middleware] });
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(1),
  }, { capabilityIndex: 5 });

  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  assert(stateInResponse !== undefined, "expected state in response");
  assertEquals(stateInResponse!.get("from-frame"), "hello");
  assertEquals(stateInResponse!.get("from-dispatch"), 42);
});

// --- Multiple middleware with all hooks ---

Deno.test("ServerMiddleware full lifecycle ordering across multiple middleware", async () => {
  const events: string[] = [];

  const mw1: RpcServerMiddleware = {
    onIncomingFrame(frame, _ctx) {
      events.push("mw1:frame");
      return frame;
    },
    onDispatch(_method, params, _ctx) {
      events.push("mw1:dispatch");
      return params;
    },
    onResponse(result, _ctx) {
      events.push("mw1:response");
      return result;
    },
  };

  const mw2: RpcServerMiddleware = {
    onIncomingFrame(frame, _ctx) {
      events.push("mw2:frame");
      return frame;
    },
    onDispatch(_method, params, _ctx) {
      events.push("mw2:dispatch");
      return params;
    },
    onResponse(result, _ctx) {
      events.push("mw2:response");
      return result;
    },
  };

  const bridge = new RpcServerBridge({ middleware: [mw1, mw2] });
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(1),
  }, { capabilityIndex: 5 });

  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  assertArrayEquals(events, [
    "mw1:frame",
    "mw2:frame",
    "mw1:dispatch",
    "mw2:dispatch",
    // onResponse is in forward order (matching all other hooks)
    "mw1:response",
    "mw2:response",
  ]);
});

Deno.test("ServerMiddleware onError hooks all execute in array order", async () => {
  const order: string[] = [];

  const mw1: RpcServerMiddleware = {
    onError(_error, _ctx) {
      order.push("error-1");
    },
  };

  const mw2: RpcServerMiddleware = {
    onError(_error, _ctx) {
      order.push("error-2");
    },
  };

  const bridge = new RpcServerBridge({ middleware: [mw1, mw2] });
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => {
      throw new Error("boom");
    },
  }, { capabilityIndex: 5 });

  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  assertArrayEquals(order, ["error-1", "error-2"]);
});

// --- No middleware (backward compatibility) ---

Deno.test("ServerMiddleware bridge works normally with no middleware configured", async () => {
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => encodeSingleU32StructMessage(42),
  }, { capabilityIndex: 5 });

  const response = await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  assert(response !== null, "expected response frame");
  const decoded = decodeReturnFrame(response);
  assertEquals(decoded.kind, "results");
  if (decoded.kind === "results") {
    assertEquals(decodeSingleU32StructMessage(decoded.contentBytes), 42);
  }
});

// --- Async middleware ---

Deno.test("ServerMiddleware async hooks are properly awaited", async () => {
  const events: string[] = [];

  const middleware: RpcServerMiddleware = {
    async onDispatch(_method, params, _ctx) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push("async-dispatch");
      return params;
    },
    async onResponse(result, _ctx) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push("async-response");
      return result;
    },
  };

  const bridge = new RpcServerBridge({ middleware: [middleware] });
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => {
      events.push("handler");
      return encodeSingleU32StructMessage(42);
    },
  }, { capabilityIndex: 5 });

  await bridge.handleFrame(encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(0),
  }));

  assertArrayEquals(events, ["async-dispatch", "handler", "async-response"]);
});
