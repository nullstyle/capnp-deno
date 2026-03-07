/**
 * WebTransport transport tests.
 */

import { TransportError, WebTransportTransport } from "../../src/advanced.ts";
import {
  assert,
  assertBytes,
  assertEquals,
  deferred,
  withTimeout,
} from "../test_utils.ts";

function buildFrame(words: number): Uint8Array {
  const frame = new Uint8Array(8 + words * 8);
  const view = new DataView(frame.buffer);
  view.setUint32(0, 0, true);
  view.setUint32(4, words, true);
  for (let i = 0; i < words * 8; i += 1) {
    frame[8 + i] = (i + 1) & 0xff;
  }
  return frame;
}

async function withPatchedGlobalWebTransport(
  replacement: unknown,
  fn: () => Promise<void>,
): Promise<void> {
  const globalMutable = globalThis as unknown as {
    WebTransport: typeof WebTransport;
  };
  const original = globalMutable.WebTransport;
  globalMutable.WebTransport = replacement as typeof WebTransport;
  try {
    await fn();
  } finally {
    globalMutable.WebTransport = original;
  }
}

function createFakeReaderHarness(): {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  push: (chunk: Uint8Array) => void;
  close: () => void;
} {
  const queue: Array<ReadableStreamReadResult<Uint8Array>> = [];
  let pending:
    | ReturnType<
      typeof deferred<ReadableStreamReadResult<Uint8Array>>
    >
    | null = null;
  let closed = false;

  function resolveRead(result: ReadableStreamReadResult<Uint8Array>): void {
    if (pending) {
      pending.resolve(result);
      pending = null;
      return;
    }
    queue.push(result);
  }

  const reader: ReadableStreamDefaultReader<Uint8Array> = {
    read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      if (queue.length > 0) {
        return Promise.resolve(queue.shift()!);
      }
      pending = deferred<ReadableStreamReadResult<Uint8Array>>();
      return pending.promise;
    },
    cancel(): Promise<void> {
      if (!closed) {
        closed = true;
        resolveRead({ done: true, value: undefined });
      }
      return Promise.resolve();
    },
    releaseLock(): void {},
    closed: Promise.resolve(undefined),
  } as ReadableStreamDefaultReader<Uint8Array>;

  return {
    reader,
    push(chunk: Uint8Array): void {
      if (closed) return;
      resolveRead({ done: false, value: new Uint8Array(chunk) });
    },
    close(): void {
      if (closed) return;
      closed = true;
      resolveRead({ done: true, value: undefined });
    },
  };
}

function createFakeWriterHarness(
  options: { blockWrites?: boolean } = {},
): {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  writes: Uint8Array[];
  abortReason: Promise<unknown>;
} {
  const writes: Uint8Array[] = [];
  const abortReason = deferred<unknown>();
  let blockedWrite: ReturnType<typeof deferred<void>> | null = null;

  const writer: WritableStreamDefaultWriter<Uint8Array> = {
    ready: Promise.resolve(undefined),
    closed: Promise.resolve(undefined),
    desiredSize: 1,
    write(chunk: Uint8Array): Promise<void> {
      writes.push(new Uint8Array(chunk));
      if (options.blockWrites) {
        blockedWrite = deferred<void>();
        return blockedWrite.promise;
      }
      return Promise.resolve();
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
    abort(reason?: unknown): Promise<void> {
      abortReason.resolve(reason);
      blockedWrite?.reject(reason);
      blockedWrite = null;
      return Promise.resolve();
    },
    releaseLock(): void {},
  } as WritableStreamDefaultWriter<Uint8Array>;

  return { writer, writes, abortReason: abortReason.promise };
}

function createFakeBidiStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
): WebTransportBidirectionalStream {
  return {
    readable: {
      getReader: () => reader,
    } as ReadableStream<Uint8Array> as WebTransportReceiveStream,
    writable: {
      getWriter: () => writer,
    } as WritableStream<Uint8Array> as WebTransportSendStream,
  };
}

class SuccessfulWebTransport {
  static created: SuccessfulWebTransport[] = [];

  readonly url: string | URL;
  readonly options: WebTransportOptions | undefined;
  readonly ready = Promise.resolve();
  readonly closed: Promise<WebTransportCloseInfo>;
  readonly incomingBidirectionalStreams = {
    getReader: () => ({
      read: () => Promise.resolve({ done: true, value: undefined }),
      releaseLock: () => {},
    }),
  } as ReadableStream<WebTransportBidirectionalStream>;

  readonly #closedDeferred = deferred<WebTransportCloseInfo>();
  readonly #reader = createFakeReaderHarness();
  readonly #writer = createFakeWriterHarness();

  constructor(url: string | URL, options?: WebTransportOptions) {
    this.url = url;
    this.options = options;
    this.closed = this.#closedDeferred.promise;
    SuccessfulWebTransport.created.push(this);
  }

  createBidirectionalStream(): Promise<WebTransportBidirectionalStream> {
    return Promise.resolve(
      createFakeBidiStream(this.#reader.reader, this.#writer.writer),
    );
  }

  get outboundWrites(): Uint8Array[] {
    return this.#writer.writes;
  }

  enqueueInbound(chunk: Uint8Array): void {
    this.#reader.push(chunk);
  }

  close(): void {
    this.#reader.close();
    this.#closedDeferred.resolve({ closeCode: 0, reason: "closed" });
  }
}

Deno.test({
  name:
    "WebTransportTransport.connect wires stream I/O and reassembles inbound frames",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    SuccessfulWebTransport.created = [];

    await withPatchedGlobalWebTransport(SuccessfulWebTransport, async () => {
      const transport = await WebTransportTransport.connect(
        "https://127.0.0.1:8443/rpc",
        {
          webTransport: {
            serverCertificateHashes: [{
              algorithm: "sha-256",
              value: new Uint8Array([1, 2, 3]),
            }],
          },
        },
      );

      try {
        assertEquals(SuccessfulWebTransport.created.length, 1);
        const session = SuccessfulWebTransport.created[0];
        assertEquals(String(session.url), "https://127.0.0.1:8443/rpc");
        assertEquals(
          session.options?.serverCertificateHashes?.[0].algorithm,
          "sha-256",
        );

        const inboundSeen = deferred<Uint8Array>();
        transport.start((frame) => inboundSeen.resolve(new Uint8Array(frame)));

        const inbound = buildFrame(2);
        session.enqueueInbound(inbound.subarray(0, 5));
        session.enqueueInbound(inbound.subarray(5));

        const got = await withTimeout(
          inboundSeen.promise,
          1000,
          "webtransport inbound frame",
        );
        assertBytes(got, Array.from(inbound));

        const outbound = buildFrame(1);
        await transport.send(outbound);
        assertEquals(session.outboundWrites.length, 1);
        assertBytes(session.outboundWrites[0], Array.from(outbound));
      } finally {
        await transport.close();
      }
    });
  },
});

Deno.test({
  name: "WebTransportTransport.connect normalizes constructor failures",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    class ThrowingWebTransport {
      constructor() {
        throw new Error("ctor exploded");
      }
    }

    await withPatchedGlobalWebTransport(ThrowingWebTransport, async () => {
      let thrown: unknown;
      try {
        await WebTransportTransport.connect("https://127.0.0.1:7443/rpc");
      } catch (error) {
        thrown = error;
      }

      assert(
        thrown instanceof TransportError &&
          /failed to create webtransport session/i.test(thrown.message),
        `expected constructor normalization error, got: ${String(thrown)}`,
      );
    });
  },
});

Deno.test({
  name: "WebTransportTransport.connect times out and closes the session",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const created: Array<{ closeCalls: number }> = [];

    class HangingWebTransport {
      readonly #readyDeferred = deferred<void>();
      readonly #closedDeferred = deferred<WebTransportCloseInfo>();
      readonly ready = this.#readyDeferred.promise;
      readonly closed = this.#closedDeferred.promise;
      readonly incomingBidirectionalStreams = {
        getReader: () => ({
          read: () => Promise.resolve({ done: true, value: undefined }),
          releaseLock: () => {},
        }),
      } as ReadableStream<WebTransportBidirectionalStream>;
      closeCalls = 0;

      constructor(_url: string | URL, _options?: WebTransportOptions) {
        created.push(this);
      }

      createBidirectionalStream(): Promise<WebTransportBidirectionalStream> {
        throw new Error("should not open stream before ready resolves");
      }

      close(): void {
        this.closeCalls += 1;
        this.#readyDeferred.resolve();
        this.#closedDeferred.resolve({ closeCode: 0, reason: "closed" });
      }
    }

    await withPatchedGlobalWebTransport(HangingWebTransport, async () => {
      let thrown: unknown;
      try {
        await WebTransportTransport.connect("https://127.0.0.1:7444/rpc", {
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
  },
});

Deno.test({
  name:
    "WebTransportTransport.accept times out when no bidirectional stream arrives",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const pendingRead = deferred<
      ReadableStreamReadResult<WebTransportBidirectionalStream>
    >();
    const fakeSession = {
      closed: Promise.resolve({ closeCode: 0, reason: "closed" }),
      incomingBidirectionalStreams: {
        getReader: () => ({
          read: () => pendingRead.promise,
          releaseLock: () => {},
        }),
      },
      close: () => {
        pendingRead.resolve({ done: true, value: undefined });
      },
    } as WebTransport;

    let thrown: unknown;
    try {
      await WebTransportTransport.accept(fakeSession, {
        streamOpenTimeoutMs: 10,
      });
    } catch (error) {
      thrown = error;
    } finally {
      fakeSession.close();
    }

    assert(
      thrown instanceof TransportError &&
        /bidirectional stream accept timed out/i.test(thrown.message),
      `expected bidirectional stream timeout, got: ${String(thrown)}`,
    );
  },
});

Deno.test({
  name: "WebTransportTransport validates lifecycle and outbound frame limits",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const reader = createFakeReaderHarness();
    const writer = createFakeWriterHarness();
    const closed = deferred<WebTransportCloseInfo>();
    const session = {
      closed: closed.promise,
      close: () => {
        reader.close();
        closed.resolve({ closeCode: 0, reason: "closed" });
      },
    } as WebTransport;
    const transport = new WebTransportTransport(
      session,
      createFakeBidiStream(reader.reader, writer.writer),
      {
        maxOutboundFrameBytes: 8,
      },
    );

    let beforeStart: unknown;
    try {
      await transport.send(new Uint8Array([0x01]));
    } catch (error) {
      beforeStart = error;
    }
    assert(
      beforeStart instanceof TransportError &&
        /not started/i.test(beforeStart.message),
      `expected send-before-start error, got: ${String(beforeStart)}`,
    );

    transport.start((_frame) => {});

    let duplicateStart: unknown;
    try {
      transport.start((_frame) => {});
    } catch (error) {
      duplicateStart = error;
    }
    assert(
      duplicateStart instanceof TransportError &&
        /already started/i.test(duplicateStart.message),
      `expected duplicate start error, got: ${String(duplicateStart)}`,
    );

    let tooLarge: unknown;
    try {
      await transport.send(buildFrame(1));
    } catch (error) {
      tooLarge = error;
    }
    assert(
      tooLarge instanceof TransportError &&
        /outbound frame size 16 exceeds configured limit 8/i.test(
          tooLarge.message,
        ),
      `expected outbound frame limit error, got: ${String(tooLarge)}`,
    );

    await transport.close();

    let afterClose: unknown;
    try {
      await transport.send(new Uint8Array([0x01]));
    } catch (error) {
      afterClose = error;
    }
    assert(
      afterClose instanceof TransportError &&
        /is closed/i.test(afterClose.message),
      `expected send-after-close error, got: ${String(afterClose)}`,
    );
  },
});

Deno.test({
  name: "WebTransportTransport.close rejects an inflight send",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const reader = createFakeReaderHarness();
    const writer = createFakeWriterHarness({ blockWrites: true });
    const webTransportClosed = deferred<WebTransportCloseInfo>();
    let webTransportCloseCalls = 0;
    const webTransport = {
      closed: webTransportClosed.promise,
      close: () => {
        webTransportCloseCalls += 1;
        reader.close();
        webTransportClosed.resolve({ closeCode: 0, reason: "closed" });
      },
    } as WebTransport;

    const transport = new WebTransportTransport(
      webTransport,
      createFakeBidiStream(reader.reader, writer.writer),
    );
    transport.start((_frame) => {});

    const pending = transport.send(buildFrame(2));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await transport.close();

    let thrown: unknown;
    try {
      await pending;
    } catch (error) {
      thrown = error;
    }

    const abortReason = await withTimeout(
      writer.abortReason,
      1000,
      "writer abort reason",
    );
    assert(
      abortReason instanceof TransportError &&
        /is closed/i.test(abortReason.message),
      `expected writer abort close error, got: ${String(abortReason)}`,
    );
    assert(
      thrown instanceof TransportError && /is closed/i.test(thrown.message),
      `expected inflight send rejection, got: ${String(thrown)}`,
    );
    assertEquals(webTransportCloseCalls, 1);
  },
});

Deno.test({
  name:
    "WebTransportTransport treats rejected session closure as a closed transport",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const reader = createFakeReaderHarness();
    const writer = createFakeWriterHarness();
    const webTransportClosed = deferred<WebTransportCloseInfo>();
    const onClose = deferred<void>();
    const onError = deferred<unknown>();
    const webTransport = {
      closed: webTransportClosed.promise,
      close: () => {
        reader.close();
      },
    } as WebTransport;

    const transport = new WebTransportTransport(
      webTransport,
      createFakeBidiStream(reader.reader, writer.writer),
      {
        onClose: () => {
          onClose.resolve();
        },
        onError: (error) => {
          onError.resolve(error);
        },
      },
    );
    transport.start((_frame) => {});

    webTransportClosed.reject(new Error("peer crashed"));

    const reported = await withTimeout(
      onError.promise,
      1000,
      "webtransport abnormal close error callback",
    );
    await withTimeout(
      onClose.promise,
      1000,
      "webtransport abnormal close onClose callback",
    );

    let sendError: unknown;
    try {
      await transport.send(buildFrame(1));
    } catch (error) {
      sendError = error;
    }

    assert(
      reported instanceof TransportError,
      `expected normalized transport error, got: ${String(reported)}`,
    );
    assert(
      sendError instanceof TransportError &&
        /is closed/i.test(sendError.message),
      `expected send-after-session-close error, got: ${String(sendError)}`,
    );

    await withTimeout(
      transport.close(),
      1000,
      "webtransport close after abnormal session rejection",
    );
  },
});

Deno.test({
  name: "WebTransportTransport treats stream EOF as a closed transport",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const reader = createFakeReaderHarness();
    const writer = createFakeWriterHarness();
    const onClose = deferred<void>();
    let webTransportCloseCalls = 0;
    const webTransport = {
      closed: new Promise<WebTransportCloseInfo>(() => {}),
      close: () => {
        webTransportCloseCalls += 1;
      },
    } as WebTransport;

    const transport = new WebTransportTransport(
      webTransport,
      createFakeBidiStream(reader.reader, writer.writer),
      {
        onClose: () => {
          onClose.resolve();
        },
      },
    );
    transport.start((_frame) => {});

    reader.close();

    await withTimeout(
      onClose.promise,
      1000,
      "webtransport stream eof onClose callback",
    );

    let sendError: unknown;
    try {
      await transport.send(buildFrame(1));
    } catch (error) {
      sendError = error;
    }

    assert(
      sendError instanceof TransportError &&
        /is closed/i.test(sendError.message),
      `expected send-after-stream-eof error, got: ${String(sendError)}`,
    );

    await withTimeout(
      transport.close(),
      1000,
      "webtransport close after stream eof",
    );
    assertEquals(webTransportCloseCalls, 1);
  },
});
