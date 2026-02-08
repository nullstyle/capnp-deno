import {
  CapnpError,
  decodeCallRequestFrame,
  InMemoryRpcHarnessTransport,
  instantiatePeer,
  InstantiationError,
  MessagePortTransport,
  ProtocolError,
  RpcSession,
  type RpcTransport,
  SessionError,
  TransportError,
  WasmPeer,
} from "../mod.ts";
import {
  normalizeAbiError,
  normalizeCapnpError,
  normalizeInstantiationError,
  normalizeProtocolError,
  normalizeSessionError,
  normalizeTransportError,
} from "../src/errors.ts";
import { FakeCapnpWasm } from "./fake_wasm.ts";
import { assert, assertEquals, deferred, withTimeout } from "./test_utils.ts";

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

class ThrowingStartTransport implements RpcTransport {
  start(): void {
    throw "raw-start-failure";
  }

  send(): void {
    // no-op
  }

  close(): void {
    // no-op
  }
}

Deno.test("RpcSession.start normalizes non-Capnp startup errors", async () => {
  const fake = new FakeCapnpWasm();
  const peer = WasmPeer.fromExports(fake.exports);
  const transport = new ThrowingStartTransport();
  const session = new RpcSession(peer, transport);

  let thrown: unknown;
  try {
    await session.start();
  } catch (error) {
    thrown = error;
  } finally {
    await session.close();
  }

  assert(
    thrown instanceof SessionError,
    `expected SessionError, got ${String(thrown)}`,
  );
  assert(thrown instanceof CapnpError, "expected CapnpError base class");
  assertEquals((thrown as CapnpError).kind, "session");
  assert(
    /rpc session start failed/i.test((thrown as Error).message),
    `expected normalized context in message, got: ${
      thrown instanceof Error ? thrown.message : String(thrown)
    }`,
  );
  assertEquals((thrown as Error).cause, "raw-start-failure");
});

Deno.test("MessagePortTransport normalizes unknown inbound callback failures", async () => {
  const channel = new MessageChannel();
  const seenError = deferred<unknown>();
  const transport = new MessagePortTransport(channel.port1, {
    closePortOnClose: true,
    onError: (error) => seenError.resolve(error),
  });

  try {
    transport.start(() => {
      throw "raw-frame-failure";
    });
    channel.port2.postMessage(new Uint8Array([0x01]));
    const error = await withTimeout(
      seenError.promise,
      1_000,
      "message port normalized error",
    );

    assert(
      error instanceof TransportError,
      `expected TransportError, got ${String(error)}`,
    );
    assert(error instanceof CapnpError, "expected CapnpError base class");
    assertEquals((error as CapnpError).kind, "transport");
    assert(
      /raw-frame-failure/i.test((error as Error).message),
      `expected normalized source detail, got: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await transport.close();
    channel.port2.close();
  }
});

Deno.test("normalizeCapnpError returns existing CapnpError instances unchanged", () => {
  const original = new SessionError("already normalized");
  const normalized = normalizeCapnpError(original, "abi", "ignored context");
  assertEquals(normalized, original);
});

Deno.test("normalizeCapnpError formats unknown error inputs consistently", () => {
  const named = new Error("   ");
  named.name = "NamedFailure";
  assertEquals(
    normalizeSessionError(named, "ctx").message,
    "ctx: NamedFailure",
  );

  assertEquals(
    normalizeSessionError("   ", "ctx").message,
    "ctx: unexpected error",
  );
  assertEquals(normalizeSessionError(123, "ctx").message, "ctx: 123");
  assertEquals(normalizeSessionError(true, "ctx").message, "ctx: true");
  assertEquals(normalizeSessionError(9n, "ctx").message, "ctx: 9");
  assertEquals(
    normalizeSessionError(Symbol("bad"), "ctx").message,
    "ctx: Symbol(bad)",
  );
  assertEquals(
    normalizeSessionError(null, "ctx").message,
    "ctx: unexpected error",
  );
  assertEquals(
    normalizeSessionError(undefined, "ctx").message,
    "ctx: unexpected error",
  );

  assertEquals(
    normalizeSessionError({ code: 7 }, "ctx").message,
    'ctx: {"code":7}',
  );
  assertEquals(
    normalizeSessionError({}, "ctx").message,
    "ctx: unexpected error",
  );

  const circular = { self: null as unknown };
  circular.self = circular;
  assertEquals(
    normalizeSessionError(circular, "ctx").message,
    "ctx: unexpected error",
  );
});

Deno.test("normalize* wrappers map to expected CapnpError kinds", () => {
  const source = new Error("source failure");

  const abi = normalizeAbiError(source, "abi context");
  assert(abi instanceof CapnpError, "expected CapnpError");
  assertEquals(abi.kind, "abi");
  assertEquals(abi.cause, source);

  const transport = normalizeTransportError("transport raw");
  assertEquals(transport.kind, "transport");
  assertEquals(transport.message, "transport raw");

  const protocol = normalizeProtocolError("protocol raw");
  assertEquals(protocol.kind, "protocol");
  assertEquals(protocol.message, "protocol raw");

  const session = normalizeSessionError("session raw");
  assertEquals(session.kind, "session");
  assertEquals(session.message, "session raw");

  const instantiate = normalizeInstantiationError("instantiate raw");
  assertEquals(instantiate.kind, "instantiate");
  assertEquals(instantiate.message, "instantiate raw");
});
