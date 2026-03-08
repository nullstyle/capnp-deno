import { TransportError, WebSocketTransport } from "../../src/advanced.ts";
import { assert, assertEquals, deferred, withTimeout } from "../test_utils.ts";

function buildFrame(words: number): Uint8Array {
  const frame = new Uint8Array(8 + words * 8);
  const view = new DataView(frame.buffer);
  view.setUint32(0, 0, true);
  view.setUint32(4, words, true);
  return frame;
}

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  binaryType: BinaryType = "arraybuffer";
  bufferedAmount = 0;
  sent: Uint8Array[] = [];

  send(data: BufferSource): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("socket not open");
    }
    const view = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.sent.push(new Uint8Array(view));
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    const event = new CloseEvent("close", { code: 1000, reason: "closed" });
    this.dispatchEvent(event);
  }
}

async function withPatchedGlobalWebSocket(
  replacement: unknown,
  fn: () => Promise<void>,
): Promise<void> {
  const globalMutable = globalThis as unknown as {
    WebSocket: typeof WebSocket;
  };
  const original = globalMutable.WebSocket;
  globalMutable.WebSocket = replacement as typeof WebSocket;
  try {
    await fn();
  } finally {
    globalMutable.WebSocket = original;
  }
}

async function withPatchedDenoUpgradeWebSocket(
  replacement: unknown,
  fn: () => Promise<void>,
): Promise<void> {
  const denoMutable = Deno as unknown as {
    upgradeWebSocket?: typeof Deno.upgradeWebSocket;
  };
  const original = denoMutable.upgradeWebSocket;
  denoMutable.upgradeWebSocket = replacement as typeof Deno.upgradeWebSocket;
  try {
    await fn();
  } finally {
    denoMutable.upgradeWebSocket = original;
  }
}

async function withPatchedDenoServe(
  replacement: unknown,
  fn: () => Promise<void>,
): Promise<void> {
  const denoMutable = Deno as unknown as {
    serve?: typeof Deno.serve;
  };
  const original = denoMutable.serve;
  denoMutable.serve = replacement as typeof Deno.serve;
  try {
    await fn();
  } finally {
    denoMutable.serve = original;
  }
}

function transportWithSocket(
  options: ConstructorParameters<typeof WebSocketTransport>[1] = {},
): { socket: FakeWebSocket; transport: WebSocketTransport } {
  const socket = new FakeWebSocket();
  const transport = new WebSocketTransport(
    socket as unknown as WebSocket,
    options,
  );
  return { socket, transport };
}

Deno.test("WebSocketTransport enforces queued outbound frame limits", async () => {
  const { socket, transport } = transportWithSocket({
    maxSocketBufferedAmountBytes: 1,
    maxQueuedOutboundFrames: 1,
    sendTimeoutMs: 100,
    outboundDrainIntervalMs: 1,
  });

  socket.bufferedAmount = 10; // keep drain blocked initially.

  try {
    transport.start((_frame) => {});

    const first = transport.send(new Uint8Array([0x01]));

    let secondErr: unknown;
    try {
      await transport.send(new Uint8Array([0x02]));
    } catch (error) {
      secondErr = error;
    }

    assert(
      secondErr instanceof Error &&
        /outbound queue frame limit exceeded/i.test(secondErr.message),
      `expected queue frame limit error, got: ${String(secondErr)}`,
    );

    socket.bufferedAmount = 0;
    await withTimeout(first, 1000, "first websocket queued send");
    assertEquals(socket.sent.length, 1);
    assertEquals(socket.sent[0][0], 0x01);
  } finally {
    await transport.close();
  }
});

Deno.test("WebSocketTransport enforces sendTimeoutMs under buffered backpressure", async () => {
  const { socket, transport } = transportWithSocket({
    maxSocketBufferedAmountBytes: 0,
    sendTimeoutMs: 20,
    outboundDrainIntervalMs: 1,
  });

  socket.bufferedAmount = 10;

  try {
    transport.start((_frame) => {});

    let err: unknown;
    try {
      await transport.send(new Uint8Array([0xaa]));
    } catch (error) {
      err = error;
    }

    assert(
      err instanceof Error && /send timed out/i.test(err.message),
      `expected websocket send timeout error, got: ${String(err)}`,
    );
  } finally {
    await transport.close();
  }
});

Deno.test("WebSocketTransport validates inbound frameLimits", async () => {
  const seenErrors: unknown[] = [];
  const { socket, transport } = transportWithSocket({
    frameLimits: {
      maxTraversalWords: 1,
    },
    onError: (error) => {
      seenErrors.push(error);
    },
  });

  try {
    transport.start((_frame) => {});

    const frame = buildFrame(2);
    socket.dispatchEvent(
      new MessageEvent("message", { data: frame.buffer.slice(0) }),
    );

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 1000;
        const tick = (): void => {
          if (seenErrors.length > 0) {
            resolve();
            return;
          }
          if (Date.now() >= deadline) {
            reject(new Error("websocket frameLimits error callback timed out"));
            return;
          }
          setTimeout(tick, 5);
        };
        tick();
      }),
      1100,
      "websocket frameLimits error callback",
    );

    const err = seenErrors[0];
    assert(
      err instanceof Error &&
        /traversal words .* exceeds configured limit/i.test(err.message),
      `expected frame limits error, got: ${String(err)}`,
    );
  } finally {
    await transport.close();
  }
});

Deno.test("WebSocketTransport.connect normalizes constructor failures", async () => {
  class ThrowingSocket {
    constructor() {
      throw new Error("ctor exploded");
    }
  }

  await withPatchedGlobalWebSocket(ThrowingSocket, async () => {
    let thrown: unknown;
    try {
      await WebSocketTransport.connect("ws://127.0.0.1:1234");
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof TransportError &&
        /failed to create websocket/i.test(thrown.message) &&
        /127\.0\.0\.1:1234/i.test(thrown.message),
      `expected constructor normalization error, got: ${String(thrown)}`,
    );
  });
});

Deno.test("WebSocketTransport.connect rejects on websocket error event", async () => {
  class ErroringSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = ErroringSocket.CONNECTING;
    binaryType: BinaryType = "arraybuffer";
    bufferedAmount = 0;
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("error")));
    }
    send(_data: BufferSource): void {}
    close(): void {
      this.readyState = ErroringSocket.CLOSED;
    }
  }

  await withPatchedGlobalWebSocket(ErroringSocket, async () => {
    let thrown: unknown;
    try {
      await WebSocketTransport.connect("ws://127.0.0.1:2234");
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof TransportError &&
        /failed to connect websocket/i.test(thrown.message),
      `expected connect-error path, got: ${String(thrown)}`,
    );
  });
});

Deno.test("WebSocketTransport.connect times out and closes socket", async () => {
  const created: Array<{ closeCalls: number }> = [];

  class HangingSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = HangingSocket.CONNECTING;
    binaryType: BinaryType = "arraybuffer";
    bufferedAmount = 0;
    closeCalls = 0;
    constructor() {
      super();
      created.push(this);
    }
    send(_data: BufferSource): void {}
    close(): void {
      this.closeCalls += 1;
      this.readyState = HangingSocket.CLOSED;
    }
  }

  await withPatchedGlobalWebSocket(HangingSocket, async () => {
    let thrown: unknown;
    try {
      await WebSocketTransport.connect("ws://127.0.0.1:3234", undefined, {
        connectTimeoutMs: 10,
      });
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof TransportError &&
        /connect timed out/i.test(thrown.message),
      `expected connect-timeout error, got: ${String(thrown)}`,
    );
    assertEquals(created.length, 1);
    assertEquals(created[0].closeCalls > 0, true);
  });
});

Deno.test("WebSocketTransport.connect succeeds when socket opens", async () => {
  class OpeningSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = OpeningSocket.CONNECTING;
    binaryType: BinaryType = "arraybuffer";
    bufferedAmount = 0;
    constructor() {
      super();
      queueMicrotask(() => {
        this.readyState = OpeningSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      });
    }
    send(_data: BufferSource): void {}
    close(): void {
      this.readyState = OpeningSocket.CLOSED;
      this.dispatchEvent(
        new CloseEvent("close", { code: 1000, reason: "done" }),
      );
    }
  }

  await withPatchedGlobalWebSocket(OpeningSocket, async () => {
    const transport = await WebSocketTransport.connect("ws://127.0.0.1:4234");
    await transport.close();
  });
});

Deno.test("WebSocketTransport validates start/send lifecycle and frame size limits", async () => {
  const { socket, transport } = transportWithSocket({
    maxOutboundFrameBytes: 2,
  });

  let notStartedErr: unknown;
  try {
    await transport.send(new Uint8Array([0x01]));
  } catch (error) {
    notStartedErr = error;
  }
  assert(
    notStartedErr instanceof TransportError &&
      /not started/i.test(notStartedErr.message),
    `expected send-before-start error, got: ${String(notStartedErr)}`,
  );

  transport.start((_frame) => {});

  let tooLargeErr: unknown;
  try {
    await transport.send(new Uint8Array([0x01, 0x02, 0x03]));
  } catch (error) {
    tooLargeErr = error;
  }
  assert(
    tooLargeErr instanceof TransportError &&
      /outbound frame size 3 exceeds configured limit 2/i.test(
        tooLargeErr.message,
      ),
    `expected outbound frame limit error, got: ${String(tooLargeErr)}`,
  );

  socket.readyState = FakeWebSocket.CLOSING;
  let notOpenErr: unknown;
  try {
    await transport.send(new Uint8Array([0x01]));
  } catch (error) {
    notOpenErr = error;
  }
  assert(
    notOpenErr instanceof TransportError &&
      /websocket not open/i.test(notOpenErr.message),
    `expected not-open send error, got: ${String(notOpenErr)}`,
  );

  await transport.close();
});

Deno.test("WebSocketTransport enforces maxQueuedOutboundBytes", async () => {
  const { transport } = transportWithSocket({
    maxQueuedOutboundBytes: 0,
  });

  try {
    transport.start((_frame) => {});
    let thrown: unknown;
    try {
      await transport.send(new Uint8Array([0xbb]));
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof TransportError &&
        /queue byte limit exceeded/i.test(thrown.message),
      `expected queue byte limit error, got: ${String(thrown)}`,
    );
  } finally {
    await transport.close();
  }
});

Deno.test("WebSocketTransport can ignore text frames when rejectTextFrames is disabled", async () => {
  const seenErrors: unknown[] = [];
  let seenFrames = 0;
  const { socket, transport } = transportWithSocket({
    rejectTextFrames: false,
    onError: (error) => {
      seenErrors.push(error);
    },
  });

  try {
    transport.start((_frame) => {
      seenFrames += 1;
    });
    socket.dispatchEvent(new MessageEvent("message", { data: "text payload" }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assertEquals(seenFrames, 0);
    assertEquals(seenErrors.length, 0);
  } finally {
    await transport.close();
  }
});

Deno.test("WebSocketTransport reports unsupported inbound payload types", async () => {
  const seenErrors: unknown[] = [];
  const { socket, transport } = transportWithSocket({
    onError: (error) => {
      seenErrors.push(error);
    },
  });

  try {
    transport.start((_frame) => {});
    socket.dispatchEvent(new MessageEvent("message", { data: 123 as unknown }));

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 1000;
        const tick = (): void => {
          if (seenErrors.length > 0) {
            resolve();
            return;
          }
          if (Date.now() >= deadline) {
            reject(
              new Error(
                "websocket unsupported payload error callback timed out",
              ),
            );
            return;
          }
          setTimeout(tick, 5);
        };
        tick();
      }),
      1100,
      "websocket unsupported payload error callback",
    );

    assert(
      seenErrors[0] instanceof TransportError &&
        /unsupported websocket message payload/i.test(seenErrors[0].message),
      `expected unsupported payload error, got: ${String(seenErrors[0])}`,
    );
  } finally {
    await transport.close();
  }
});

Deno.test("WebSocketTransport close respects closeTimeoutMs when no close event arrives", async () => {
  class NoCloseEventSocket extends FakeWebSocket {
    override close(): void {
      this.readyState = FakeWebSocket.OPEN;
      // intentionally do not dispatch close event
    }
  }

  const socket = new NoCloseEventSocket();
  const transport = new WebSocketTransport(socket as unknown as WebSocket, {
    closeTimeoutMs: 10,
  });
  transport.start((_frame) => {});

  await withTimeout(transport.close(), 1000, "websocket close timeout path");
});

Deno.test("WebSocketTransport rejects text frames by default", async () => {
  const seenErrors: unknown[] = [];
  const { socket, transport } = transportWithSocket({
    onError: (error) => {
      seenErrors.push(error);
    },
  });

  try {
    transport.start((_frame) => {});
    socket.dispatchEvent(new MessageEvent("message", { data: "text frame" }));

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 1000;
        const tick = (): void => {
          if (seenErrors.length > 0) {
            resolve();
            return;
          }
          if (Date.now() >= deadline) {
            reject(new Error("websocket text-frame error callback timed out"));
            return;
          }
          setTimeout(tick, 5);
        };
        tick();
      }),
      1100,
      "websocket text frame rejection",
    );

    assert(
      seenErrors[0] instanceof TransportError &&
        /text frame is not supported/i.test(seenErrors[0].message),
      `expected text-frame rejection, got: ${String(seenErrors[0])}`,
    );
  } finally {
    await transport.close();
  }
});

Deno.test("WebSocketTransport accepts typed-array and blob inbound payloads", async () => {
  const received: Uint8Array[] = [];
  const { socket, transport } = transportWithSocket();

  try {
    transport.start((frame) => {
      received.push(frame);
    });
    socket.dispatchEvent(
      new MessageEvent("message", { data: new Uint8Array([1, 2, 3]) }),
    );
    socket.dispatchEvent(
      new MessageEvent("message", { data: new Blob([new Uint8Array([4, 5])]) }),
    );

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 1000;
        const tick = (): void => {
          if (received.length >= 2) {
            resolve();
            return;
          }
          if (Date.now() >= deadline) {
            reject(new Error("websocket binary payload decode timed out"));
            return;
          }
          setTimeout(tick, 5);
        };
        tick();
      }),
      1100,
      "websocket typed-array/blob decode",
    );

    assertEquals(received[0][0], 1);
    assertEquals(received[0][2], 3);
    assertEquals(received[1][0], 4);
    assertEquals(received[1][1], 5);
  } finally {
    await transport.close();
  }
});

Deno.test("WebSocketTransport rejects send after close", async () => {
  const { transport } = transportWithSocket();
  transport.start((_frame) => {});
  await transport.close();

  let thrown: unknown;
  try {
    await transport.send(new Uint8Array([0x01]));
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof TransportError &&
      /is closed/i.test(thrown.message),
    `expected send-after-close error, got: ${String(thrown)}`,
  );
});

Deno.test("WebSocketTransport close swallows socket.close errors", async () => {
  class CloseThrowingSocket extends FakeWebSocket {
    override close(): void {
      throw new Error("close exploded");
    }
  }

  const socket = new CloseThrowingSocket();
  const transport = new WebSocketTransport(socket as unknown as WebSocket, {
    closeTimeoutMs: 10,
  });
  transport.start((_frame) => {});

  await withTimeout(transport.close(), 1000, "websocket close throw path");
});

Deno.test("WebSocketTransport invokes onClose when the socket closes", async () => {
  const closed = deferred<void>();
  const { socket, transport } = transportWithSocket({
    onClose: () => {
      closed.resolve();
    },
  });

  try {
    transport.start((_frame) => {});
    socket.close();
    await withTimeout(closed.promise, 1000, "websocket onClose callback");
  } finally {
    await transport.close();
  }
});

Deno.test("WebSocketTransport.handler validates requests and yields accepted transports", async () => {
  const upgradedSockets: FakeWebSocket[] = [];
  const handler = WebSocketTransport.handler({
    path: "/rpc",
    protocols: ["capnp-rpc"],
  });

  await withPatchedDenoUpgradeWebSocket((_request: Request, _options?: {
    protocol?: string;
  }) => {
    const socket = new FakeWebSocket();
    upgradedSockets.push(socket);
    return {
      socket: socket as unknown as WebSocket,
      response: new Response(null, { status: 101 }),
    };
  }, async () => {
    const notUpgrade = await handler.handle(
      new Request("http://127.0.0.1:8080/rpc"),
    );
    assertEquals(notUpgrade.status, 426);

    const wrongPath = await handler.handle(
      new Request("http://127.0.0.1:8080/nope", {
        headers: { upgrade: "websocket" },
      }),
    );
    assertEquals(wrongPath.status, 404);

    const wrongProtocol = await handler.handle(
      new Request("http://127.0.0.1:8080/rpc", {
        headers: {
          upgrade: "websocket",
          "sec-websocket-protocol": "other",
        },
      }),
    );
    assertEquals(wrongProtocol.status, 426);

    const acceptLoop = (async () => {
      for await (const transport of handler.accept()) {
        return transport;
      }
      return null;
    })();

    const response = await handler.handle(
      new Request("http://127.0.0.1:8080/rpc", {
        headers: {
          upgrade: "websocket",
          "sec-websocket-protocol": "capnp-rpc",
          "sec-websocket-key": "test-key",
        },
      }),
    );
    assertEquals(response.status, 101);

    const accepted = await withTimeout(
      acceptLoop,
      1000,
      "websocket accepted transport",
    );
    assert(accepted !== null, "expected accepted websocket transport");
    assertEquals(accepted.transport, accepted);
    assertEquals(accepted.localAddress?.transport, "websocket");
    assertEquals(accepted.localAddress?.path, "/rpc");
    assertEquals(accepted.remoteAddress?.transport, "websocket");
    assertEquals(accepted.id, "test-key");

    await accepted.close();
    await handler.close();
    for (const socket of upgradedSockets) {
      socket.close();
    }
  });
});

Deno.test("WebSocketTransport.listen delegates requests through a transport-owned handler", async () => {
  const acceptedSocket = new FakeWebSocket();
  let serveHandler: ((request: Request) => Promise<Response>) | null = null;
  let shutdownCalls = 0;

  await withPatchedDenoServe((
    options: Deno.ServeTcpOptions,
    handler: (request: Request) => Promise<Response>,
  ) => {
    serveHandler = handler;
    return {
      addr: {
        transport: "tcp",
        hostname: options.hostname ?? "0.0.0.0",
        port: options.port,
      },
      shutdown: () => {
        shutdownCalls += 1;
        return Promise.resolve();
      },
      finished: Promise.resolve(),
    } as Deno.HttpServer<Deno.NetAddr>;
  }, async () => {
    await withPatchedDenoUpgradeWebSocket((_request: Request) => ({
      socket: acceptedSocket as unknown as WebSocket,
      response: new Response(null, { status: 101 }),
    }), async () => {
      const listener = WebSocketTransport.listen({
        hostname: "127.0.0.1",
        port: 8080,
      });

      const acceptLoop = (async () => {
        for await (const transport of listener.accept()) {
          return transport;
        }
        return null;
      })();

      assert(serveHandler !== null, "expected Deno.serve handler");
      const response = await serveHandler!(
        new Request("http://127.0.0.1:8080/rpc", {
          headers: { upgrade: "websocket" },
        }),
      );
      assertEquals(response.status, 101);

      const accepted = await withTimeout(
        acceptLoop,
        1000,
        "websocket listener accepted transport",
      );
      assert(accepted !== null, "expected websocket transport from listener");
      assertEquals((listener.addr as Deno.NetAddr).hostname, "127.0.0.1");

      await accepted.close();
      await listener.close();
      assertEquals(shutdownCalls, 1);
    });
  });
});

Deno.test("WebSocketTransport queued send fails when transport closes during buffered backpressure", async () => {
  const { socket, transport } = transportWithSocket({
    maxSocketBufferedAmountBytes: 0,
    outboundDrainIntervalMs: 1,
  });
  socket.bufferedAmount = 100;

  try {
    transport.start((_frame) => {});
    const pending = transport.send(new Uint8Array([0xaa]));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await transport.close();

    let thrown: unknown;
    try {
      await pending;
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof TransportError &&
        /is closed/i.test(thrown.message),
      `expected queued send rejection after close, got: ${String(thrown)}`,
    );
  } finally {
    await transport.close();
  }
});

Deno.test("WebSocketTransport enforces maxInboundFrameBytes", async () => {
  const seenErrors: unknown[] = [];
  const { socket, transport } = transportWithSocket({
    maxInboundFrameBytes: 2,
    onError: (error) => {
      seenErrors.push(error);
    },
  });

  try {
    transport.start((_frame) => {});
    socket.dispatchEvent(
      new MessageEvent("message", { data: new Uint8Array([1, 2, 3]) }),
    );

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 1000;
        const tick = (): void => {
          if (seenErrors.length > 0) {
            resolve();
            return;
          }
          if (Date.now() >= deadline) {
            reject(
              new Error("websocket maxInboundFrameBytes callback timed out"),
            );
            return;
          }
          setTimeout(tick, 5);
        };
        tick();
      }),
      1100,
      "websocket inbound max-bytes error",
    );

    assert(
      seenErrors[0] instanceof TransportError &&
        /inbound frame size 3 exceeds configured limit 2/i.test(
          seenErrors[0].message,
        ),
      `expected maxInboundFrameBytes error, got: ${String(seenErrors[0])}`,
    );
  } finally {
    await transport.close();
  }
});

Deno.test("WebSocketTransport.connect supports protocols parameter", async () => {
  const seenProtocols: Array<string | string[] | undefined> = [];
  class ProtocolTrackingSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = ProtocolTrackingSocket.CONNECTING;
    binaryType: BinaryType = "arraybuffer";
    bufferedAmount = 0;
    constructor(_url: string | URL, protocols?: string | string[]) {
      super();
      seenProtocols.push(protocols);
      queueMicrotask(() => {
        this.readyState = ProtocolTrackingSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      });
    }
    send(_data: BufferSource): void {}
    close(): void {
      this.readyState = ProtocolTrackingSocket.CLOSED;
      this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
    }
  }

  await withPatchedGlobalWebSocket(ProtocolTrackingSocket, async () => {
    const transport = await WebSocketTransport.connect(
      "ws://127.0.0.1:5234",
      ["capnp-rpc"],
    );
    await transport.close();
  });

  assertEquals(seenProtocols.length, 1);
  assertEquals((seenProtocols[0] as string[])[0], "capnp-rpc");
});

Deno.test("WebSocketTransport start rejects duplicate start calls", async () => {
  const { transport } = transportWithSocket();
  try {
    transport.start((_frame) => {});
    let thrown: unknown;
    try {
      transport.start((_frame) => {});
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof TransportError &&
        /already started/i.test(thrown.message),
      `expected start-twice error, got: ${String(thrown)}`,
    );
  } finally {
    await transport.close();
  }
});

Deno.test("WebSocketTransport.connect timeout tolerates socket.close failures", async () => {
  const created: Array<{ closeCalls: number }> = [];

  class TimeoutCloseThrowingSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = TimeoutCloseThrowingSocket.CONNECTING;
    binaryType: BinaryType = "arraybuffer";
    bufferedAmount = 0;
    closeCalls = 0;
    constructor() {
      super();
      created.push(this);
    }
    send(_data: BufferSource): void {}
    close(): void {
      this.closeCalls += 1;
      throw new Error("close exploded");
    }
  }

  await withPatchedGlobalWebSocket(TimeoutCloseThrowingSocket, async () => {
    let thrown: unknown;
    try {
      await WebSocketTransport.connect("ws://127.0.0.1:6234", undefined, {
        connectTimeoutMs: 10,
      });
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof TransportError &&
        /connect timed out/i.test(thrown.message),
      `expected connect-timeout error, got: ${String(thrown)}`,
    );
    assertEquals(created.length, 1);
    assertEquals(created[0].closeCalls > 0, true);
  });
});

Deno.test("WebSocketTransport waits for close event when no close timeout is configured", async () => {
  class DelayedCloseSocket extends FakeWebSocket {
    override close(): void {
      this.readyState = FakeWebSocket.CLOSING;
      setTimeout(() => {
        this.readyState = FakeWebSocket.CLOSED;
        this.dispatchEvent(
          new CloseEvent("close", { code: 1000, reason: "done" }),
        );
      }, 20);
    }
  }

  const socket = new DelayedCloseSocket();
  const transport = new WebSocketTransport(socket as unknown as WebSocket);
  transport.start((_frame) => {});

  let closed = false;
  const closePromise = transport.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assertEquals(closed, false);

  await withTimeout(closePromise, 1000, "websocket close wait-for-event");
  assertEquals(closed, true);
});

Deno.test("WebSocketTransport rejects queued sends when socket becomes non-open during buffered wait", async () => {
  const { socket, transport } = transportWithSocket({
    maxSocketBufferedAmountBytes: 0,
    sendTimeoutMs: 100,
  });
  socket.bufferedAmount = 10;

  try {
    transport.start((_frame) => {});
    const pending = transport.send(new Uint8Array([0xaa]));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    socket.readyState = FakeWebSocket.CLOSING;

    let thrown: unknown;
    try {
      await pending;
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof TransportError &&
        /websocket not open/i.test(thrown.message),
      `expected buffered-wait not-open error, got: ${String(thrown)}`,
    );
  } finally {
    await transport.close();
  }
});

Deno.test("WebSocketTransport reuses active drain loop for multiple queued sends", async () => {
  const { socket, transport } = transportWithSocket({
    maxSocketBufferedAmountBytes: 1,
    sendTimeoutMs: 200,
  });
  socket.bufferedAmount = 100;

  try {
    transport.start((_frame) => {});
    const first = transport.send(new Uint8Array([0x01]));
    const second = transport.send(new Uint8Array([0x02]));

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    socket.bufferedAmount = 0;

    await withTimeout(first, 1000, "websocket queued send 1");
    await withTimeout(second, 1000, "websocket queued send 2");
    assertEquals(socket.sent.length, 2);
    assertEquals(socket.sent[0][0], 0x01);
    assertEquals(socket.sent[1][0], 0x02);
  } finally {
    await transport.close();
  }
});
