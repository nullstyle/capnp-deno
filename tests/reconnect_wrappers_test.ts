import {
  connectTcpTransportWithReconnect,
  connectTransportWithReconnect,
  connectWebSocketTransportWithReconnect,
  createExponentialBackoffReconnectPolicy,
  createRpcSessionWithReconnect,
  InMemoryRpcHarnessTransport,
  TcpTransport,
  TransportError,
  WasmPeer,
  WebSocketTransport,
} from "../mod.ts";
import { FakeCapnpWasm } from "./fake_wasm.ts";
import { assert, assertEquals } from "./test_utils.ts";

function reconnectOptions() {
  return {
    policy: createExponentialBackoffReconnectPolicy({
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 2,
      factor: 2,
      jitterRatio: 0,
    }),
    sleep: async (_delayMs: number) => {
      // no-op in tests
    },
  };
}

function createFakeConn(): Deno.Conn {
  const addr = {
    transport: "tcp",
    hostname: "127.0.0.1",
    port: 7000,
  } as Deno.NetAddr;

  return {
    rid: 1,
    localAddr: addr,
    remoteAddr: addr,
    read(_buffer: Uint8Array): Promise<number | null> {
      return Promise.resolve(null);
    },
    write(buffer: Uint8Array): Promise<number> {
      return Promise.resolve(buffer.byteLength);
    },
    close(): void {
      // no-op
    },
    closeWrite(): Promise<void> {
      return Promise.resolve();
    },
    setDeadline(): void {
      // no-op
    },
    setReadDeadline(): void {
      // no-op
    },
    setWriteDeadline(): void {
      // no-op
    },
  } as unknown as Deno.Conn;
}

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  binaryType: BinaryType = "arraybuffer";
  bufferedAmount = 0;

  send(_data: BufferSource): void {
    // no-op
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(
      new CloseEvent("close", { code: 1000, reason: "closed" }),
    );
  }
}

Deno.test("connectTransportWithReconnect retries generic transport connector", async () => {
  let attempts = 0;

  const transport = await connectTransportWithReconnect(
    () => {
      attempts += 1;
      if (attempts < 3) {
        return Promise.reject(new TransportError(`dial failed ${attempts}`));
      }
      return Promise.resolve(new InMemoryRpcHarnessTransport());
    },
    reconnectOptions(),
  );

  assert(
    transport instanceof InMemoryRpcHarnessTransport,
    "expected harness transport",
  );
  assertEquals(attempts, 3);
});

Deno.test("createRpcSessionWithReconnect retries connect and starts session", async () => {
  let connectAttempts = 0;
  let createPeerCalls = 0;

  const result = await createRpcSessionWithReconnect({
    connectTransport: () => {
      connectAttempts += 1;
      if (connectAttempts === 1) {
        return Promise.reject(new TransportError("dial failed once"));
      }
      return Promise.resolve(new InMemoryRpcHarnessTransport());
    },
    createPeer: () => {
      createPeerCalls += 1;
      const fake = new FakeCapnpWasm();
      return WasmPeer.fromExports(fake.exports);
    },
    reconnect: reconnectOptions(),
    autoStart: true,
  });

  try {
    assertEquals(connectAttempts, 2);
    assertEquals(createPeerCalls, 1);
    assertEquals(result.session.started, true);
  } finally {
    await result.session.close();
  }
});

Deno.test("connectTcpTransportWithReconnect delegates to TcpTransport.connect", async () => {
  const original = TcpTransport.connect;
  let attempts = 0;
  let seenHost = "";
  let seenPort = 0;
  let seenTimeout: number | undefined;

  try {
    (TcpTransport as unknown as {
      connect: typeof TcpTransport.connect;
    }).connect = (
      hostname: string,
      port: number,
      options = {},
    ): Promise<TcpTransport> => {
      attempts += 1;
      seenHost = hostname;
      seenPort = port;
      seenTimeout = options.connectTimeoutMs;
      if (attempts < 2) {
        return Promise.reject(new TransportError("tcp unavailable"));
      }
      return Promise.resolve(new TcpTransport(createFakeConn(), options));
    };

    const transport = await connectTcpTransportWithReconnect(
      "127.0.0.1",
      7777,
      {
        transport: { connectTimeoutMs: 123 },
        reconnect: reconnectOptions(),
      },
    );

    try {
      assert(transport instanceof TcpTransport, "expected TcpTransport");
      assertEquals(attempts, 2);
      assertEquals(seenHost, "127.0.0.1");
      assertEquals(seenPort, 7777);
      assertEquals(seenTimeout, 123);
    } finally {
      await transport.close();
    }
  } finally {
    (TcpTransport as unknown as {
      connect: typeof TcpTransport.connect;
    }).connect = original;
  }
});

Deno.test("connectWebSocketTransportWithReconnect delegates to WebSocketTransport.connect", async () => {
  const original = WebSocketTransport.connect;
  let attempts = 0;
  let seenUrl = "";
  let seenProtocols: string | string[] | undefined;
  let seenTimeout: number | undefined;

  try {
    (WebSocketTransport as unknown as {
      connect: typeof WebSocketTransport.connect;
    }).connect = (
      url: string | URL,
      protocols?: string | string[],
      options = {},
    ): Promise<WebSocketTransport> => {
      attempts += 1;
      seenUrl = String(url);
      seenProtocols = protocols;
      seenTimeout = options.connectTimeoutMs;
      if (attempts < 2) {
        return Promise.reject(new TransportError("websocket unavailable"));
      }
      return Promise.resolve(
        new WebSocketTransport(
          new FakeWebSocket() as unknown as WebSocket,
          options,
        ),
      );
    };

    const transport = await connectWebSocketTransportWithReconnect(
      "ws://127.0.0.1:8888",
      {
        protocols: ["capnp"],
        transport: { connectTimeoutMs: 321 },
        reconnect: reconnectOptions(),
      },
    );

    try {
      assert(
        transport instanceof WebSocketTransport,
        "expected WebSocketTransport",
      );
      assertEquals(attempts, 2);
      assertEquals(seenUrl, "ws://127.0.0.1:8888");
      assertEquals(JSON.stringify(seenProtocols), JSON.stringify(["capnp"]));
      assertEquals(seenTimeout, 321);
    } finally {
      await transport.close();
    }
  } finally {
    (WebSocketTransport as unknown as {
      connect: typeof WebSocketTransport.connect;
    }).connect = original;
  }
});
