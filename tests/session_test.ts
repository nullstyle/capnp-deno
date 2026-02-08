import {
  CapnpError,
  type RpcObservabilityEvent,
  RpcSession,
  type RpcTransport,
  SessionError,
  WasmPeer,
} from "../mod.ts";
import { FakeCapnpWasm } from "./fake_wasm.ts";
import { assert, assertBytes, assertEquals } from "./test_utils.ts";

class MockTransport implements RpcTransport {
  private onFrame: ((frame: Uint8Array) => void | Promise<void>) | null = null;
  readonly sent: Uint8Array[] = [];
  started = false;
  closed = false;
  closeCalls = 0;
  throwOnStart: unknown = null;
  throwOnSend: unknown = null;
  throwOnClose: unknown = null;

  start(
    onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): void {
    if (this.throwOnStart !== null) {
      const error = this.throwOnStart;
      this.throwOnStart = null;
      throw error;
    }
    this.started = true;
    this.onFrame = onFrame;
  }

  send(frame: Uint8Array): void {
    if (this.throwOnSend !== null) throw this.throwOnSend;
    this.sent.push(new Uint8Array(frame));
  }

  close(): void {
    this.closeCalls += 1;
    this.closed = true;
    if (this.throwOnClose !== null) throw this.throwOnClose;
  }

  async emit(frame: Uint8Array): Promise<void> {
    if (!this.onFrame) {
      throw new Error("transport not started");
    }
    await this.onFrame(frame);
  }
}

Deno.test("RpcSession pumps inbound to transport and drains all outbound frames", async () => {
  const fake = new FakeCapnpWasm({
    onPushFrame: (
      frame,
    ) => [new Uint8Array([frame[0], 0x10]), new Uint8Array([frame[0], 0x20])],
  });
  using peer = WasmPeer.fromExports(fake.exports);
  const transport = new MockTransport();

  const session = new RpcSession(peer, transport);
  await session.start();
  await transport.emit(new Uint8Array([0x42]));
  await session.flush();

  assert(transport.started, "transport should be started");
  assertEquals(transport.sent.length, 2, "expected two outbound writes");
  assertBytes(transport.sent[0], [0x42, 0x10]);
  assertBytes(transport.sent[1], [0x42, 0x20]);
  assertEquals(fake.commitCalls.length, 2, "expected two pop commits");
});

Deno.test("RpcSession.close closes transport and peer", async () => {
  const fake = new FakeCapnpWasm();
  const peer = WasmPeer.fromExports(fake.exports);
  const transport = new MockTransport();
  const session = new RpcSession(peer, transport);

  await session.start();
  await session.close();
  await session.close();

  assert(transport.closed, "transport should be closed");
  assert(peer.closed, "peer should be closed");
});

Deno.test("RpcSession emits observability events", async () => {
  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => [new Uint8Array([frame[0], 0x99])],
  });
  using peer = WasmPeer.fromExports(fake.exports);
  const transport = new MockTransport();
  const events: RpcObservabilityEvent[] = [];

  const session = new RpcSession(peer, transport, {
    observability: {
      onEvent: (event) => events.push(event),
    },
  });
  await session.start();
  await transport.emit(new Uint8Array([0x33]));
  await session.flush();
  await session.close();

  const names = events.map((event) => event.name);
  assert(
    names.includes("rpc.session.start"),
    "expected rpc.session.start event",
  );
  assert(
    names.includes("rpc.session.inbound_frame"),
    "expected rpc.session.inbound_frame event",
  );
  assert(
    names.includes("rpc.session.close"),
    "expected rpc.session.close event",
  );
});

Deno.test("RpcSession rejects start after close and preserves state flags", async () => {
  const fake = new FakeCapnpWasm();
  const peer = WasmPeer.fromExports(fake.exports);
  const transport = new MockTransport();
  const session = new RpcSession(peer, transport);

  assertEquals(session.started, false);
  assertEquals(session.closed, false);

  await session.close();
  assertEquals(session.closed, true);

  let thrown: unknown;
  try {
    await session.start();
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof SessionError &&
      /RpcSession is closed/i.test(thrown.message),
    `expected closed SessionError, got: ${String(thrown)}`,
  );
});

Deno.test("RpcSession can retry start after an initial start failure", async () => {
  const fake = new FakeCapnpWasm();
  const peer = WasmPeer.fromExports(fake.exports);
  const transport = new MockTransport();
  transport.throwOnStart = new Error("start failed once");
  const session = new RpcSession(peer, transport);

  let firstError: unknown;
  try {
    await session.start();
  } catch (error) {
    firstError = error;
  }

  assert(
    firstError instanceof SessionError &&
      /rpc session start failed/i.test(firstError.message),
    `expected normalized start failure, got: ${String(firstError)}`,
  );
  assertEquals(session.started, false);
  assertEquals(transport.started, false);

  await session.start();
  assertEquals(session.started, true);
  assertEquals(transport.started, true);

  await session.close();
});

Deno.test("RpcSession pumpInboundFrame normalizes transport send failures", async () => {
  const fake = new FakeCapnpWasm({
    onPushFrame: (_frame) => [new Uint8Array([0xaa])],
  });
  const peer = WasmPeer.fromExports(fake.exports);
  const transport = new MockTransport();
  transport.throwOnSend = "send exploded";
  const session = new RpcSession(peer, transport);

  try {
    await session.start();

    let thrown: unknown;
    try {
      await session.pumpInboundFrame(new Uint8Array([0x01]));
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof SessionError &&
        /rpc session inbound frame failed/i.test(thrown.message) &&
        /send exploded/i.test(thrown.message),
      `expected normalized inbound failure, got: ${String(thrown)}`,
    );
  } finally {
    await session.close();
  }
});

Deno.test("RpcSession close swallows flush failures and still closes transport and peer", async () => {
  const fake = new FakeCapnpWasm({
    onPushFrame: (_frame) => [new Uint8Array([0xbb])],
  });
  const peer = WasmPeer.fromExports(fake.exports);
  const transport = new MockTransport();
  transport.throwOnSend = "send failed";
  const session = new RpcSession(peer, transport);

  await session.start();

  let inboundError: unknown;
  try {
    await transport.emit(new Uint8Array([0x10]));
  } catch (error) {
    inboundError = error;
  }
  assert(
    inboundError instanceof SessionError,
    `expected inbound SessionError, got: ${String(inboundError)}`,
  );

  await session.close();
  assertEquals(transport.closed, true);
  assertEquals(transport.closeCalls, 1);
  assertEquals(peer.closed, true);
});

Deno.test("RpcSession routes inbound failures through onError callback", async () => {
  const fake = new FakeCapnpWasm({
    onPushFrame: (_frame) => [new Uint8Array([0xcc])],
  });
  const peer = WasmPeer.fromExports(fake.exports);
  const transport = new MockTransport();
  transport.throwOnSend = "send failed";
  const seenErrors: unknown[] = [];
  const session = new RpcSession(peer, transport, {
    onError: (error) => {
      seenErrors.push(error);
    },
  });

  try {
    await session.start();
    await transport.emit(new Uint8Array([0x33]));
    await session.flush();
    assertEquals(seenErrors.length, 1);
    assert(
      seenErrors[0] instanceof SessionError,
      `expected SessionError callback argument, got: ${String(seenErrors[0])}`,
    );
  } finally {
    await session.close();
  }
});

Deno.test("RpcSession propagates onError callback failures", async () => {
  const fake = new FakeCapnpWasm({
    onPushFrame: (_frame) => [new Uint8Array([0xdd])],
  });
  const peer = WasmPeer.fromExports(fake.exports);
  const transport = new MockTransport();
  transport.throwOnSend = "send failed";
  const session = new RpcSession(peer, transport, {
    onError: () => {
      throw new Error("onError handler failed");
    },
  });

  try {
    await session.start();
    let thrown: unknown;
    try {
      await transport.emit(new Uint8Array([0x55]));
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof Error && /onError handler failed/i.test(thrown.message),
      `expected onError handler failure, got: ${String(thrown)}`,
    );
  } finally {
    await session.close();
  }
});

Deno.test("RpcSession closes peer even when transport close fails", async () => {
  const fake = new FakeCapnpWasm();
  const peer = WasmPeer.fromExports(fake.exports);
  const transport = new MockTransport();
  transport.throwOnClose = new Error("transport close failed");
  const session = new RpcSession(peer, transport);

  await session.start();

  let thrown: unknown;
  try {
    await session.close();
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof Error && /transport close failed/i.test(thrown.message),
    `expected transport close error, got: ${String(thrown)}`,
  );
  assertEquals(peer.closed, true);
  assertEquals(transport.closeCalls, 1);
  assertEquals(session.closed, true);
  assertEquals(session.started, true);
  assert(
    thrown instanceof CapnpError === false,
    "expected close to surface raw transport error without normalization",
  );
});
