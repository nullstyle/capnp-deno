/**
 * Contract tests for the RpcTransport interface.
 *
 * These tests verify the behavioral contract that all RpcTransport
 * implementations must uphold:
 *
 *   - start() must be called exactly once before send()
 *   - start() on a closed transport throws
 *   - start() called twice throws
 *   - send() before start() throws
 *   - send() after close() throws
 *   - close() is idempotent
 *   - onFrame callback receives frames in order
 *   - close() during pending send() rejects cleanly
 *   - Error in onFrame callback propagates
 *   - Transport reports closed state correctly
 *
 * Uses a minimal ContractTestTransport that implements the full RpcTransport
 * contract without any external dependencies, making these tests
 * environment-independent.
 */

import { TransportError } from "../mod.ts";
import type { RpcTransport } from "../mod.ts";
import {
  assert,
  assertBytes,
  assertEquals,
  assertThrows,
  deferred,
  withTimeout,
} from "./test_utils.ts";

// ---------------------------------------------------------------------------
// Minimal RpcTransport implementation for contract testing
// ---------------------------------------------------------------------------

/**
 * A minimal in-memory transport that faithfully implements the RpcTransport
 * contract. It exposes helpers for injecting inbound frames and inspecting
 * outbound frames.
 */
class ContractTestTransport implements RpcTransport {
  #started = false;
  #closed = false;
  #onFrame: ((frame: Uint8Array) => void | Promise<void>) | null = null;

  /** Outbound frames sent through send(). */
  readonly sent: Uint8Array[] = [];

  /** Optional hook: called for each send(). If it returns a promise,
   *  that promise is awaited before the send resolves. Throw to simulate
   *  a send failure. */
  onSend: ((frame: Uint8Array) => void | Promise<void>) | null = null;

  /** Optional delay (ms) inserted during send() to simulate async sends. */
  sendDelayMs = 0;

  get started(): boolean {
    return this.#started;
  }

  get closed(): boolean {
    return this.#closed;
  }

  start(
    onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): void {
    if (this.#closed) {
      throw new TransportError("ContractTestTransport is closed");
    }
    if (this.#started) {
      throw new TransportError("ContractTestTransport already started");
    }
    this.#started = true;
    this.#onFrame = onFrame;
  }

  async send(frame: Uint8Array): Promise<void> {
    if (!this.#started) {
      throw new TransportError("ContractTestTransport not started");
    }
    if (this.#closed) {
      throw new TransportError("ContractTestTransport is closed");
    }

    if (this.sendDelayMs > 0) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, this.sendDelayMs)
      );
    }

    // Re-check closed state after any async gap.
    if (this.#closed) {
      throw new TransportError("ContractTestTransport is closed");
    }

    if (this.onSend) {
      await this.onSend(frame);
    }

    this.sent.push(new Uint8Array(frame));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onFrame = null;
  }

  /**
   * Inject a frame as if it were received from the remote peer.
   * Throws if the transport is not started or is closed.
   */
  async emitInbound(frame: Uint8Array): Promise<void> {
    if (this.#closed) {
      throw new TransportError("ContractTestTransport is closed");
    }
    if (!this.#onFrame) {
      throw new TransportError("ContractTestTransport is not started");
    }
    await this.#onFrame(new Uint8Array(frame));
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeTransport(): ContractTestTransport {
  return new ContractTestTransport();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// -- Lifecycle: start() -----------------------------------------------------

Deno.test("transport contract: start() called twice throws", () => {
  const t = makeTransport();
  t.start((_frame) => {});
  assertThrows(
    () => t.start((_frame) => {}),
    /already started/i,
  );
});

Deno.test("transport contract: start() on closed transport throws", () => {
  const t = makeTransport();
  t.close();
  assertThrows(
    () => t.start((_frame) => {}),
    /is closed/i,
  );
});

// -- Lifecycle: send() before start() ---------------------------------------

Deno.test("transport contract: send() before start() throws", async () => {
  const t = makeTransport();
  let thrown: unknown;
  try {
    await t.send(new Uint8Array([0x01]));
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof TransportError &&
      /not started/i.test(thrown.message),
    `expected send-before-start error, got: ${String(thrown)}`,
  );
});

// -- Lifecycle: send() after close() ----------------------------------------

Deno.test("transport contract: send() after close() throws", async () => {
  const t = makeTransport();
  t.start((_frame) => {});
  t.close();

  let thrown: unknown;
  try {
    await t.send(new Uint8Array([0xab]));
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof TransportError &&
      /is closed/i.test(thrown.message),
    `expected send-after-close error, got: ${String(thrown)}`,
  );
});

// -- Lifecycle: close() idempotent ------------------------------------------

Deno.test("transport contract: close() is idempotent", () => {
  const t = makeTransport();
  t.start((_frame) => {});

  // Calling close multiple times must not throw.
  t.close();
  t.close();
  t.close();

  assertEquals(t.closed, true);
});

Deno.test("transport contract: close() before start() is idempotent", () => {
  const t = makeTransport();
  // Never started — close should still be safe.
  t.close();
  t.close();
  assertEquals(t.closed, true);
});

// -- onFrame ordering -------------------------------------------------------

Deno.test("transport contract: onFrame callback receives frames in order", async () => {
  const t = makeTransport();
  const received: Uint8Array[] = [];

  t.start((frame) => {
    received.push(new Uint8Array(frame));
  });

  await t.emitInbound(new Uint8Array([0x01]));
  await t.emitInbound(new Uint8Array([0x02]));
  await t.emitInbound(new Uint8Array([0x03]));

  assertEquals(received.length, 3);
  assertEquals(received[0][0], 0x01);
  assertEquals(received[1][0], 0x02);
  assertEquals(received[2][0], 0x03);
});

Deno.test("transport contract: onFrame receives multi-byte frames intact", async () => {
  const t = makeTransport();
  const received: Uint8Array[] = [];

  t.start((frame) => {
    received.push(new Uint8Array(frame));
  });

  await t.emitInbound(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  assertEquals(received.length, 1);
  assertBytes(received[0], [0xde, 0xad, 0xbe, 0xef]);
});

// -- close() during pending send() ------------------------------------------

Deno.test("transport contract: close() during pending send() rejects cleanly", async () => {
  const t = makeTransport();
  t.sendDelayMs = 50; // simulate slow send

  t.start((_frame) => {});

  const sendPromise = t.send(new Uint8Array([0xaa]));

  // Close while the send is still in-flight.
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  t.close();

  let thrown: unknown;
  try {
    await sendPromise;
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof TransportError &&
      /is closed/i.test(thrown.message),
    `expected closed error from pending send, got: ${String(thrown)}`,
  );
});

// -- Error in onFrame callback propagates -----------------------------------

Deno.test("transport contract: error in onFrame callback propagates through emitInbound", async () => {
  const t = makeTransport();
  const expectedError = new Error("callback exploded");

  t.start((_frame) => {
    throw expectedError;
  });

  let thrown: unknown;
  try {
    await t.emitInbound(new Uint8Array([0x01]));
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown === expectedError,
    `expected the original callback error to propagate, got: ${String(thrown)}`,
  );
});

Deno.test("transport contract: async error in onFrame callback propagates", async () => {
  const t = makeTransport();
  const expectedError = new Error("async callback exploded");

  t.start(async (_frame) => {
    await Promise.resolve();
    throw expectedError;
  });

  let thrown: unknown;
  try {
    await t.emitInbound(new Uint8Array([0x02]));
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown === expectedError,
    `expected async callback error to propagate, got: ${String(thrown)}`,
  );
});

// -- Transport reports closed state -----------------------------------------

Deno.test("transport contract: transport reports closed state correctly", () => {
  const t = makeTransport();

  assertEquals(t.closed, false);
  assertEquals(t.started, false);

  t.start((_frame) => {});
  assertEquals(t.started, true);
  assertEquals(t.closed, false);

  t.close();
  assertEquals(t.closed, true);
});

Deno.test("transport contract: closed transport rejects emitInbound", async () => {
  const t = makeTransport();
  t.start((_frame) => {});
  t.close();

  let thrown: unknown;
  try {
    await t.emitInbound(new Uint8Array([0x01]));
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof TransportError &&
      /is closed/i.test(thrown.message),
    `expected emitInbound on closed transport to throw, got: ${String(thrown)}`,
  );
});

// -- send() records outbound frames -----------------------------------------

Deno.test("transport contract: send() records outbound frames in order", async () => {
  const t = makeTransport();
  t.start((_frame) => {});

  await t.send(new Uint8Array([0x0a]));
  await t.send(new Uint8Array([0x0b]));
  await t.send(new Uint8Array([0x0c]));

  assertEquals(t.sent.length, 3);
  assertEquals(t.sent[0][0], 0x0a);
  assertEquals(t.sent[1][0], 0x0b);
  assertEquals(t.sent[2][0], 0x0c);
});

Deno.test("transport contract: send() copies frame data for isolation", async () => {
  const t = makeTransport();
  t.start((_frame) => {});

  const original = new Uint8Array([0x01, 0x02, 0x03]);
  await t.send(original);

  // Mutate original after send.
  original[0] = 0xff;

  // Recorded frame should not reflect the mutation.
  assertEquals(t.sent[0][0], 0x01);
  assertEquals(t.sent[0][1], 0x02);
  assertEquals(t.sent[0][2], 0x03);
});

// -- send() error propagation -----------------------------------------------

Deno.test("transport contract: send() error propagation via onSend hook", async () => {
  const t = makeTransport();
  const sendError = new Error("send exploded");
  t.onSend = () => {
    throw sendError;
  };

  t.start((_frame) => {});

  let thrown: unknown;
  try {
    await t.send(new Uint8Array([0x01]));
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown === sendError,
    `expected send error to propagate, got: ${String(thrown)}`,
  );
  // Frame should not have been recorded since the hook threw before recording.
  assertEquals(t.sent.length, 0);
});

// -- Multiple rapid sends ---------------------------------------------------

Deno.test("transport contract: multiple concurrent sends complete in order", async () => {
  const t = makeTransport();
  t.start((_frame) => {});

  const promises: Promise<void>[] = [];
  for (let i = 0; i < 10; i++) {
    promises.push(t.send(new Uint8Array([i])));
  }

  await Promise.all(promises);

  assertEquals(t.sent.length, 10);
  for (let i = 0; i < 10; i++) {
    assertEquals(t.sent[i][0], i);
  }
});

// -- Empty frame handling ---------------------------------------------------

Deno.test("transport contract: send() accepts empty frames", async () => {
  const t = makeTransport();
  t.start((_frame) => {});

  await t.send(new Uint8Array([]));
  assertEquals(t.sent.length, 1);
  assertEquals(t.sent[0].length, 0);
});

Deno.test("transport contract: onFrame receives empty frames", async () => {
  const t = makeTransport();
  const received: Uint8Array[] = [];

  t.start((frame) => {
    received.push(new Uint8Array(frame));
  });

  await t.emitInbound(new Uint8Array([]));
  assertEquals(received.length, 1);
  assertEquals(received[0].length, 0);
});

// -- Full lifecycle sequence ------------------------------------------------

Deno.test("transport contract: full lifecycle — start, send, receive, close", async () => {
  const t = makeTransport();
  const received: Uint8Array[] = [];

  // Phase 1: start
  t.start((frame) => {
    received.push(new Uint8Array(frame));
  });
  assertEquals(t.started, true);
  assertEquals(t.closed, false);

  // Phase 2: send outbound
  await t.send(new Uint8Array([0x10, 0x20]));
  assertEquals(t.sent.length, 1);
  assertBytes(t.sent[0], [0x10, 0x20]);

  // Phase 3: receive inbound
  await t.emitInbound(new Uint8Array([0x30, 0x40]));
  assertEquals(received.length, 1);
  assertBytes(received[0], [0x30, 0x40]);

  // Phase 4: close
  t.close();
  assertEquals(t.closed, true);

  // Phase 5: post-close operations fail
  let sendThrown: unknown;
  try {
    await t.send(new Uint8Array([0xff]));
  } catch (error) {
    sendThrown = error;
  }
  assert(
    sendThrown instanceof TransportError,
    "expected send after close to throw TransportError",
  );

  let emitThrown: unknown;
  try {
    await t.emitInbound(new Uint8Array([0xff]));
  } catch (error) {
    emitThrown = error;
  }
  assert(
    emitThrown instanceof TransportError,
    "expected emitInbound after close to throw TransportError",
  );
});

// -- onFrame callback with async backpressure -------------------------------

Deno.test("transport contract: onFrame async callback is awaited before next frame", async () => {
  const t = makeTransport();
  const order: number[] = [];
  const gate = deferred<void>();

  t.start(async (frame) => {
    const val = frame[0];
    if (val === 0x01) {
      // Block first frame until gate opens
      await gate.promise;
    }
    order.push(val);
  });

  // Emit first frame (will block on gate)
  const first = t.emitInbound(new Uint8Array([0x01]));

  // The second emit cannot proceed until the first completes because
  // emitInbound awaits the callback.
  const second = (async () => {
    await first;
    await t.emitInbound(new Uint8Array([0x02]));
  })();

  // Nothing should have been processed yet.
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assertEquals(order.length, 0);

  // Release the gate.
  gate.resolve();

  await withTimeout(
    Promise.all([first, second]),
    1000,
    "async backpressure test",
  );

  assertEquals(order.length, 2);
  assertEquals(order[0], 0x01);
  assertEquals(order[1], 0x02);
});

// -- close() clears onFrame -------------------------------------------------

Deno.test("transport contract: close() prevents further onFrame delivery", async () => {
  const t = makeTransport();
  const received: Uint8Array[] = [];

  t.start((frame) => {
    received.push(new Uint8Array(frame));
  });

  await t.emitInbound(new Uint8Array([0x01]));
  assertEquals(received.length, 1);

  t.close();

  // Attempting to emit after close should throw.
  let thrown: unknown;
  try {
    await t.emitInbound(new Uint8Array([0x02]));
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof TransportError,
    "expected emitInbound after close to throw",
  );

  // The second frame should not have been delivered.
  assertEquals(received.length, 1);
});

// -- start() after close() --------------------------------------------------

Deno.test("transport contract: start() after close() throws (cannot restart)", () => {
  const t = makeTransport();
  t.start((_frame) => {});
  t.close();

  assertThrows(
    () => t.start((_frame) => {}),
    /is closed/i,
  );
});

// -- emitInbound before start() ---------------------------------------------

Deno.test("transport contract: emitInbound before start() throws", async () => {
  const t = makeTransport();
  let thrown: unknown;
  try {
    await t.emitInbound(new Uint8Array([0x01]));
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof TransportError &&
      /not started/i.test(thrown.message),
    `expected not-started error from emitInbound, got: ${String(thrown)}`,
  );
});

// -- Verify MessagePortTransport against contract ---------------------------
// These tests verify that the real MessagePortTransport implementation
// also conforms to the same contract expectations tested above.

Deno.test("transport contract: MessagePortTransport send-after-close throws TransportError", async () => {
  const { MessagePortTransport } = await import("../mod.ts");
  const channel = new MessageChannel();
  const transport = new MessagePortTransport(channel.port1, {
    closePortOnClose: true,
  });

  transport.start((_frame) => {});
  transport.close();

  let thrown: unknown;
  try {
    await transport.send(new Uint8Array([0x01]));
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof TransportError &&
      /is closed/i.test(thrown.message),
    `expected TransportError from MessagePortTransport send-after-close, got: ${
      String(thrown)
    }`,
  );
  channel.port2.close();
});

Deno.test("transport contract: MessagePortTransport close() is idempotent", async () => {
  const { MessagePortTransport } = await import("../mod.ts");
  const channel = new MessageChannel();
  const transport = new MessagePortTransport(channel.port1, {
    closePortOnClose: true,
  });

  transport.start((_frame) => {});

  // Calling close multiple times must not throw.
  transport.close();
  transport.close();
  transport.close();

  channel.port2.close();
});

Deno.test("transport contract: MessagePortTransport start-twice throws TransportError", async () => {
  const { MessagePortTransport } = await import("../mod.ts");
  const channel = new MessageChannel();
  const transport = new MessagePortTransport(channel.port1, {
    closePortOnClose: true,
  });

  try {
    transport.start((_frame) => {});
    assertThrows(
      () => transport.start((_frame) => {}),
      /already started/i,
    );
  } finally {
    transport.close();
    channel.port2.close();
  }
});

Deno.test("transport contract: MessagePortTransport send-before-start throws TransportError", async () => {
  const { MessagePortTransport } = await import("../mod.ts");
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
      thrown instanceof TransportError &&
        /not started/i.test(thrown.message),
      `expected TransportError from send-before-start, got: ${String(thrown)}`,
    );
  } finally {
    transport.close();
    channel.port2.close();
  }
});
