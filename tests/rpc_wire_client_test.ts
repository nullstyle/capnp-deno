import {
  decodeBootstrapRequestFrame,
  decodeCallRequestFrame,
  decodeFinishFrame,
  decodeReturnFrame,
  EMPTY_STRUCT_MESSAGE,
  encodeBootstrapResponseFrame,
  encodeCallRequestFrame,
  encodeReleaseFrame,
  encodeReturnResultsFrame,
  ProtocolError,
  type RpcTransport,
  RpcWireClient,
  SessionError,
} from "../src/advanced.ts";
import {
  assert,
  assertBytes,
  assertEquals,
  deferred,
  withTimeout,
} from "./test_utils.ts";

class MockTransport implements RpcTransport {
  #onFrame: ((frame: Uint8Array) => void | Promise<void>) | null = null;
  #closed = false;
  readonly sent: Uint8Array[] = [];

  start(
    onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): void {
    if (this.#closed) throw new Error("transport closed");
    this.#onFrame = onFrame;
  }

  send(frame: Uint8Array): void {
    if (this.#closed) throw new Error("transport closed");
    this.sent.push(new Uint8Array(frame));
  }

  close(): void {
    this.#closed = true;
  }

  async emitInbound(frame: Uint8Array): Promise<void> {
    if (!this.#onFrame) throw new Error("transport not started");
    await this.#onFrame(frame);
  }
}

Deno.test("RpcWireClient unsubscribes after synchronous terminal replay", async () => {
  let subscriptions = 0;
  const transport: RpcTransport = {
    start() {
      throw new Error("must not start closed transport");
    },
    send() {
      throw new Error("must not send on closed transport");
    },
    close() {},
    subscribeClose(onClose) {
      subscriptions++;
      onClose();
      return () => {
        subscriptions--;
      };
    },
  };
  const client = new RpcWireClient(transport);
  const [result] = await Promise.allSettled([client.bootstrap()]);
  assert(result.status === "rejected" && result.reason instanceof SessionError);
  assertEquals(client.stats.closed, true);
  assertEquals(subscriptions, 0);
  await client.close();
});

Deno.test("RpcWireClient removes close subscription when start throws", () => {
  let subscriptions = 0;
  const failure = new Error("start failed synchronously");
  const transport: RpcTransport = {
    start() {
      throw failure;
    },
    send() {},
    close() {},
    subscribeClose() {
      subscriptions++;
      return () => {
        subscriptions--;
      };
    },
  };
  let actual: unknown;
  try {
    new RpcWireClient(transport);
  } catch (error) {
    actual = error;
  }
  assertEquals(actual, failure);
  assertEquals(subscriptions, 0);
});

Deno.test("RpcWireClient rejects closure while transport start is pending", async () => {
  const releaseStart = deferred<void>();
  let onClose: (() => void | Promise<void>) | undefined;
  const transport: RpcTransport = {
    start: () => releaseStart.promise,
    send() {
      throw new Error("closed transport must not send");
    },
    close() {},
    subscribeClose(callback) {
      onClose = callback;
      return () => {};
    },
  };
  const client = new RpcWireClient(transport);
  const result = Promise.allSettled([client.bootstrap()]);
  try {
    await onClose?.();
    const [settled] = await withTimeout(
      result,
      1000,
      "closure rejects before start cleanup",
    );
    assert(
      settled.status === "rejected" && settled.reason instanceof SessionError,
    );
  } finally {
    releaseStart.resolve();
    await client.close();
    await result;
  }
});

Deno.test("RpcWireClient does not send after closure during request registration", async () => {
  let onClose: (() => void | Promise<void>) | undefined;
  let sent = 0;
  const transport: RpcTransport = {
    start() {},
    send() {
      sent++;
    },
    close() {},
    subscribeClose(callback) {
      onClose = callback;
      return () => {};
    },
  };
  const client = new RpcWireClient(transport);
  const [result] = await Promise.allSettled([client.bootstrap({
    onQuestionId() {
      queueMicrotask(() => {
        void onClose?.();
      });
    },
  })]);
  assert(result.status === "rejected" && result.reason instanceof SessionError);
  assertEquals(sent, 0);
  assertEquals(client.pendingReturnCount, 0);
  await client.close();
});

Deno.test("RpcWireClient settles closure while send is pending and unsubscribe throws", async () => {
  const sent = deferred<void>();
  const releaseSend = deferred<void>();
  let notifyClose: (() => void | Promise<void>) | undefined;
  const transport: RpcTransport = {
    start() {},
    send() {
      sent.resolve();
      return releaseSend.promise;
    },
    close() {},
    subscribeClose(onClose) {
      notifyClose = onClose;
      return () => {
        throw new Error("observer cleanup failed");
      };
    },
  };
  const client = new RpcWireClient(transport);
  const result = Promise.allSettled([client.bootstrap()]);
  try {
    await sent.promise;
    assertEquals(client.pendingReturnCount, 1);
    await notifyClose?.();
    const [settled] = await withTimeout(
      result,
      1000,
      "closure settles before send cleanup",
    );
    assert(
      settled.status === "rejected" && settled.reason instanceof SessionError,
    );
    assertEquals(client.pendingReturnCount, 0);
    assertEquals(client.stats.closed, true);
  } finally {
    releaseSend.resolve();
    await client.close();
    // A broken unsubscribe must not leave this test waiting during red runs.
  }
});

Deno.test("RpcWireClient sends early Finish when abort follows the transport write", async () => {
  const abort = new AbortController();
  class AbortingTransport extends MockTransport {
    override async send(frame: Uint8Array): Promise<void> {
      await super.send(frame);
      if (this.sent.length === 1) abort.abort();
    }
  }
  const transport = new AbortingTransport();
  const client = new RpcWireClient(transport, { interfaceId: 1n });
  try {
    const [result] = await Promise.allSettled([client.call(
      { capabilityIndex: 1 },
      0,
      EMPTY_STRUCT_MESSAGE,
      { signal: abort.signal },
    )]);
    assert(
      result.status === "rejected" && result.reason instanceof SessionError,
    );
    assertEquals(
      transport.sent.length,
      2,
      "a written, canceled Call needs Finish",
    );
    const call = decodeCallRequestFrame(transport.sent[0]);
    const finish = decodeFinishFrame(transport.sent[1]);
    assertEquals(finish.questionId, call.questionId);
    assertEquals(finish.requireEarlyCancellation, true);
    assertEquals(client.pendingReturnCount, 0);
  } finally {
    await client.close();
  }
});

async function waitForSentFrames(
  transport: MockTransport,
  count: number,
): Promise<void> {
  await withTimeout(
    (async () => {
      while (transport.sent.length < count) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })(),
    200,
    `await ${count} outbound frame(s)`,
  );
}

Deno.test("RpcWireClient bootstrap auto-finishes with releaseResultCaps=false", async () => {
  const transport = new MockTransport();
  const client = new RpcWireClient(transport);

  const bootstrapPromise = client.bootstrap();
  await waitForSentFrames(transport, 1);
  const req = decodeBootstrapRequestFrame(transport.sent[0]);
  assertEquals(req.questionId, 1);

  await transport.emitInbound(encodeBootstrapResponseFrame({
    answerId: 1,
    capabilityIndex: 7,
  }));
  const capability = await bootstrapPromise;
  assertEquals(capability.capabilityIndex, 7);

  await waitForSentFrames(transport, 2);
  const finish = decodeFinishFrame(transport.sent[1]);
  assertEquals(finish.questionId, 1);
  assertEquals(finish.releaseResultCaps, false);

  await client.close();
});

Deno.test("RpcWireClient callRaw uses default interfaceId and params cap table", async () => {
  const transport = new MockTransport();
  const client = new RpcWireClient(transport, {
    interfaceId: 0x1234n,
  });
  assertEquals(client.stats.closed, false);
  assertEquals(client.stats.pendingReturns, 0);
  assertEquals(client.stats.exportedCapabilities, 0);
  assertEquals(client.stats.nextQuestionId, 1);
  assertEquals(client.stats.defaultTimeoutMs, null);

  let seenQuestionId = -1;
  const callPromise = client.callRaw(
    { capabilityIndex: 9 },
    5,
    new Uint8Array(EMPTY_STRUCT_MESSAGE),
    {
      onQuestionId: (id) => {
        seenQuestionId = id;
      },
      paramsCapTable: [{ tag: 1, id: 4 }],
    },
  );

  await waitForSentFrames(transport, 1);
  assertEquals(client.stats.pendingReturns, 1);
  assertEquals(client.stats.nextQuestionId, 2);
  const call = decodeCallRequestFrame(transport.sent[0]);
  assertEquals(seenQuestionId, 1);
  assertEquals(call.questionId, 1);
  assertEquals(call.interfaceId, 0x1234n);
  assertEquals(call.methodId, 5);
  assertEquals(call.target.tag, 0);
  if (call.target.tag === 0) {
    assertEquals(call.target.importedCap, 9);
  }
  assertBytes(call.paramsContent, [...EMPTY_STRUCT_MESSAGE]);
  assertEquals(call.paramsCapTable.length, 1);
  assertEquals(call.paramsCapTable[0].tag, 1);
  assertEquals(call.paramsCapTable[0].id, 4);

  await transport.emitInbound(encodeReturnResultsFrame({
    answerId: 1,
    content: new Uint8Array(EMPTY_STRUCT_MESSAGE),
    capTable: [{ tag: 1, id: 8 }],
  }));
  const result = await callPromise;
  assertBytes(result.contentBytes, [...EMPTY_STRUCT_MESSAGE]);
  assertEquals(result.capTable.length, 1);
  assertEquals(result.capTable[0].tag, 1);
  assertEquals(result.capTable[0].id, 8);
  assertEquals(transport.sent.length, 1);
  assertEquals(client.stats.pendingReturns, 0);

  await client.close();
  assertEquals(client.stats.closed, true);
});

Deno.test("RpcWireClient finish retains result caps by default when the Return carried capabilities", async () => {
  const transport = new MockTransport();
  const client = new RpcWireClient(transport, { interfaceId: 0x1234n });

  const callPromise = client.callRaw(
    { capabilityIndex: 0 },
    1,
    new Uint8Array(EMPTY_STRUCT_MESSAGE),
  );
  await waitForSentFrames(transport, 1);
  await transport.emitInbound(encodeReturnResultsFrame({
    answerId: 1,
    content: new Uint8Array(EMPTY_STRUCT_MESSAGE),
    capTable: [{ tag: 1, id: 3 }],
  }));
  await callPromise;

  // The generated-stub pattern: an explicit finish with no options after a
  // Return that imported a fresh capability. The wire reference must be
  // retained so the caller's stub stays alive.
  await client.finish(1);
  await waitForSentFrames(transport, 2);
  const finish = decodeFinishFrame(transport.sent[1]);
  assertEquals(finish.questionId, 1);
  assertEquals(finish.releaseResultCaps, false);

  await client.close();
});

Deno.test("RpcWireClient finish releases result caps for cap-free returns and honors explicit options", async () => {
  const transport = new MockTransport();
  const client = new RpcWireClient(transport, { interfaceId: 0x1234n });

  // Question 1: cap-free Return -> default finish releases.
  const capFree = client.callRaw(
    { capabilityIndex: 0 },
    1,
    new Uint8Array(EMPTY_STRUCT_MESSAGE),
  );
  await waitForSentFrames(transport, 1);
  await transport.emitInbound(encodeReturnResultsFrame({
    answerId: 1,
    content: new Uint8Array(EMPTY_STRUCT_MESSAGE),
  }));
  await capFree;
  await client.finish(1);
  await waitForSentFrames(transport, 2);
  assertEquals(decodeFinishFrame(transport.sent[1]).releaseResultCaps, true);

  // Question 2: cap-bearing Return, but the caller explicitly releases.
  const capBearing = client.callRaw(
    { capabilityIndex: 0 },
    1,
    new Uint8Array(EMPTY_STRUCT_MESSAGE),
  );
  await waitForSentFrames(transport, 3);
  await transport.emitInbound(encodeReturnResultsFrame({
    answerId: 2,
    content: new Uint8Array(EMPTY_STRUCT_MESSAGE),
    capTable: [{ tag: 1, id: 5 }],
  }));
  await capBearing;
  await client.finish(2, { releaseResultCaps: true });
  await waitForSentFrames(transport, 4);
  assertEquals(decodeFinishFrame(transport.sent[3]).releaseResultCaps, true);

  // Question 3: cap-bearing Return again; a second finish for the same
  // question falls back to the release default once the tracked entry is
  // consumed.
  const again = client.callRaw(
    { capabilityIndex: 0 },
    1,
    new Uint8Array(EMPTY_STRUCT_MESSAGE),
  );
  await waitForSentFrames(transport, 5);
  await transport.emitInbound(encodeReturnResultsFrame({
    answerId: 3,
    content: new Uint8Array(EMPTY_STRUCT_MESSAGE),
    capTable: [{ tag: 1, id: 6 }],
  }));
  await again;
  await client.finish(3);
  await client.finish(3);
  await waitForSentFrames(transport, 7);
  assertEquals(decodeFinishFrame(transport.sent[5]).releaseResultCaps, false);
  assertEquals(decodeFinishFrame(transport.sent[6]).releaseResultCaps, true);

  await client.close();
});

Deno.test("RpcWireClient sends early-cancel finish when a pending call aborts", async () => {
  const transport = new MockTransport();
  const client = new RpcWireClient(transport, {
    interfaceId: 0x1234n,
  });
  const controller = new AbortController();

  const pending = client.callRaw(
    { capabilityIndex: 9 },
    5,
    new Uint8Array(EMPTY_STRUCT_MESSAGE),
    { signal: controller.signal },
  );

  await waitForSentFrames(transport, 1);
  const call = decodeCallRequestFrame(transport.sent[0]);
  assertEquals(call.questionId, 1);

  controller.abort("stop streaming");

  let thrown: unknown;
  try {
    await pending;
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof SessionError &&
      /rpc wait aborted/i.test(thrown.message),
    `expected abort SessionError, got: ${String(thrown)}`,
  );
  await waitForSentFrames(transport, 2);
  const finish = decodeFinishFrame(transport.sent[1]);
  assertEquals(finish.questionId, 1);
  assertEquals(finish.requireEarlyCancellation, true);

  await client.close();
});

Deno.test("RpcWireClient callRaw requires interfaceId when no default exists", async () => {
  const transport = new MockTransport();
  const client = new RpcWireClient(transport);

  let thrown: unknown;
  try {
    await client.callRaw({ capabilityIndex: 1 }, 0, new Uint8Array());
  } catch (error) {
    thrown = error;
  } finally {
    await client.close();
  }

  assert(
    thrown instanceof ProtocolError &&
      /interfaceId is required for rpc wire client calls/i.test(thrown.message),
    `expected interfaceId-required ProtocolError, got: ${String(thrown)}`,
  );
});

Deno.test("RpcWireClient close rejects pending waits", async () => {
  const transport = new MockTransport();
  const client = new RpcWireClient(transport, {
    interfaceId: 0x55n,
  });

  const pending = client.callRaw(
    { capabilityIndex: 2 },
    0,
    new Uint8Array(EMPTY_STRUCT_MESSAGE),
  );

  await waitForSentFrames(transport, 1);
  assertEquals(client.pendingReturnCount, 1);
  assertEquals(client.stats.pendingReturns, 1);

  await client.close();
  assertEquals(client.pendingReturnCount, 0);
  assertEquals(client.stats.closed, true);
  assertEquals(client.stats.pendingReturns, 0);
  assertEquals(client.stats.exportedCapabilities, 0);
  assertEquals(client.stats.nextQuestionId, 2);
  assertEquals(client.stats.defaultTimeoutMs, null);

  let thrown: unknown;
  try {
    await pending;
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof SessionError &&
      /rpc wire client is closed/i.test(thrown.message),
    `expected close rejection SessionError, got: ${String(thrown)}`,
  );
});

Deno.test("RpcWireClient can export a local capability and serve inbound callback calls", async () => {
  const transport = new MockTransport();
  const client = new RpcWireClient(transport);

  assertEquals(client.exportedCapabilityCount, 0);
  assertEquals(client.stats.exportedCapabilities, 0);
  const exported = client.exportCapability({
    interfaceId: 0x9000n,
    dispatch(methodId, params) {
      assertEquals(methodId, 7);
      assertBytes(params, [...EMPTY_STRUCT_MESSAGE]);
      return new Uint8Array(EMPTY_STRUCT_MESSAGE);
    },
  }, { capabilityIndex: 33, referenceCount: 2 });
  assertEquals(exported.capabilityIndex, 33);
  assertEquals(client.exportedCapabilityCount, 1);
  assertEquals(client.stats.exportedCapabilities, 1);

  await transport.emitInbound(encodeCallRequestFrame({
    questionId: 11,
    target: { tag: 0, importedCap: 33 },
    interfaceId: 0x9000n,
    methodId: 7,
    paramsContent: new Uint8Array(EMPTY_STRUCT_MESSAGE),
  }));

  await waitForSentFrames(transport, 1);
  const response = decodeReturnFrame(transport.sent[0]);
  assertEquals(response.answerId, 11);
  assertEquals(response.kind, "results");
  if (response.kind === "results") {
    assertBytes(response.contentBytes, [...EMPTY_STRUCT_MESSAGE]);
  }

  // Release both references and verify subsequent callback call fails.
  await transport.emitInbound(encodeReleaseFrame({
    id: 33,
    referenceCount: 2,
  }));
  await transport.emitInbound(encodeCallRequestFrame({
    questionId: 12,
    target: { tag: 0, importedCap: 33 },
    interfaceId: 0x9000n,
    methodId: 7,
    paramsContent: new Uint8Array(EMPTY_STRUCT_MESSAGE),
  }));

  await waitForSentFrames(transport, 2);
  const releasedResponse = decodeReturnFrame(transport.sent[1]);
  assertEquals(releasedResponse.answerId, 12);
  assertEquals(releasedResponse.kind, "exception");
  assertEquals(client.exportedCapabilityCount, 0);
  assertEquals(client.stats.exportedCapabilities, 0);

  await client.close();
  assertEquals(client.exportedCapabilityCount, 0);
  assertEquals(client.stats.closed, true);
});

Deno.test("RpcWireClient rejects local exports after close", async () => {
  const transport = new MockTransport();
  const client = new RpcWireClient(transport);

  await client.close();

  let thrown: unknown;
  try {
    client.exportCapability({
      interfaceId: 0x9000n,
      dispatch: () => new Uint8Array(EMPTY_STRUCT_MESSAGE),
    });
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof SessionError &&
      /rpc wire client is closed/i.test(thrown.message),
    `expected closed SessionError, got: ${String(thrown)}`,
  );
});

Deno.test("RpcWireClient callRaw send failures do not leak waiter rejections", async () => {
  const transport = new MockTransport();
  const client = new RpcWireClient(transport, {
    interfaceId: 0x55n,
  });

  // Force send() to fail after the pending waiter has been created.
  transport.close();

  let thrown: unknown;
  try {
    await client.callRaw(
      { capabilityIndex: 2 },
      1,
      new Uint8Array(EMPTY_STRUCT_MESSAGE),
      { timeoutMs: 50 },
    );
  } catch (error) {
    thrown = error;
  } finally {
    await client.close();
  }

  assert(
    thrown instanceof Error && /closed/i.test(thrown.message),
    `expected closed transport error, got: ${String(thrown)}`,
  );
});
