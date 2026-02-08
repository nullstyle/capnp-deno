import {
  MessagePortTransport,
  RpcSession,
  type RpcTransport,
  WasmPeer,
} from "../advanced.ts";
import { FakeCapnpWasm } from "./fake_wasm.ts";
import { assertBytes, deferred, withTimeout } from "./test_utils.ts";

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

Deno.test("MessagePortTransport loopback e2e with RpcSession", async () => {
  const expectedResponse = buildSingleSegmentFrame(0x6f);
  const inboundSeen = deferred<Uint8Array>();
  const transports: RpcTransport[] = [];
  const sessions: RpcSession[] = [];
  const channel = new MessageChannel();

  const serverTransport = new MessagePortTransport(channel.port1, {
    closePortOnClose: true,
  });
  const clientTransport = new MessagePortTransport(channel.port2, {
    closePortOnClose: true,
  });
  transports.push(serverTransport, clientTransport);

  const serverPeer = makeServerPeer(expectedResponse);
  const serverSession = new RpcSession(serverPeer, serverTransport);
  sessions.push(serverSession);

  const clientPeer = makeClientPeer((frame) => inboundSeen.resolve(frame));
  const clientSession = new RpcSession(clientPeer, clientTransport);
  sessions.push(clientSession);

  try {
    await serverSession.start();
    await clientSession.start();

    await clientTransport.send(buildSingleSegmentFrame(0x1a));

    const got = await withTimeout(
      inboundSeen.promise,
      2000,
      "message port inbound response",
    );
    assertBytes(got, Array.from(expectedResponse));
  } finally {
    await closeAll(transports, sessions);
  }
});
