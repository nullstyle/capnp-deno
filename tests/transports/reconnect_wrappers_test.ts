import {
  connectTcpTransportWithReconnect,
  connectTransportWithReconnect,
  connectWebSocketTransportWithReconnect,
  connectWebTransportTransportWithReconnect,
  createExponentialBackoffReconnectPolicy,
  createRpcSessionWithReconnect,
  InMemoryRpcHarnessTransport,
  TcpTransport,
  TransportError,
  WebSocketTransport,
  WebTransportTransport,
} from "../../src/advanced.ts";
import { assert, assertEquals } from "../test_utils.ts";

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

function createFakeWebTransport(): WebTransport {
  const fakeWriter: WritableStreamDefaultWriter<Uint8Array> = {
    ready: Promise.resolve(undefined),
    closed: Promise.resolve(undefined),
    desiredSize: 1,
    write: (_chunk: Uint8Array) => Promise.resolve(undefined),
    close: () => Promise.resolve(undefined),
    abort: () => Promise.resolve(undefined),
    releaseLock: () => {},
  } as WritableStreamDefaultWriter<Uint8Array>;
  const fakeReader: ReadableStreamDefaultReader<Uint8Array> = {
    read: () => Promise.resolve({ done: true, value: undefined }),
    cancel: () => Promise.resolve(undefined),
    releaseLock: () => {},
    closed: Promise.resolve(undefined),
  } as ReadableStreamDefaultReader<Uint8Array>;
  const stream: WebTransportBidirectionalStream = {
    readable: {
      getReader: () => fakeReader,
    } as ReadableStream<Uint8Array> as WebTransportReceiveStream,
    writable: {
      getWriter: () => fakeWriter,
    } as WritableStream<Uint8Array> as WebTransportSendStream,
  };

  return {
    ready: Promise.resolve(undefined),
    closed: Promise.resolve({ closeCode: 0, reason: "closed" }),
    createBidirectionalStream: () => Promise.resolve(stream),
    incomingBidirectionalStreams: new ReadableStream<
      WebTransportBidirectionalStream
    >({
      start(controller) {
        controller.close();
      },
    }),
    close: () => {},
  } as WebTransport;
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

  const result = await createRpcSessionWithReconnect({
    connectTransport: () => {
      connectAttempts += 1;
      if (connectAttempts === 1) {
        return Promise.reject(new TransportError("dial failed once"));
      }
      return Promise.resolve(new InMemoryRpcHarnessTransport());
    },
    reconnect: reconnectOptions(),
    autoStart: true,
  });

  try {
    assertEquals(connectAttempts, 2);
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

Deno.test("connectTcpTransportWithReconnect uses empty transport options when omitted", async () => {
  const original = TcpTransport.connect;
  let seenOptions: Record<string, unknown> | null = null;

  try {
    (TcpTransport as unknown as {
      connect: typeof TcpTransport.connect;
    }).connect = (
      _hostname: string,
      _port: number,
      options = {},
    ): Promise<TcpTransport> => {
      seenOptions = options as Record<string, unknown>;
      return Promise.resolve(new TcpTransport(createFakeConn(), options));
    };

    const transport = await connectTcpTransportWithReconnect(
      "127.0.0.1",
      9999,
      {
        reconnect: reconnectOptions(),
      },
    );

    try {
      assertEquals(seenOptions !== null, true);
      assertEquals(Object.keys(seenOptions!).length, 0);
    } finally {
      await transport.close();
    }
  } finally {
    (TcpTransport as unknown as {
      connect: typeof TcpTransport.connect;
    }).connect = original;
  }
});

Deno.test("connectWebSocketTransportWithReconnect uses default protocols/options when omitted", async () => {
  const original = WebSocketTransport.connect;
  let seenUrl = "";
  let seenProtocols: string | string[] | undefined;
  let seenOptions: Record<string, unknown> | null = null;

  try {
    (WebSocketTransport as unknown as {
      connect: typeof WebSocketTransport.connect;
    }).connect = (
      url: string | URL,
      protocols?: string | string[],
      options = {},
    ): Promise<WebSocketTransport> => {
      seenUrl = String(url);
      seenProtocols = protocols;
      seenOptions = options as Record<string, unknown>;
      return Promise.resolve(
        new WebSocketTransport(
          new FakeWebSocket() as unknown as WebSocket,
          options,
        ),
      );
    };

    const transport = await connectWebSocketTransportWithReconnect(
      new URL("ws://127.0.0.1:9998"),
      {
        reconnect: reconnectOptions(),
      },
    );

    try {
      assertEquals(seenUrl, "ws://127.0.0.1:9998/");
      assertEquals(seenProtocols, undefined);
      assertEquals(seenOptions !== null, true);
      assertEquals(Object.keys(seenOptions!).length, 0);
    } finally {
      await transport.close();
    }
  } finally {
    (WebSocketTransport as unknown as {
      connect: typeof WebSocketTransport.connect;
    }).connect = original;
  }
});

Deno.test("connectWebTransportTransportWithReconnect delegates to WebTransportTransport.connect", async () => {
  const original = WebTransportTransport.connect;
  let attempts = 0;
  let seenUrl = "";
  let seenTimeout: number | undefined;

  try {
    (WebTransportTransport as unknown as {
      connect: typeof WebTransportTransport.connect;
    }).connect = (
      url: string | URL,
      options = {},
    ): Promise<WebTransportTransport> => {
      attempts += 1;
      seenUrl = String(url);
      seenTimeout = options.connectTimeoutMs;
      if (attempts < 2) {
        return Promise.reject(new TransportError("webtransport unavailable"));
      }
      return Promise.resolve(
        new WebTransportTransport(createFakeWebTransport(), {
          readable: {
            getReader: () => ({
              read: () => Promise.resolve({ done: true, value: undefined }),
              cancel: () => Promise.resolve(undefined),
              releaseLock: () => {},
              closed: Promise.resolve(undefined),
            } as ReadableStreamDefaultReader<Uint8Array>),
          } as ReadableStream<Uint8Array> as WebTransportReceiveStream,
          writable: {
            getWriter: () => ({
              ready: Promise.resolve(undefined),
              closed: Promise.resolve(undefined),
              desiredSize: 1,
              write: (_chunk: Uint8Array) => Promise.resolve(undefined),
              close: () => Promise.resolve(undefined),
              abort: () => Promise.resolve(undefined),
              releaseLock: () => {},
            } as WritableStreamDefaultWriter<Uint8Array>),
          } as WritableStream<Uint8Array> as WebTransportSendStream,
        }, options),
      );
    };

    const transport = await connectWebTransportTransportWithReconnect(
      "https://127.0.0.1:8443/rpc",
      {
        transport: { connectTimeoutMs: 222 },
        reconnect: reconnectOptions(),
      },
    );

    try {
      assert(
        transport instanceof WebTransportTransport,
        "expected WebTransportTransport",
      );
      assertEquals(attempts, 2);
      assertEquals(seenUrl, "https://127.0.0.1:8443/rpc");
      assertEquals(seenTimeout, 222);
    } finally {
      await transport.close();
    }
  } finally {
    (WebTransportTransport as unknown as {
      connect: typeof WebTransportTransport.connect;
    }).connect = original;
  }
});
