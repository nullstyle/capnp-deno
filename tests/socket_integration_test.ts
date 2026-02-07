import {
  RpcSession,
  type RpcTransport,
  TcpTransport,
  WasmPeer,
  WebSocketTransport,
} from "../mod.ts";
import { FakeCapnpWasm } from "./fake_wasm.ts";
import {
  assertBytes,
  assertEquals,
  deferred,
  withTimeout,
} from "./test_utils.ts";

function buildSingleSegmentFrame(firstByte: number): Uint8Array {
  const frame = new Uint8Array(16);
  const view = new DataView(frame.buffer);
  view.setUint32(0, 0, true); // segmentCountMinusOne
  view.setUint32(4, 1, true); // one word
  frame[8] = firstByte & 0xff;
  return frame;
}

function makeServerPeer(responseFrame: Uint8Array): WasmPeer {
  const fake = new FakeCapnpWasm({
    onPushFrame: (_incoming) => [responseFrame],
  });
  return WasmPeer.fromExports(fake.exports);
}

function makeClientPeer(onFrame: (frame: Uint8Array) => void): WasmPeer {
  const fake = new FakeCapnpWasm({
    onPushFrame: (incoming) => {
      onFrame(new Uint8Array(incoming));
      return [];
    },
  });
  return WasmPeer.fromExports(fake.exports);
}

async function closeAll(
  transports: RpcTransport[],
  sessions: RpcSession[],
): Promise<void> {
  for (const session of sessions) {
    try {
      await session.close();
    } catch (_err) {
      // ignore teardown errors
    }
  }
  for (const transport of transports) {
    try {
      await transport.close();
    } catch (_err) {
      // ignore teardown errors
    }
  }
}

Deno.test("WebSocketTransport loopback e2e with RpcSession", async () => {
  const expectedResponse = buildSingleSegmentFrame(0x7b);
  const inboundSeen = deferred<Uint8Array>();
  const serverSessionReady = deferred<void>();
  const serverSessionError = deferred<unknown>();
  const sessions: RpcSession[] = [];
  const transports: RpcTransport[] = [];

  const ac = new AbortController();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: ac.signal,
    onListen: () => {},
  }, (req) => {
    const { socket, response } = Deno.upgradeWebSocket(req);
    const transport = new WebSocketTransport(socket, {
      onError: (err) => serverSessionError.resolve(err),
    });
    const peer = makeServerPeer(expectedResponse);
    const session = new RpcSession(peer, transport, {
      onError: (err) => serverSessionError.resolve(err),
    });
    sessions.push(session);
    transports.push(transport);
    void session.start().then(
      () => serverSessionReady.resolve(),
      (err) => serverSessionError.resolve(err),
    );
    return response;
  });

  try {
    const addr = server.addr as Deno.NetAddr;
    const clientTransport = await WebSocketTransport.connect(
      `ws://${addr.hostname}:${addr.port}`,
    );
    transports.push(clientTransport);

    const clientPeer = makeClientPeer((frame) => inboundSeen.resolve(frame));
    const clientSession = new RpcSession(clientPeer, clientTransport);
    sessions.push(clientSession);
    await clientSession.start();

    await withTimeout(
      serverSessionReady.promise,
      2000,
      "server websocket session start",
    );
    await clientTransport.send(buildSingleSegmentFrame(0x44));

    const got = await withTimeout(
      inboundSeen.promise,
      2000,
      "websocket inbound response",
    );
    assertBytes(got, Array.from(expectedResponse));

    const maybeErr = await Promise.race([
      serverSessionError.promise.then((err) => err),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20)),
    ]);
    assertEquals(maybeErr, null, "server websocket session should not error");
  } finally {
    await closeAll(transports, sessions);
    ac.abort();
    await server.finished.catch(() => {});
  }
});

Deno.test("TcpTransport loopback e2e with RpcSession", async () => {
  const expectedResponse = buildSingleSegmentFrame(0x5a);
  const inboundSeen = deferred<Uint8Array>();
  const sessions: RpcSession[] = [];
  const transports: RpcTransport[] = [];
  const serverSessionError = deferred<unknown>();

  const listener = Deno.listen({
    hostname: "127.0.0.1",
    port: 0,
    transport: "tcp",
  });

  const serverAccept = (async () => {
    const conn = await listener.accept();
    const transport = new TcpTransport(conn, {
      onError: (err) => serverSessionError.resolve(err),
    });
    transports.push(transport);

    const peer = makeServerPeer(expectedResponse);
    const session = new RpcSession(peer, transport, {
      onError: (err) => serverSessionError.resolve(err),
    });
    sessions.push(session);
    await session.start();
  })();

  try {
    const addr = listener.addr as Deno.NetAddr;
    const clientTransport = await TcpTransport.connect(
      addr.hostname,
      addr.port,
    );
    transports.push(clientTransport);

    const clientPeer = makeClientPeer((frame) => inboundSeen.resolve(frame));
    const clientSession = new RpcSession(clientPeer, clientTransport);
    sessions.push(clientSession);
    await clientSession.start();

    await serverAccept;
    await clientTransport.send(buildSingleSegmentFrame(0x12));

    const got = await withTimeout(
      inboundSeen.promise,
      2000,
      "tcp inbound response",
    );
    assertBytes(got, Array.from(expectedResponse));

    const maybeErr = await Promise.race([
      serverSessionError.promise.then((err) => err),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20)),
    ]);
    assertEquals(maybeErr, null, "server tcp session should not error");
  } finally {
    listener.close();
    await closeAll(transports, sessions);
  }
});
