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

  await client.close();

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

  const exported = client.exportCapability({
    interfaceId: 0x9000n,
    dispatch(methodId, params) {
      assertEquals(methodId, 7);
      assertBytes(params, [...EMPTY_STRUCT_MESSAGE]);
      return new Uint8Array(EMPTY_STRUCT_MESSAGE);
    },
  }, { capabilityIndex: 33, referenceCount: 2 });
  assertEquals(exported.capabilityIndex, 33);

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
