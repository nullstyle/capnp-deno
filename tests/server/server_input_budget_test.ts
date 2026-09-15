import {
  decodeReturnFrame,
  EMPTY_STRUCT_MESSAGE,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  RPC_CALL_TARGET_TAG_PROMISED_ANSWER,
  RpcServerBridge,
  type RpcServerWasmHost,
} from "../../src/advanced.ts";
import { assert, assertEquals, deferred, withTimeout } from "../test_utils.ts";

function callFrame(questionId: number): Uint8Array {
  return encodeCallRequestFrame({
    questionId,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 1,
    paramsContent: EMPTY_STRUCT_MESSAGE,
  });
}

Deno.test("server input budget rejects excess calls while still processing Finish and Release", async () => {
  const firstFrame = callFrame(1);
  const bridge = new RpcServerBridge({
    maxRetainedInputFrameBytes: firstFrame.byteLength,
  });
  const started = deferred<void>();
  const release = deferred<void>();
  let aborted = false;
  bridge.exportCapability({
    interfaceId: 0x1234n,
    async dispatch(_method, _params, ctx) {
      ctx.signal.addEventListener("abort", () => aborted = true, {
        once: true,
      });
      started.resolve();
      await release.promise;
      return EMPTY_STRUCT_MESSAGE;
    },
  }, { capabilityIndex: 1 });
  const first = bridge.handleFrame(firstFrame);
  await started.promise;
  const refused = await bridge.handleFrame(callFrame(2));
  assert(refused !== null);
  const error = decodeReturnFrame(refused);
  assert(
    error.kind === "exception" && /input frame byte budget/.test(error.reason),
  );
  assertEquals(bridge.stats.retainedInputFrameBytes, firstFrame.byteLength);
  assertEquals(bridge.stats.rejectedInputFrames, 1);
  await bridge.handleFrame(
    encodeFinishFrame({ questionId: 1, requireEarlyCancellation: true }),
  );
  await bridge.handleFrame(encodeReleaseFrame({ id: 1, referenceCount: 1 }));
  assertEquals(aborted, true);
  assertEquals(bridge.stats.exportedCapabilities, 0);
  // A handler that has not returned can still retain its input after Finish.
  assertEquals(bridge.stats.retainedInputFrameBytes, firstFrame.byteLength);
  release.resolve();
  assertEquals(await first, null);
  assertEquals(bridge.stats.retainedInputFrameBytes, 0);
});

Deno.test("server input budget recovers after exceptions and rejects invalid limits", async () => {
  const frame = callFrame(1);
  const bridge = new RpcServerBridge({
    maxRetainedInputFrameBytes: frame.byteLength,
  });
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch() {
      throw new Error("handler failed");
    },
  }, { capabilityIndex: 1 });
  for (const id of [1, 2]) {
    const result = await bridge.handleFrame(callFrame(id));
    assert(result !== null && decodeReturnFrame(result).kind === "exception");
    assertEquals(bridge.stats.retainedInputFrameBytes, 0);
  }
  assertEquals(bridge.stats.rejectedInputFrames, 0);
  for (
    const maxRetainedInputFrameBytes of [
      0,
      -1,
      1.5,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]
  ) {
    let error: unknown;
    try {
      new RpcServerBridge({ maxRetainedInputFrameBytes });
    } catch (failure) {
      error = failure;
    }
    assert(error instanceof Error);
  }
});

Deno.test("asynchronous WASM host calls share the server input budget", async () => {
  const frames = [callFrame(1), callFrame(2)];
  const release = deferred<void>();
  const settled = deferred<void>();
  const responses: Uint8Array[] = [];
  const bridge = new RpcServerBridge({
    maxRetainedInputFrameBytes: frames[0].byteLength,
  });
  bridge.exportCapability({
    interfaceId: 0x1234n,
    async dispatch() {
      await release.promise;
      return EMPTY_STRUCT_MESSAGE;
    },
  }, { capabilityIndex: 1 });
  bridge.setAsyncHostCallDispatch(true, () => settled.resolve());
  let next = 0;
  const host = {
    handle: 1,
    abi: {
      popHostCall() {
        const frame = frames[next];
        if (!frame) return null;
        return { questionId: ++next, frame };
      },
      respondHostCallReturnFrame(_peer: number, frame: Uint8Array) {
        responses.push(frame);
      },
    },
  } as unknown as RpcServerWasmHost;
  await bridge.pumpWasmHostCalls(host);
  assertEquals(responses.length, 1);
  const refused = decodeReturnFrame(responses[0]);
  assert(
    refused.kind === "exception" &&
      /input frame byte budget/.test(refused.reason),
  );
  assertEquals(bridge.stats.retainedInputFrameBytes, frames[0].byteLength);
  release.resolve();
  await withTimeout(settled.promise, 500, "host-call budget release");
  assertEquals(bridge.stats.retainedInputFrameBytes, 0);
});

Deno.test("server shutdown aborts pending work and releases input bytes after handlers settle", async () => {
  const frame = callFrame(1);
  const bridge = new RpcServerBridge({
    maxRetainedInputFrameBytes: frame.byteLength,
  });
  const started = deferred<void>();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    async dispatch(_method, _params, ctx) {
      const canceled = new Promise<void>((resolve) =>
        ctx.signal.addEventListener("abort", () => resolve(), { once: true })
      );
      started.resolve();
      await canceled;
      return EMPTY_STRUCT_MESSAGE;
    },
  }, { capabilityIndex: 1 });
  const pending = bridge.handleFrame(frame);
  await started.promise;
  bridge.close();
  assertEquals(await withTimeout(pending, 500, "shutdown input release"), null);
  bridge.close();
  assertEquals(bridge.stats.retainedInputFrameBytes, 0);
  assertEquals(bridge.stats.answerTableEntries, 0);
  assertEquals(bridge.stats.exportedCapabilities, 0);
});

Deno.test("canceled pipelined input releases without waiting for a stubborn parent handler", async () => {
  const frame = callFrame(1);
  const bridge = new RpcServerBridge({
    maxRetainedInputFrameBytes: frame.byteLength * 3,
  });
  const started = deferred<void>();
  const release = deferred<void>();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    async dispatch() {
      started.resolve();
      await release.promise;
      return EMPTY_STRUCT_MESSAGE;
    },
  }, { capabilityIndex: 1 });
  const parent = bridge.handleFrame(frame);
  await started.promise;
  const childFrame = encodeCallRequestFrame({
    questionId: 2,
    interfaceId: 0x1234n,
    methodId: 0,
    target: {
      tag: RPC_CALL_TARGET_TAG_PROMISED_ANSWER,
      promisedAnswer: { questionId: 1 },
    },
    paramsContent: EMPTY_STRUCT_MESSAGE,
  });
  const child = bridge.handleFrame(childFrame);
  try {
    assertEquals(
      bridge.stats.retainedInputFrameBytes,
      frame.byteLength + childFrame.byteLength,
    );
    await bridge.handleFrame(
      encodeFinishFrame({ questionId: 2, requireEarlyCancellation: true }),
    );
    assertEquals(
      await withTimeout(child, 200, "canceled pipeline input release"),
      null,
    );
    assertEquals(bridge.stats.retainedInputFrameBytes, frame.byteLength);
  } finally {
    release.resolve();
    await Promise.all([parent, child]);
    bridge.close();
  }
  assertEquals(bridge.stats.retainedInputFrameBytes, 0);
});
