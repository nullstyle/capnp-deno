import {
  connect,
  MessagePortTransport,
  RpcSession,
  type RpcStub,
  type RpcTransport,
  serveConnection,
  WasmPeer,
} from "../../src/advanced.ts";
import { FakeCapnpWasm } from "../fake_wasm.ts";
import {
  assertBytes,
  assertEquals,
  deferred,
  withTimeout,
} from "../test_utils.ts";
import {
  CounterSink,
  type CounterSink as CounterSinkClient,
  type CounterSinkService,
  createCounterSinkAddStreamSender,
} from "../../examples/streaming/gen/schema_types.ts";
import {
  Pinger,
  type Pinger as PingerService,
  type Ponger,
} from "../../examples/ping/gen/schema_types.ts";

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

function createMessagePortAcceptedPair(): {
  clientTransport: MessagePortTransport;
  serverTransport: MessagePortTransport;
  accepted: {
    transport: MessagePortTransport;
    localAddress: { transport: string };
    remoteAddress: { transport: string };
    id: string;
  };
} {
  const channel = new MessageChannel();
  const serverTransport = new MessagePortTransport(channel.port1, {
    closePortOnClose: true,
  });
  const clientTransport = new MessagePortTransport(channel.port2, {
    closePortOnClose: true,
  });
  return {
    clientTransport,
    serverTransport,
    accepted: {
      transport: serverTransport,
      localAddress: { transport: "messageport" },
      remoteAddress: { transport: "messageport" },
      id: "messageport-generated-test",
    },
  };
}

function sumNumbers(values: readonly number[]): bigint {
  return values.reduce((sum, value) => sum + BigInt(value), 0n);
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

Deno.test("MessagePortTransport connect/serve generated callbacks", async () => {
  const { clientTransport, serverTransport, accepted } =
    createMessagePortAcceptedPair();
  let client: RpcStub<PingerService> | null = null;
  const callbackValues: number[] = [];
  let callbackSawPendingPing = false;
  let pingResolved = false;
  let serverCallbackStarted = false;
  let serverCallbackFinished = false;

  const handle = await serveConnection(Pinger, accepted, {
    async ping(ponger) {
      serverCallbackStarted = true;
      await ponger.pong(321, { timeoutMs: 2_000 });
      serverCallbackFinished = true;
    },
  });

  try {
    client = await connect(Pinger, clientTransport);
    const localPonger: Ponger = {
      pong(value) {
        callbackSawPendingPing = !pingResolved;
        callbackValues.push(value);
        return Promise.resolve();
      },
    };

    await withTimeout(
      client.ping(localPonger, { timeoutMs: 2_000 }),
      4_000,
      "messageport generated callback ping",
    );
    pingResolved = true;

    assertEquals(serverCallbackStarted, true);
    assertEquals(serverCallbackFinished, true);
    assertEquals(callbackSawPendingPing, true);
    assertEquals(callbackValues.join(","), "321");
  } finally {
    await client?.close().catch(() => {});
    await Promise.resolve(clientTransport.close()).catch(() => {});
    await handle.close();
    await Promise.resolve(serverTransport.close()).catch(() => {});
  }
});

Deno.test("MessagePortTransport connect/serve generated streaming", async () => {
  const { clientTransport, serverTransport, accepted } =
    createMessagePortAcceptedPair();
  let client: RpcStub<CounterSinkClient> | null = null;
  const values: number[] = [];
  let active = 0;
  let maxActive = 0;

  const server: CounterSinkService = {
    async add(value, ctx) {
      if (ctx.signal.aborted) {
        throw new Error("messageport stream call started after cancellation");
      }
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        values.push(value);
        await new Promise((resolve) => setTimeout(resolve, 1));
      } finally {
        active--;
      }
    },

    total() {
      return {
        sum: sumNumbers(values),
        count: values.length,
      };
    },
  };

  const handle = await serveConnection(CounterSink, accepted, server);

  try {
    client = await connect(CounterSink, clientTransport);
    const sender = createCounterSinkAddStreamSender(client, {
      maxInFlight: 3,
    });
    const sent = [2, 3, 5, 7, 11];

    for (const value of sent) {
      await sender.send(value);
    }
    await withTimeout(
      sender.flush(),
      4_000,
      "messageport generated streaming flush",
    );

    assertEquals(sender.totalSent, sent.length);
    assertEquals(sender.totalReceived, sent.length);
    assertEquals(maxActive, 1);
    assertEquals(values.join(","), sent.join(","));

    const total = await withTimeout(
      client.total({ timeoutMs: 2_000 }),
      4_000,
      "messageport generated streaming total",
    );
    assertEquals(total.sum, sumNumbers(sent));
    assertEquals(total.count, sent.length);
  } finally {
    await client?.close().catch(() => {});
    await Promise.resolve(clientTransport.close()).catch(() => {});
    await handle.close();
    await Promise.resolve(serverTransport.close()).catch(() => {});
  }
});
