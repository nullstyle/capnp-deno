import {
  createFrameSizeLimitMiddleware,
  createLoggingMiddleware,
  createRpcIntrospectionMiddleware,
  createRpcMetricsMiddleware,
  encodeBootstrapRequestFrame,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  encodeReturnResultsFrame,
  MiddlewareTransport,
  type RpcFrameDirection,
  type RpcMetricsSnapshot,
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

// ---------------------------------------------------------------------------
// createRpcIntrospectionMiddleware
// ---------------------------------------------------------------------------

Deno.test("createRpcIntrospectionMiddleware identifies bootstrap messages", async () => {
  const inner = new MockTransport();
  const observed: { type: string; direction: RpcFrameDirection }[] = [];

  const mw = createRpcIntrospectionMiddleware({
    onBootstrap(_frame, dir) {
      observed.push({ type: "bootstrap", direction: dir });
    },
  });

  const transport = new MiddlewareTransport(inner, [mw]);
  await transport.start(() => {});

  const bootstrapFrame = encodeBootstrapRequestFrame({ questionId: 1 });
  await transport.send(bootstrapFrame);
  await inner.emitInbound(bootstrapFrame);

  assertEquals(observed.length, 2);
  assertEquals(observed[0].type, "bootstrap");
  assertEquals(observed[0].direction, "send");
  assertEquals(observed[1].type, "bootstrap");
  assertEquals(observed[1].direction, "receive");

  await transport.close();
});

Deno.test("createRpcIntrospectionMiddleware identifies call messages", async () => {
  const inner = new MockTransport();
  const observed: string[] = [];

  const mw = createRpcIntrospectionMiddleware({
    onCall(_frame, dir) {
      observed.push(`call-${dir}`);
    },
  });

  const transport = new MiddlewareTransport(inner, [mw]);
  await transport.start(() => {});

  const callFrame = encodeCallRequestFrame({
    questionId: 1,
    interfaceId: 0x1234n,
    methodId: 0,
    targetImportedCap: 0,
  });
  await transport.send(callFrame);

  assertEquals(observed.length, 1);
  assertEquals(observed[0], "call-send");

  await transport.close();
});

Deno.test("createRpcIntrospectionMiddleware identifies return messages", async () => {
  const inner = new MockTransport();
  const observed: string[] = [];

  const mw = createRpcIntrospectionMiddleware({
    onReturn(_frame, dir) {
      observed.push(`return-${dir}`);
    },
  });

  const transport = new MiddlewareTransport(inner, [mw]);
  await transport.start(() => {});

  const returnFrame = encodeReturnResultsFrame({ answerId: 1 });
  await inner.emitInbound(returnFrame);

  assertEquals(observed.length, 1);
  assertEquals(observed[0], "return-receive");

  await transport.close();
});

Deno.test("createRpcIntrospectionMiddleware identifies finish messages", async () => {
  const inner = new MockTransport();
  const observed: string[] = [];

  const mw = createRpcIntrospectionMiddleware({
    onFinish(_frame, dir) {
      observed.push(`finish-${dir}`);
    },
  });

  const transport = new MiddlewareTransport(inner, [mw]);
  await transport.start(() => {});

  const finishFrame = encodeFinishFrame({ questionId: 1 });
  await transport.send(finishFrame);

  assertEquals(observed.length, 1);
  assertEquals(observed[0], "finish-send");

  await transport.close();
});

Deno.test("createRpcIntrospectionMiddleware identifies release messages", async () => {
  const inner = new MockTransport();
  const observed: string[] = [];

  const mw = createRpcIntrospectionMiddleware({
    onRelease(_frame, dir) {
      observed.push(`release-${dir}`);
    },
  });

  const transport = new MiddlewareTransport(inner, [mw]);
  await transport.start(() => {});

  const releaseFrame = encodeReleaseFrame({ id: 1, referenceCount: 1 });
  await transport.send(releaseFrame);

  assertEquals(observed.length, 1);
  assertEquals(observed[0], "release-send");

  await transport.close();
});

Deno.test("createRpcIntrospectionMiddleware handles decode errors gracefully", async () => {
  const inner = new MockTransport();
  const errors: { error: unknown; direction: RpcFrameDirection }[] = [];

  const mw = createRpcIntrospectionMiddleware({
    onDecodeError(_frame, err, dir) {
      errors.push({ error: err, direction: dir });
    },
    onBootstrap() {
      throw new Error("should not be called on garbage data");
    },
  });

  const transport = new MiddlewareTransport(inner, [mw]);
  const received: Uint8Array[] = [];
  await transport.start((frame) => {
    received.push(new Uint8Array(frame));
  });

  // Send garbage data that can't be decoded as a Cap'n Proto message
  const garbage = new Uint8Array([0x01, 0x02, 0x03]);
  await transport.send(garbage);
  await inner.emitInbound(garbage);

  assertEquals(errors.length, 2);
  assertEquals(errors[0].direction, "send");
  assertEquals(errors[1].direction, "receive");

  // The frame should still pass through unchanged
  assertEquals(inner.sent.length, 1);
  assertBytes(inner.sent[0], [0x01, 0x02, 0x03]);
  assertEquals(received.length, 1);
  assertBytes(received[0], [0x01, 0x02, 0x03]);

  await transport.close();
});

Deno.test("createRpcIntrospectionMiddleware does not modify frames", async () => {
  const inner = new MockTransport();

  const mw = createRpcIntrospectionMiddleware({
    onBootstrap() {},
    onCall() {},
    onReturn() {},
    onFinish() {},
    onRelease() {},
  });

  const transport = new MiddlewareTransport(inner, [mw]);
  const received: Uint8Array[] = [];
  await transport.start((frame) => {
    received.push(new Uint8Array(frame));
  });

  const bootstrapFrame = encodeBootstrapRequestFrame({ questionId: 42 });
  const originalBytes = new Uint8Array(bootstrapFrame);

  await transport.send(bootstrapFrame);
  assertBytes(inner.sent[0], [...originalBytes]);

  await inner.emitInbound(bootstrapFrame);
  assertBytes(received[0], [...originalBytes]);

  await transport.close();
});

Deno.test("createRpcIntrospectionMiddleware calls onUnknown for unrecognized tags", async () => {
  const inner = new MockTransport();
  const unknowns: { tag: number; direction: RpcFrameDirection }[] = [];

  const mw = createRpcIntrospectionMiddleware({
    onUnknown(_frame, tag, dir) {
      unknowns.push({ tag, direction: dir });
    },
  });

  const transport = new MiddlewareTransport(inner, [mw]);
  await transport.start(() => {});

  // Build a valid Cap'n Proto frame with tag=99 (not a known RPC message type).
  // We can repurpose the bootstrap frame structure but patch the tag.
  const frame = encodeBootstrapRequestFrame({ questionId: 1 });
  // The message tag is at a known location: after the 8-byte framing header,
  // the root struct pointer (word 0) points to word 1 where data starts.
  // For bootstrap, the struct data starts at word 1 (after root pointer).
  // The tag u16 is at byte offset 0 of that struct's data section.
  // In a single-segment message with header [0,0,0,0, N,0,0,0], segment
  // starts at byte 8. Root pointer is word 0 of segment. The struct it
  // points to starts at word 1, i.e., byte 8 + 8 = 16.
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint16(16, 99, true); // overwrite the tag to 99

  await transport.send(frame);

  assertEquals(unknowns.length, 1);
  assertEquals(unknowns[0].tag, 99);
  assertEquals(unknowns[0].direction, "send");

  await transport.close();
});

// ---------------------------------------------------------------------------
// createRpcMetricsMiddleware
// ---------------------------------------------------------------------------

Deno.test("createRpcMetricsMiddleware tracks counts and bytes for sent frames", async () => {
  const inner = new MockTransport();
  const metrics = createRpcMetricsMiddleware();

  const transport = new MiddlewareTransport(inner, [metrics.middleware]);
  await transport.start(() => {});

  const bootstrapFrame = encodeBootstrapRequestFrame({ questionId: 1 });
  await transport.send(bootstrapFrame);

  const snap = metrics.snapshot();
  assertEquals(snap.totalFramesSent, 1);
  assertEquals(snap.totalFramesReceived, 0);
  assertEquals(snap.totalBytesSent, bootstrapFrame.byteLength);
  assertEquals(snap.totalBytesReceived, 0);
  assertEquals(snap.framesByType.bootstrap, 1);
  assertEquals(snap.framesByType.call, 0);
  assertEquals(snap.framesByType.return, 0);
  assertEquals(snap.framesByType.finish, 0);
  assertEquals(snap.framesByType.release, 0);
  assertEquals(snap.framesByType.unknown, 0);

  await transport.close();
});

Deno.test("createRpcMetricsMiddleware tracks counts and bytes for received frames", async () => {
  const inner = new MockTransport();
  const metrics = createRpcMetricsMiddleware();

  const transport = new MiddlewareTransport(inner, [metrics.middleware]);
  await transport.start(() => {});

  const returnFrame = encodeReturnResultsFrame({ answerId: 1 });
  await inner.emitInbound(returnFrame);

  const snap = metrics.snapshot();
  assertEquals(snap.totalFramesSent, 0);
  assertEquals(snap.totalFramesReceived, 1);
  assertEquals(snap.totalBytesSent, 0);
  assertEquals(snap.totalBytesReceived, returnFrame.byteLength);
  assertEquals(snap.framesByType.return, 1);

  await transport.close();
});

Deno.test("createRpcMetricsMiddleware tracks multiple message types", async () => {
  const inner = new MockTransport();
  const metrics = createRpcMetricsMiddleware();

  const transport = new MiddlewareTransport(inner, [metrics.middleware]);
  await transport.start(() => {});

  await transport.send(encodeBootstrapRequestFrame({ questionId: 1 }));
  await transport.send(
    encodeCallRequestFrame({
      questionId: 2,
      interfaceId: 0x1234n,
      methodId: 0,
      targetImportedCap: 0,
    }),
  );
  await transport.send(encodeFinishFrame({ questionId: 1 }));
  await transport.send(encodeReleaseFrame({ id: 0, referenceCount: 1 }));
  await inner.emitInbound(encodeReturnResultsFrame({ answerId: 2 }));

  const snap = metrics.snapshot();
  assertEquals(snap.totalFramesSent, 4);
  assertEquals(snap.totalFramesReceived, 1);
  assertEquals(snap.framesByType.bootstrap, 1);
  assertEquals(snap.framesByType.call, 1);
  assertEquals(snap.framesByType.finish, 1);
  assertEquals(snap.framesByType.release, 1);
  assertEquals(snap.framesByType.return, 1);
  assertEquals(snap.framesByType.unknown, 0);

  await transport.close();
});

Deno.test("createRpcMetricsMiddleware counts undecoded frames as unknown", async () => {
  const inner = new MockTransport();
  const metrics = createRpcMetricsMiddleware();

  const transport = new MiddlewareTransport(inner, [metrics.middleware]);
  await transport.start(() => {});

  // Garbage data that can't be decoded
  await transport.send(new Uint8Array([0x01]));

  const snap = metrics.snapshot();
  assertEquals(snap.totalFramesSent, 1);
  assertEquals(snap.framesByType.unknown, 1);

  await transport.close();
});

Deno.test("createRpcMetricsMiddleware reset clears all counters", async () => {
  const inner = new MockTransport();
  const metrics = createRpcMetricsMiddleware();

  const transport = new MiddlewareTransport(inner, [metrics.middleware]);
  await transport.start(() => {});

  await transport.send(encodeBootstrapRequestFrame({ questionId: 1 }));
  await inner.emitInbound(encodeReturnResultsFrame({ answerId: 1 }));

  // Verify non-zero before reset
  let snap = metrics.snapshot();
  assert(snap.totalFramesSent > 0, "should have sent frames");
  assert(snap.totalFramesReceived > 0, "should have received frames");

  metrics.reset();
  snap = metrics.snapshot();
  assertEquals(snap.totalFramesSent, 0);
  assertEquals(snap.totalFramesReceived, 0);
  assertEquals(snap.totalBytesSent, 0);
  assertEquals(snap.totalBytesReceived, 0);
  assertEquals(snap.framesByType.bootstrap, 0);
  assertEquals(snap.framesByType.call, 0);
  assertEquals(snap.framesByType.return, 0);
  assertEquals(snap.framesByType.finish, 0);
  assertEquals(snap.framesByType.release, 0);
  assertEquals(snap.framesByType.unknown, 0);

  await transport.close();
});

Deno.test("createRpcMetricsMiddleware snapshot returns independent copies", async () => {
  const inner = new MockTransport();
  const metrics = createRpcMetricsMiddleware();

  const transport = new MiddlewareTransport(inner, [metrics.middleware]);
  await transport.start(() => {});

  await transport.send(encodeBootstrapRequestFrame({ questionId: 1 }));

  const snap1 = metrics.snapshot();
  assertEquals(snap1.totalFramesSent, 1);

  await transport.send(encodeBootstrapRequestFrame({ questionId: 2 }));

  const snap2 = metrics.snapshot();
  assertEquals(snap2.totalFramesSent, 2);
  // snap1 should not have changed
  assertEquals(snap1.totalFramesSent, 1);

  await transport.close();
});

Deno.test("createRpcMetricsMiddleware onSnapshot fires at correct interval", async () => {
  const inner = new MockTransport();
  const snapshots: RpcMetricsSnapshot[] = [];

  const metrics = createRpcMetricsMiddleware({
    snapshotIntervalFrames: 3,
    onSnapshot(snap) {
      snapshots.push(snap);
    },
  });

  const transport = new MiddlewareTransport(inner, [metrics.middleware]);
  await transport.start(() => {});

  const bootstrapFrame = encodeBootstrapRequestFrame({ questionId: 1 });

  // Send 7 frames; snapshots should fire after frame 3 and frame 6
  for (let i = 0; i < 7; i++) {
    await transport.send(bootstrapFrame);
  }

  assertEquals(snapshots.length, 2);
  assertEquals(snapshots[0].totalFramesSent, 3);
  assertEquals(snapshots[1].totalFramesSent, 6);

  await transport.close();
});

Deno.test("createRpcMetricsMiddleware onSnapshot counts both send and receive", async () => {
  const inner = new MockTransport();
  const snapshots: RpcMetricsSnapshot[] = [];

  const metrics = createRpcMetricsMiddleware({
    snapshotIntervalFrames: 2,
    onSnapshot(snap) {
      snapshots.push(snap);
    },
  });

  const transport = new MiddlewareTransport(inner, [metrics.middleware]);
  await transport.start(() => {});

  const bootstrapFrame = encodeBootstrapRequestFrame({ questionId: 1 });

  // 1 send + 1 receive = 2 total, should trigger snapshot
  await transport.send(bootstrapFrame);
  await inner.emitInbound(bootstrapFrame);

  assertEquals(snapshots.length, 1);
  assertEquals(snapshots[0].totalFramesSent, 1);
  assertEquals(snapshots[0].totalFramesReceived, 1);

  await transport.close();
});

Deno.test("createRpcMetricsMiddleware does not modify frames", async () => {
  const inner = new MockTransport();
  const metrics = createRpcMetricsMiddleware();

  const transport = new MiddlewareTransport(inner, [metrics.middleware]);
  const received: Uint8Array[] = [];
  await transport.start((frame) => {
    received.push(new Uint8Array(frame));
  });

  const bootstrapFrame = encodeBootstrapRequestFrame({ questionId: 42 });
  const originalBytes = new Uint8Array(bootstrapFrame);

  await transport.send(bootstrapFrame);
  assertBytes(inner.sent[0], [...originalBytes]);

  await inner.emitInbound(bootstrapFrame);
  assertBytes(received[0], [...originalBytes]);

  await transport.close();
});
