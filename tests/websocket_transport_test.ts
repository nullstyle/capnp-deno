import { WebSocketTransport } from "../mod.ts";
import { assert, assertEquals, withTimeout } from "./test_utils.ts";

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
