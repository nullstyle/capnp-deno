import {
  createFrameSizeLimitMiddleware,
  createLoggingMiddleware,
  MiddlewareTransport,
  type RpcTransport,
  type RpcTransportMiddleware,
  TransportError,
} from "../mod.ts";
import { assert, assertBytes, assertEquals } from "./test_utils.ts";

// ---------------------------------------------------------------------------
// Minimal mock transport for middleware tests
// ---------------------------------------------------------------------------

class MockTransport implements RpcTransport {
  onFrame: ((frame: Uint8Array) => void | Promise<void>) | null = null;
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
    this.onFrame = null;
  }

  /** Simulate receiving a frame from the remote peer. */
  async emitInbound(frame: Uint8Array): Promise<void> {
    if (!this.onFrame) throw new Error("transport not started");
    await this.onFrame(frame);
  }
}

// ---------------------------------------------------------------------------
// MiddlewareTransport basics
// ---------------------------------------------------------------------------

Deno.test("MiddlewareTransport passes frames through when no middleware is installed", async () => {
  const inner = new MockTransport();
  const transport = new MiddlewareTransport(inner, []);

  const received: Uint8Array[] = [];
  await transport.start((frame) => {
    received.push(new Uint8Array(frame));
  });

  await transport.send(new Uint8Array([0x01, 0x02]));
  await inner.emitInbound(new Uint8Array([0x03, 0x04]));

  assertEquals(inner.sent.length, 1);
  assertBytes(inner.sent[0], [0x01, 0x02]);
  assertEquals(received.length, 1);
  assertBytes(received[0], [0x03, 0x04]);

  await transport.close();
  assert(inner.closed, "inner transport should be closed");
});

Deno.test("MiddlewareTransport applies send middleware in order", async () => {
  const inner = new MockTransport();
  const order: string[] = [];

  const mw1: RpcTransportMiddleware = {
    onSend(frame) {
      order.push("mw1");
      // Append a byte to track transformation
      const out = new Uint8Array(frame.byteLength + 1);
      out.set(frame);
      out[frame.byteLength] = 0xaa;
      return out;
    },
  };

  const mw2: RpcTransportMiddleware = {
    onSend(frame) {
      order.push("mw2");
      const out = new Uint8Array(frame.byteLength + 1);
      out.set(frame);
      out[frame.byteLength] = 0xbb;
      return out;
    },
  };

  const transport = new MiddlewareTransport(inner, [mw1, mw2]);
  await transport.start(() => {});
  await transport.send(new Uint8Array([0x01]));

  assertEquals(order.length, 2);
  assertEquals(order[0], "mw1");
  assertEquals(order[1], "mw2");

  // mw1 appends 0xaa, mw2 appends 0xbb
  assertBytes(inner.sent[0], [0x01, 0xaa, 0xbb]);

  await transport.close();
});

Deno.test("MiddlewareTransport applies receive middleware in order", async () => {
  const inner = new MockTransport();
  const order: string[] = [];

  const mw1: RpcTransportMiddleware = {
    onReceive(frame) {
      order.push("mw1");
      const out = new Uint8Array(frame.byteLength + 1);
      out.set(frame);
      out[frame.byteLength] = 0xcc;
      return out;
    },
  };

  const mw2: RpcTransportMiddleware = {
    onReceive(frame) {
      order.push("mw2");
      const out = new Uint8Array(frame.byteLength + 1);
      out.set(frame);
      out[frame.byteLength] = 0xdd;
      return out;
    },
  };

  const transport = new MiddlewareTransport(inner, [mw1, mw2]);
  const received: Uint8Array[] = [];
  await transport.start((frame) => {
    received.push(new Uint8Array(frame));
  });

  await inner.emitInbound(new Uint8Array([0x10]));

  assertEquals(order.length, 2);
  assertEquals(order[0], "mw1");
  assertEquals(order[1], "mw2");

  // mw1 appends 0xcc, mw2 appends 0xdd
  assertBytes(received[0], [0x10, 0xcc, 0xdd]);

  await transport.close();
});

Deno.test("MiddlewareTransport: middleware returning null drops the send frame", async () => {
  const inner = new MockTransport();

  const dropper: RpcTransportMiddleware = {
    onSend(_frame) {
      return null;
    },
  };

  const shouldNotBeCalled: RpcTransportMiddleware = {
    onSend(_frame) {
      throw new Error("should not be called after drop");
    },
  };

  const transport = new MiddlewareTransport(inner, [
    dropper,
    shouldNotBeCalled,
  ]);
  await transport.start(() => {});
  await transport.send(new Uint8Array([0xff]));

  assertEquals(inner.sent.length, 0, "frame should be dropped, not sent");

  await transport.close();
});

Deno.test("MiddlewareTransport: middleware returning null drops the receive frame", async () => {
  const inner = new MockTransport();

  const dropper: RpcTransportMiddleware = {
    onReceive(_frame) {
      return null;
    },
  };

  const transport = new MiddlewareTransport(inner, [dropper]);
  const received: Uint8Array[] = [];
  await transport.start((frame) => {
    received.push(new Uint8Array(frame));
  });

  await inner.emitInbound(new Uint8Array([0x42]));

  assertEquals(received.length, 0, "frame should be dropped, not delivered");

  await transport.close();
});

Deno.test("MiddlewareTransport: middleware can throw to reject frames", async () => {
  const inner = new MockTransport();

  const rejecter: RpcTransportMiddleware = {
    onSend(_frame) {
      throw new TransportError("rejected by middleware");
    },
  };

  const transport = new MiddlewareTransport(inner, [rejecter]);
  await transport.start(() => {});

  let thrown: unknown;
  try {
    await transport.send(new Uint8Array([0x01]));
  } catch (err) {
    thrown = err;
  }

  assert(
    thrown instanceof TransportError &&
      /rejected by middleware/.test(thrown.message),
    `expected TransportError, got: ${String(thrown)}`,
  );
  assertEquals(inner.sent.length, 0, "frame should not reach inner transport");

  await transport.close();
});

Deno.test("MiddlewareTransport supports async middleware", async () => {
  const inner = new MockTransport();

  const asyncMw: RpcTransportMiddleware = {
    async onSend(frame) {
      // Simulate async work
      await Promise.resolve();
      const out = new Uint8Array(frame.byteLength + 1);
      out.set(frame);
      out[frame.byteLength] = 0xee;
      return out;
    },
    async onReceive(frame) {
      await Promise.resolve();
      const out = new Uint8Array(frame.byteLength + 1);
      out.set(frame);
      out[frame.byteLength] = 0xff;
      return out;
    },
  };

  const transport = new MiddlewareTransport(inner, [asyncMw]);
  const received: Uint8Array[] = [];
  await transport.start((frame) => {
    received.push(new Uint8Array(frame));
  });

  await transport.send(new Uint8Array([0x01]));
  await inner.emitInbound(new Uint8Array([0x02]));

  assertBytes(inner.sent[0], [0x01, 0xee]);
  assertBytes(received[0], [0x02, 0xff]);

  await transport.close();
});

Deno.test("MiddlewareTransport: middleware with only onSend does not affect receive", async () => {
  const inner = new MockTransport();

  const sendOnly: RpcTransportMiddleware = {
    onSend(frame) {
      const out = new Uint8Array(frame.byteLength + 1);
      out.set(frame);
      out[frame.byteLength] = 0x99;
      return out;
    },
  };

  const transport = new MiddlewareTransport(inner, [sendOnly]);
  const received: Uint8Array[] = [];
  await transport.start((frame) => {
    received.push(new Uint8Array(frame));
  });

  await transport.send(new Uint8Array([0x01]));
  await inner.emitInbound(new Uint8Array([0x02, 0x03]));

  // Send should be transformed
  assertBytes(inner.sent[0], [0x01, 0x99]);
  // Receive should pass through unchanged
  assertBytes(received[0], [0x02, 0x03]);

  await transport.close();
});

Deno.test("MiddlewareTransport: close delegates to inner transport", async () => {
  const inner = new MockTransport();
  const transport = new MiddlewareTransport(inner, []);

  await transport.start(() => {});
  assert(!inner.closed, "inner should not be closed yet");

  await transport.close();
  assert(inner.closed, "inner should be closed after close()");
});

// ---------------------------------------------------------------------------
// createLoggingMiddleware
// ---------------------------------------------------------------------------

Deno.test("createLoggingMiddleware logs send and receive with default prefix", async () => {
  const inner = new MockTransport();
  const messages: string[] = [];

  const mw = createLoggingMiddleware({
    log: (msg) => messages.push(msg),
  });

  const transport = new MiddlewareTransport(inner, [mw]);
  await transport.start(() => {});

  await transport.send(new Uint8Array(10));
  await inner.emitInbound(new Uint8Array(20));

  assertEquals(messages.length, 2);
  assert(
    messages[0].includes("[rpc]") && messages[0].includes("send") &&
      messages[0].includes("10"),
    `unexpected send log: ${messages[0]}`,
  );
  assert(
    messages[1].includes("[rpc]") && messages[1].includes("recv") &&
      messages[1].includes("20"),
    `unexpected recv log: ${messages[1]}`,
  );

  await transport.close();
});

Deno.test("createLoggingMiddleware uses custom prefix", async () => {
  const inner = new MockTransport();
  const messages: string[] = [];

  const mw = createLoggingMiddleware({
    log: (msg) => messages.push(msg),
    prefix: "[custom]",
  });

  const transport = new MiddlewareTransport(inner, [mw]);
  await transport.start(() => {});

  await transport.send(new Uint8Array(5));

  assert(
    messages[0].includes("[custom]"),
    `expected custom prefix, got: ${messages[0]}`,
  );

  await transport.close();
});

Deno.test("createLoggingMiddleware does not alter frame data", async () => {
  const inner = new MockTransport();

  const mw = createLoggingMiddleware({ log: () => {} });
  const transport = new MiddlewareTransport(inner, [mw]);
  const received: Uint8Array[] = [];
  await transport.start((frame) => {
    received.push(new Uint8Array(frame));
  });

  await transport.send(new Uint8Array([0x01, 0x02, 0x03]));
  await inner.emitInbound(new Uint8Array([0x04, 0x05]));

  assertBytes(inner.sent[0], [0x01, 0x02, 0x03]);
  assertBytes(received[0], [0x04, 0x05]);

  await transport.close();
});

// ---------------------------------------------------------------------------
// createFrameSizeLimitMiddleware
// ---------------------------------------------------------------------------

Deno.test("createFrameSizeLimitMiddleware passes frames under the limit", async () => {
  const inner = new MockTransport();

  const mw = createFrameSizeLimitMiddleware(100);
  const transport = new MiddlewareTransport(inner, [mw]);
  const received: Uint8Array[] = [];
  await transport.start((frame) => {
    received.push(new Uint8Array(frame));
  });

  await transport.send(new Uint8Array(50));
  await inner.emitInbound(new Uint8Array(80));

  assertEquals(inner.sent.length, 1);
  assertEquals(received.length, 1);

  await transport.close();
});

Deno.test("createFrameSizeLimitMiddleware rejects oversized send frames", async () => {
  const inner = new MockTransport();

  const mw = createFrameSizeLimitMiddleware(10);
  const transport = new MiddlewareTransport(inner, [mw]);
  await transport.start(() => {});

  let thrown: unknown;
  try {
    await transport.send(new Uint8Array(20));
  } catch (err) {
    thrown = err;
  }

  assert(
    thrown instanceof TransportError &&
      /exceeds limit/.test(thrown.message) &&
      /send/.test(thrown.message),
    `expected TransportError with 'send' detail, got: ${String(thrown)}`,
  );
  assertEquals(inner.sent.length, 0);

  await transport.close();
});

Deno.test("createFrameSizeLimitMiddleware rejects oversized receive frames", async () => {
  const inner = new MockTransport();

  const mw = createFrameSizeLimitMiddleware(10);
  const transport = new MiddlewareTransport(inner, [mw]);

  let thrown: unknown;
  await transport.start(() => {});

  try {
    await inner.emitInbound(new Uint8Array(20));
  } catch (err) {
    thrown = err;
  }

  assert(
    thrown instanceof TransportError &&
      /exceeds limit/.test(thrown.message) &&
      /receive/.test(thrown.message),
    `expected TransportError with 'receive' detail, got: ${String(thrown)}`,
  );

  await transport.close();
});

Deno.test("createFrameSizeLimitMiddleware respects direction 'send'", async () => {
  const inner = new MockTransport();

  const mw = createFrameSizeLimitMiddleware(10, { direction: "send" });
  const transport = new MiddlewareTransport(inner, [mw]);
  const received: Uint8Array[] = [];
  await transport.start((frame) => {
    received.push(new Uint8Array(frame));
  });

  // Large receive should pass through
  await inner.emitInbound(new Uint8Array(100));
  assertEquals(received.length, 1);

  // Large send should be rejected
  let thrown: unknown;
  try {
    await transport.send(new Uint8Array(20));
  } catch (err) {
    thrown = err;
  }

  assert(
    thrown instanceof TransportError,
    `expected TransportError, got: ${String(thrown)}`,
  );

  await transport.close();
});

Deno.test("createFrameSizeLimitMiddleware respects direction 'receive'", async () => {
  const inner = new MockTransport();

  const mw = createFrameSizeLimitMiddleware(10, { direction: "receive" });
  const transport = new MiddlewareTransport(inner, [mw]);
  await transport.start(() => {});

  // Large send should pass through
  await transport.send(new Uint8Array(100));
  assertEquals(inner.sent.length, 1);

  // Large receive should be rejected
  let thrown: unknown;
  try {
    await inner.emitInbound(new Uint8Array(20));
  } catch (err) {
    thrown = err;
  }

  assert(
    thrown instanceof TransportError,
    `expected TransportError, got: ${String(thrown)}`,
  );

  await transport.close();
});

Deno.test("createFrameSizeLimitMiddleware allows frames at exactly the limit", async () => {
  const inner = new MockTransport();

  const mw = createFrameSizeLimitMiddleware(10);
  const transport = new MiddlewareTransport(inner, [mw]);
  await transport.start(() => {});

  // Exactly 10 bytes should be allowed
  await transport.send(new Uint8Array(10));
  assertEquals(inner.sent.length, 1);

  await transport.close();
});

// ---------------------------------------------------------------------------
// Composability: stacking multiple middleware
// ---------------------------------------------------------------------------

Deno.test("multiple middleware compose correctly", async () => {
  const inner = new MockTransport();
  const messages: string[] = [];

  // Stack: logging first, then size limit
  const logging = createLoggingMiddleware({
    log: (msg) => messages.push(msg),
  });
  const sizeLimit = createFrameSizeLimitMiddleware(10);

  const transport = new MiddlewareTransport(inner, [logging, sizeLimit]);
  await transport.start(() => {});

  // Small frame: logged, then passes size check
  await transport.send(new Uint8Array(5));
  assertEquals(inner.sent.length, 1);
  assertEquals(messages.length, 1);

  // Large frame: logged, then rejected by size check
  let thrown: unknown;
  try {
    await transport.send(new Uint8Array(20));
  } catch (err) {
    thrown = err;
  }

  assert(
    thrown instanceof TransportError,
    `expected TransportError, got: ${String(thrown)}`,
  );
  // Logging middleware ran before size limit rejected
  assertEquals(messages.length, 2);
  assertEquals(inner.sent.length, 1, "oversized frame should not be sent");

  await transport.close();
});

Deno.test("MiddlewareTransport can be nested (middleware wrapping middleware)", async () => {
  const inner = new MockTransport();
  const order: string[] = [];

  const mw1: RpcTransportMiddleware = {
    onSend() {
      order.push("inner-mw");
      return new Uint8Array([0x01]);
    },
  };

  const mw2: RpcTransportMiddleware = {
    onSend() {
      order.push("outer-mw");
      return new Uint8Array([0x02]);
    },
  };

  const innerWrapped = new MiddlewareTransport(inner, [mw1]);
  const outerWrapped = new MiddlewareTransport(innerWrapped, [mw2]);

  await outerWrapped.start(() => {});
  await outerWrapped.send(new Uint8Array([0xff]));

  // Outer middleware runs first, then inner middleware
  assertEquals(order.length, 2);
  assertEquals(order[0], "outer-mw");
  assertEquals(order[1], "inner-mw");

  await outerWrapped.close();
});

// ---------------------------------------------------------------------------
// Middleware array is defensively copied
// ---------------------------------------------------------------------------

Deno.test("MiddlewareTransport defensively copies the middleware array", async () => {
  const inner = new MockTransport();
  const middlewareArray: RpcTransportMiddleware[] = [];

  const transport = new MiddlewareTransport(inner, middlewareArray);

  // Mutating the original array after construction should not affect behavior
  middlewareArray.push({
    onSend(_frame) {
      throw new Error("should not be called");
    },
  });

  await transport.start(() => {});
  await transport.send(new Uint8Array([0x01]));

  assertEquals(inner.sent.length, 1, "frame should pass through unmodified");

  await transport.close();
});
