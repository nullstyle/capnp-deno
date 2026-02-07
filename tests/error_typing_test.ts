import {
  CapnpError,
  decodeCallRequestFrame,
  InMemoryRpcHarnessTransport,
  instantiatePeer,
  InstantiationError,
  MessagePortTransport,
  ProtocolError,
  RpcSession,
  SessionError,
  TransportError,
  WasmPeer,
} from "../mod.ts";
import { FakeCapnpWasm } from "./fake_wasm.ts";
import { assert, assertEquals } from "./test_utils.ts";

Deno.test("decodeCallRequestFrame throws ProtocolError for malformed frames", () => {
  let thrown: unknown;
  try {
    decodeCallRequestFrame(new Uint8Array([0x00, 0x01, 0x02]));
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof ProtocolError,
    `expected ProtocolError, got ${String(thrown)}`,
  );
  assert(thrown instanceof CapnpError, "expected CapnpError base class");
  assertEquals((thrown as CapnpError).kind, "protocol");
});

Deno.test("instantiatePeer throws InstantiationError for unsupported sources", async () => {
  let thrown: unknown;
  try {
    await instantiatePeer({} as unknown as BufferSource);
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof InstantiationError,
    `expected InstantiationError, got ${String(thrown)}`,
  );
  assert(thrown instanceof CapnpError, "expected CapnpError base class");
  assertEquals((thrown as CapnpError).kind, "instantiate");
});

Deno.test("RpcSession double-start throws SessionError", async () => {
  const fake = new FakeCapnpWasm();
  const peer = WasmPeer.fromExports(fake.exports);
  const transport = new InMemoryRpcHarnessTransport();
  const session = new RpcSession(peer, transport);

  try {
    await session.start();

    let thrown: unknown;
    try {
      await session.start();
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof SessionError,
      `expected SessionError, got ${String(thrown)}`,
    );
    assert(thrown instanceof CapnpError, "expected CapnpError base class");
    assertEquals((thrown as CapnpError).kind, "session");
  } finally {
    await session.close();
  }
});

Deno.test("MessagePortTransport send-before-start throws TransportError", async () => {
  const channel = new MessageChannel();
  const transport = new MessagePortTransport(channel.port1, {
    closePortOnClose: true,
  });

  try {
    let thrown: unknown;
    try {
      await transport.send(new Uint8Array([0x01]));
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof TransportError,
      `expected TransportError, got ${String(thrown)}`,
    );
    assert(thrown instanceof CapnpError, "expected CapnpError base class");
    assertEquals((thrown as CapnpError).kind, "transport");
  } finally {
    await transport.close();
    channel.port2.close();
  }
});
