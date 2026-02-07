import {
  type RpcObservabilityEvent,
  RpcSession,
  type RpcTransport,
  WasmPeer,
} from "../mod.ts";
import { FakeCapnpWasm } from "./fake_wasm.ts";
import { assert, assertBytes, assertEquals } from "./test_utils.ts";

class MockTransport implements RpcTransport {
  private onFrame: ((frame: Uint8Array) => void | Promise<void>) | null = null;
  readonly sent: Uint8Array[] = [];
  started = false;
  closed = false;

  start(
    onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): void {
    this.started = true;
    this.onFrame = onFrame;
  }

  send(frame: Uint8Array): void {
    this.sent.push(new Uint8Array(frame));
  }

  close(): void {
    this.closed = true;
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
