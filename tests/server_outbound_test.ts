import {
  decodeCallRequestFrame,
  decodeFinishFrame,
  decodeReleaseFrame,
  encodeReturnExceptionFrame,
  encodeReturnResultsFrame,
  RpcServerCallInterceptTransport,
  RpcServerOutboundClient,
} from "../mod.ts";
import type { RpcTransport } from "../src/transport.ts";
import { assert, assertEquals } from "./test_utils.ts";

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------

class MockTransport implements RpcTransport {
  onFrame: ((frame: Uint8Array) => void | Promise<void>) | null = null;
  sentFrames: Uint8Array[] = [];
  closed = false;

  start(onFrame: (frame: Uint8Array) => void | Promise<void>): void {
    this.onFrame = onFrame;
  }

  send(frame: Uint8Array): void {
    this.sentFrames.push(frame);
  }

  close(): void {
    this.closed = true;
  }

  /** Simulate an inbound frame from the network. */
  async deliver(frame: Uint8Array): Promise<void> {
    if (!this.onFrame) throw new Error("not started");
    await this.onFrame(frame);
  }
}

/** Encode a minimal struct message (empty struct). */
function emptyStructMessage(): Uint8Array {
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0, true); // 1 segment
  view.setUint32(4, 1, true); // 1 word
  view.setBigUint64(8, 0n, true); // null struct pointer
  return out;
}

// ---------------------------------------------------------------------------
// RpcServerCallInterceptTransport tests
// ---------------------------------------------------------------------------

Deno.test("RpcServerCallInterceptTransport passes non-Return frames through", async () => {
  const mock = new MockTransport();
  const intercept = new RpcServerCallInterceptTransport(mock);
  const received: Uint8Array[] = [];

  await intercept.start((frame) => {
    received.push(frame);
  });

  // A non-Return frame (just some random bytes)
  const frame = new Uint8Array([1, 2, 3, 4]);
  await mock.deliver(frame);

  assertEquals(received.length, 1);
  assert(received[0] === frame);
});

Deno.test("RpcServerCallInterceptTransport intercepts matching Return frame", async () => {
  const mock = new MockTransport();
  const intercept = new RpcServerCallInterceptTransport(mock);
  const received: Uint8Array[] = [];

  await intercept.start((frame) => {
    received.push(frame);
  });

  const questionId = 42;
  const returnPromise = intercept.registerQuestion(questionId);

  const returnFrame = encodeReturnResultsFrame({
    answerId: questionId,
    content: emptyStructMessage(),
  });

  await mock.deliver(returnFrame);

  // Should NOT be forwarded to the session
  assertEquals(received.length, 0);

  // The registered promise should resolve
  const result = await returnPromise;
  assertEquals(result.answerId, questionId);
  assertEquals(result.kind, "results");
});

Deno.test("RpcServerCallInterceptTransport forwards non-matching Return frame", async () => {
  const mock = new MockTransport();
  const intercept = new RpcServerCallInterceptTransport(mock);
  const received: Uint8Array[] = [];

  await intercept.start((frame) => {
    received.push(frame);
  });

  // Register question 42 but deliver a Return for question 99
  intercept.registerQuestion(42);

  const returnFrame = encodeReturnResultsFrame({
    answerId: 99,
    content: emptyStructMessage(),
  });

  await mock.deliver(returnFrame);

  // Should be forwarded since it doesn't match our registered question
  assertEquals(received.length, 1);
});

Deno.test("RpcServerCallInterceptTransport.close rejects pending questions", async () => {
  const mock = new MockTransport();
  const intercept = new RpcServerCallInterceptTransport(mock);
  await intercept.start(() => {});

  const returnPromise = intercept.registerQuestion(42);

  await intercept.close();
  assert(mock.closed);

  let thrown = false;
  try {
    await returnPromise;
  } catch (error) {
    thrown = true;
    assert(error instanceof Error);
    assert(error.message.includes("closed"));
  }
  assert(thrown, "expected pending question to be rejected");
});

Deno.test("RpcServerCallInterceptTransport.unregisterQuestion cancels pending", async () => {
  const mock = new MockTransport();
  const intercept = new RpcServerCallInterceptTransport(mock);
  const received: Uint8Array[] = [];

  await intercept.start((frame) => {
    received.push(frame);
  });

  intercept.registerQuestion(42);
  intercept.unregisterQuestion(42);

  // Now deliver a Return for question 42 — should pass through
  const returnFrame = encodeReturnResultsFrame({
    answerId: 42,
    content: emptyStructMessage(),
  });

  await mock.deliver(returnFrame);
  assertEquals(received.length, 1);
});

Deno.test("RpcServerCallInterceptTransport.send delegates to inner transport", async () => {
  const mock = new MockTransport();
  const intercept = new RpcServerCallInterceptTransport(mock);

  const frame = new Uint8Array([1, 2, 3]);
  await intercept.send(frame);

  assertEquals(mock.sentFrames.length, 1);
  assert(mock.sentFrames[0] === frame);
});

Deno.test("RpcServerCallInterceptTransport.send throws when closed", async () => {
  const mock = new MockTransport();
  const intercept = new RpcServerCallInterceptTransport(mock);
  await intercept.close();

  let thrown = false;
  try {
    await intercept.send(new Uint8Array([1]));
  } catch (error) {
    thrown = true;
    assert(error instanceof Error);
    assert(error.message.includes("closed"));
  }
  assert(thrown);
});

Deno.test("RpcServerCallInterceptTransport registerQuestion with timeout rejects", async () => {
  const mock = new MockTransport();
  const intercept = new RpcServerCallInterceptTransport(mock);
  await intercept.start(() => {});

  const returnPromise = intercept.registerQuestion(42, 50);

  let thrown = false;
  try {
    await returnPromise;
  } catch (error) {
    thrown = true;
    assert(error instanceof Error);
    assert(error.message.includes("timed out"));
  }
  assert(thrown, "expected timeout rejection");
});

// ---------------------------------------------------------------------------
// RpcServerOutboundClient tests
// ---------------------------------------------------------------------------

Deno.test("RpcServerOutboundClient.callRaw sends call and receives result", async () => {
  const mock = new MockTransport();
  const intercept = new RpcServerCallInterceptTransport(mock);
  await intercept.start(() => {});

  const client = new RpcServerOutboundClient(intercept, 100);
  const content = emptyStructMessage();

  // Start the call (will register question and send frame)
  const resultPromise = client.callRaw(
    { capabilityIndex: 5 },
    0,
    emptyStructMessage(),
    { interfaceId: 0x1234n, autoFinish: false },
  );

  // Client should have sent a Call frame
  assertEquals(mock.sentFrames.length, 1);
  const callFrame = decodeCallRequestFrame(mock.sentFrames[0]);
  assertEquals(callFrame.questionId, 100);
  assertEquals(callFrame.interfaceId, 0x1234n);
  assertEquals(callFrame.methodId, 0);

  // Deliver the return frame
  const returnFrame = encodeReturnResultsFrame({
    answerId: 100,
    content,
    noFinishNeeded: true,
  });
  await mock.deliver(returnFrame);

  const result = await resultPromise;
  assertEquals(result.answerId, 100);
  assert(result.noFinishNeeded);
});

Deno.test("RpcServerOutboundClient.callRaw requires interfaceId", async () => {
  const mock = new MockTransport();
  const intercept = new RpcServerCallInterceptTransport(mock);
  await intercept.start(() => {});

  const client = new RpcServerOutboundClient(intercept, 100);

  let thrown = false;
  try {
    await client.callRaw(
      { capabilityIndex: 0 },
      0,
      emptyStructMessage(),
      {}, // no interfaceId
    );
  } catch (error) {
    thrown = true;
    assert(error instanceof Error);
    assert(error.message.includes("interfaceId"));
  }
  assert(thrown, "expected error for missing interfaceId");
});

Deno.test("RpcServerOutboundClient.callRaw throws on exception return", async () => {
  const mock = new MockTransport();
  const intercept = new RpcServerCallInterceptTransport(mock);
  await intercept.start(() => {});

  const client = new RpcServerOutboundClient(intercept, 100);

  const resultPromise = client.callRaw(
    { capabilityIndex: 0 },
    0,
    emptyStructMessage(),
    { interfaceId: 0x1234n, autoFinish: false },
  );

  const exFrame = encodeReturnExceptionFrame({
    answerId: 100,
    reason: "something went wrong",
  });
  await mock.deliver(exFrame);

  let thrown = false;
  try {
    await resultPromise;
  } catch (error) {
    thrown = true;
    assert(error instanceof Error);
    assert(error.message.includes("something went wrong"));
  }
  assert(thrown, "expected exception to be thrown");
});

Deno.test("RpcServerOutboundClient.call returns content bytes", async () => {
  const mock = new MockTransport();
  const intercept = new RpcServerCallInterceptTransport(mock);
  await intercept.start(() => {});

  const client = new RpcServerOutboundClient(intercept, 200);
  const content = emptyStructMessage();

  const resultPromise = client.call(
    { capabilityIndex: 1 },
    3,
    emptyStructMessage(),
    { interfaceId: 0xABCDn, autoFinish: false },
  );

  const returnFrame = encodeReturnResultsFrame({
    answerId: 200,
    content,
    noFinishNeeded: true,
  });
  await mock.deliver(returnFrame);

  const bytes = await resultPromise;
  assert(bytes instanceof Uint8Array);
  assert(bytes.length > 0);
});

Deno.test("RpcServerOutboundClient.callRaw auto-finishes by default", async () => {
  const mock = new MockTransport();
  const intercept = new RpcServerCallInterceptTransport(mock);
  await intercept.start(() => {});

  const client = new RpcServerOutboundClient(intercept, 300);
  const content = emptyStructMessage();

  const resultPromise = client.callRaw(
    { capabilityIndex: 0 },
    0,
    emptyStructMessage(),
    { interfaceId: 0x1234n }, // autoFinish defaults to true
  );

  const returnFrame = encodeReturnResultsFrame({
    answerId: 300,
    content,
    noFinishNeeded: false, // server expects finish
  });
  await mock.deliver(returnFrame);
  await resultPromise;

  // Should have sent: 1 Call frame + 1 Finish frame
  assertEquals(mock.sentFrames.length, 2);
  const finishFrame = decodeFinishFrame(mock.sentFrames[1]);
  assertEquals(finishFrame.questionId, 300);
});

Deno.test("RpcServerOutboundClient.callRaw skips finish when noFinishNeeded", async () => {
  const mock = new MockTransport();
  const intercept = new RpcServerCallInterceptTransport(mock);
  await intercept.start(() => {});

  const client = new RpcServerOutboundClient(intercept, 400);
  const content = emptyStructMessage();

  const resultPromise = client.callRaw(
    { capabilityIndex: 0 },
    0,
    emptyStructMessage(),
    { interfaceId: 0x1234n }, // autoFinish defaults to true
  );

  const returnFrame = encodeReturnResultsFrame({
    answerId: 400,
    content,
    noFinishNeeded: true, // server says no finish needed
  });
  await mock.deliver(returnFrame);
  await resultPromise;

  // Should have sent only the Call frame, no Finish
  assertEquals(mock.sentFrames.length, 1);
});

Deno.test("RpcServerOutboundClient.release sends Release frame", async () => {
  const mock = new MockTransport();
  const intercept = new RpcServerCallInterceptTransport(mock);
  await intercept.start(() => {});

  const client = new RpcServerOutboundClient(intercept);

  await client.release({ capabilityIndex: 7 }, 3);

  assertEquals(mock.sentFrames.length, 1);
  const release = decodeReleaseFrame(mock.sentFrames[0]);
  assertEquals(release.id, 7);
  assertEquals(release.referenceCount, 3);
});

Deno.test("RpcServerOutboundClient.finish sends Finish frame", async () => {
  const mock = new MockTransport();
  const intercept = new RpcServerCallInterceptTransport(mock);
  await intercept.start(() => {});

  const client = new RpcServerOutboundClient(intercept);

  await client.finish(42, { releaseResultCaps: false });

  assertEquals(mock.sentFrames.length, 1);
  const finish = decodeFinishFrame(mock.sentFrames[0]);
  assertEquals(finish.questionId, 42);
});

Deno.test("RpcServerOutboundClient increments question IDs", async () => {
  const mock = new MockTransport();
  const intercept = new RpcServerCallInterceptTransport(mock);
  await intercept.start(() => {});

  const client = new RpcServerOutboundClient(intercept, 500);
  const content = emptyStructMessage();

  // First call
  const p1 = client.callRaw(
    { capabilityIndex: 0 },
    0,
    emptyStructMessage(),
    { interfaceId: 0x1234n, autoFinish: false },
  );

  // Second call (before first resolves)
  const p2 = client.callRaw(
    { capabilityIndex: 0 },
    1,
    emptyStructMessage(),
    { interfaceId: 0x1234n, autoFinish: false },
  );

  // Resolve in order
  await mock.deliver(encodeReturnResultsFrame({
    answerId: 500,
    content,
    noFinishNeeded: true,
  }));
  await mock.deliver(encodeReturnResultsFrame({
    answerId: 501,
    content,
    noFinishNeeded: true,
  }));

  const r1 = await p1;
  const r2 = await p2;
  assertEquals(r1.answerId, 500);
  assertEquals(r2.answerId, 501);
});

Deno.test("RpcServerCallInterceptTransport intercepts exception Return", async () => {
  const mock = new MockTransport();
  const intercept = new RpcServerCallInterceptTransport(mock);
  const received: Uint8Array[] = [];

  await intercept.start((frame) => {
    received.push(frame);
  });

  const returnPromise = intercept.registerQuestion(42);

  const exFrame = encodeReturnExceptionFrame({
    answerId: 42,
    reason: "test error",
  });
  await mock.deliver(exFrame);

  assertEquals(received.length, 0);

  const result = await returnPromise;
  assertEquals(result.answerId, 42);
  assertEquals(result.kind, "exception");
  assert(result.kind === "exception" && result.reason.includes("test error"));
});
