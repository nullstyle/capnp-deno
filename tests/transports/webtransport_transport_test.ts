/**
 * WebTransport transport tests.
 */

import {
  createWebTransportCertificateHash,
  createWebTransportCertificateHashOptions,
  getWebTransportRuntimeSupport,
  TransportError,
  WebTransportTransport,
} from "../../src/advanced.ts";
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
  fn: () => void | Promise<void>,
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

async function withPatchedDenoQuicEndpoint(
  replacement: unknown,
  fn: () => void | Promise<void>,
): Promise<void> {
  const denoMutable = Deno as unknown as {
    QuicEndpoint?: typeof Deno.QuicEndpoint;
  };
  const original = denoMutable.QuicEndpoint;
  denoMutable.QuicEndpoint = replacement as typeof Deno.QuicEndpoint;
  try {
    await fn();
  } finally {
    denoMutable.QuicEndpoint = original;
  }
}

async function withPatchedDenoUpgradeWebTransport(
  replacement: unknown,
  fn: () => void | Promise<void>,
): Promise<void> {
  const denoMutable = Deno as unknown as {
    upgradeWebTransport?: typeof Deno.upgradeWebTransport;
  };
  const original = denoMutable.upgradeWebTransport;
  denoMutable.upgradeWebTransport =
    replacement as typeof Deno.upgradeWebTransport;
  try {
    await fn();
  } finally {
    denoMutable.upgradeWebTransport = original;
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

function bufferSourceBytes(source: BufferSource): Uint8Array {
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }
  return new Uint8Array(source);
}

function createFakeIncomingBidiReaderHarness(): {
  reader: ReadableStreamDefaultReader<WebTransportBidirectionalStream>;
  push: (stream: WebTransportBidirectionalStream) => void;
  close: () => void;
} {
  const queue: Array<
    ReadableStreamReadResult<WebTransportBidirectionalStream>
  > = [];
  let pending:
    | ReturnType<
      typeof deferred<ReadableStreamReadResult<WebTransportBidirectionalStream>>
    >
    | null = null;
  let closed = false;

  function resolveRead(
    result: ReadableStreamReadResult<WebTransportBidirectionalStream>,
  ): void {
    if (pending) {
      pending.resolve(result);
      pending = null;
      return;
    }
    queue.push(result);
  }

  const reader: ReadableStreamDefaultReader<WebTransportBidirectionalStream> = {
    read(): Promise<ReadableStreamReadResult<WebTransportBidirectionalStream>> {
      if (queue.length > 0) {
        return Promise.resolve(queue.shift()!);
      }
      pending = deferred<
        ReadableStreamReadResult<WebTransportBidirectionalStream>
      >();
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
  } as ReadableStreamDefaultReader<WebTransportBidirectionalStream>;

  return {
    reader,
    push(stream: WebTransportBidirectionalStream): void {
      if (closed) return;
      resolveRead({ done: false, value: stream });
    },
    close(): void {
      if (closed) return;
      closed = true;
      resolveRead({ done: true, value: undefined });
    },
  };
}

function createFakeAcceptedSession(url: string): {
  session: WebTransport & { url: string };
  pushStream: (stream: WebTransportBidirectionalStream) => void;
  close: () => void;
} {
  const incoming = createFakeIncomingBidiReaderHarness();
  const closed = deferred<WebTransportCloseInfo>();
  let closedOnce = false;

  return {
    session: {
      url,
      closed: closed.promise,
      incomingBidirectionalStreams: {
        getReader: () => incoming.reader,
      } as ReadableStream<WebTransportBidirectionalStream>,
      close: () => {
        if (closedOnce) return;
        closedOnce = true;
        incoming.close();
        closed.resolve({ closeCode: 0, reason: "closed" });
      },
    } as WebTransport & { url: string },
    pushStream(stream: WebTransportBidirectionalStream): void {
      incoming.push(stream);
    },
    close(): void {
      if (closedOnce) return;
      closedOnce = true;
      incoming.close();
      closed.resolve({ closeCode: 0, reason: "closed" });
    },
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

Deno.test("WebTransport certificate hash helpers copy bytes and parse hex", () => {
  const source = new Uint8Array(32);
  for (let i = 0; i < source.length; i += 1) {
    source[i] = i;
  }

  const hash = createWebTransportCertificateHash(source);
  assertEquals(hash.algorithm, "sha-256");
  assertBytes(hash.value, Array.from(source));

  source[0] = 255;
  assertEquals(hash.value[0], 0);

  const hex = Array.from(hash.value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(":");
  const parsed = createWebTransportCertificateHash(hex);
  assertBytes(parsed.value, Array.from(hash.value));

  const baseOptions: WebTransportOptions = {
    allowPooling: false,
    serverCertificateHashes: [hash],
  };
  const merged = createWebTransportCertificateHashOptions(
    parsed.value,
    baseOptions,
  );
  assertEquals(merged.allowPooling, false);
  assertEquals(merged.serverCertificateHashes?.length, 2);
  const appendedValue = merged.serverCertificateHashes?.[1].value;
  assert(appendedValue !== undefined, "expected appended certificate hash");
  assertBytes(
    bufferSourceBytes(appendedValue),
    Array.from(parsed.value),
  );
});

Deno.test("WebTransport certificate hash helpers reject malformed input", () => {
  for (
    const value of [
      new Uint8Array(31),
      "abc",
      "zz".repeat(32),
    ]
  ) {
    let thrown: unknown;
    try {
      createWebTransportCertificateHash(value);
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof TransportError,
      `expected TransportError for ${String(value)}, got ${String(thrown)}`,
    );
  }
});

Deno.test("getWebTransportRuntimeSupport reports client and server primitives", async () => {
  class FakeWebTransport {}
  class FakeQuicEndpoint {}
  const fakeUpgrade = () => Promise.resolve({} as WebTransport);

  await withPatchedGlobalWebTransport(FakeWebTransport, async () => {
    await withPatchedDenoQuicEndpoint(FakeQuicEndpoint, async () => {
      await withPatchedDenoUpgradeWebTransport(fakeUpgrade, () => {
        const support = getWebTransportRuntimeSupport();
        assertEquals(support.client, true);
        assertEquals(support.server, true);
        assertEquals(support.webTransport, true);
        assertEquals(support.denoQuicEndpoint, true);
        assertEquals(support.denoUpgradeWebTransport, true);
        assertEquals(support.missing.length, 0);
      });
    });
  });
});

Deno.test("WebTransportTransport.connect rejects non-https URLs before constructing session", async () => {
  let constructed = false;
  class TrackingWebTransport {
    constructor() {
      constructed = true;
    }
  }

  await withPatchedGlobalWebTransport(TrackingWebTransport, async () => {
    let thrown: unknown;
    try {
      await WebTransportTransport.connect("http://127.0.0.1:8443/rpc");
    } catch (error) {
      thrown = error;
    }

    assertEquals(constructed, false);
    assert(
      thrown instanceof TransportError &&
        /requires an https URL/i.test(thrown.message),
      `expected https validation error, got: ${String(thrown)}`,
    );
  });
});

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
      {
        maxOutboundFrameBytes: 64,
        maxQueuedOutboundFrames: 1,
        maxQueuedOutboundBytes: 64,
      },
    );
    assertEquals(transport.stats.started, false);
    assertEquals(transport.stats.closed, false);
    assertEquals(transport.stats.maxOutboundFrameBytes, 64);
    assertEquals(transport.stats.maxQueuedOutboundFrames, 1);
    assertEquals(transport.stats.maxQueuedOutboundBytes, 64);

    transport.start((_frame) => {});
    assertEquals(transport.stats.started, true);

    const pending = transport.send(buildFrame(2));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assertEquals(transport.stats.draining, true);
    assertEquals(transport.stats.inflightOutboundFrames, 1);
    assertEquals(
      transport.stats.inflightOutboundBytes,
      buildFrame(2).byteLength,
    );
    assertEquals(transport.stats.queuedOutboundFrames, 0);

    await transport.close();
    assertEquals(transport.stats.closed, true);

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
    assertEquals(transport.stats.closed, true);

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

Deno.test({
  name:
    "WebTransportTransport.listen normalizes paths and reports path mismatch",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    class FakeQuicConn {
      readonly remoteAddr: Deno.NetAddr = {
        transport: "udp",
        hostname: "127.0.0.1",
        port: 5001,
      };

      close(): void {
        // no-op
      }
    }

    class FakeQuicIncoming {
      accept(): Promise<Deno.QuicConn> {
        return Promise.resolve(new FakeQuicConn() as unknown as Deno.QuicConn);
      }
    }

    class FakeQuicListener {
      #pending: ReturnType<typeof deferred<FakeQuicIncoming>> | null = null;

      incoming(): Promise<Deno.QuicIncoming> {
        this.#pending = deferred<FakeQuicIncoming>();
        return this.#pending.promise as unknown as Promise<Deno.QuicIncoming>;
      }

      enqueue(incoming: FakeQuicIncoming): void {
        this.#pending?.resolve(incoming);
        this.#pending = null;
      }

      stop(): void {
        this.#pending?.reject(new Error("listener stopped"));
        this.#pending = null;
      }
    }

    class FakeQuicEndpoint {
      static last: FakeQuicEndpoint | null = null;

      readonly addr: Deno.NetAddr = {
        transport: "udp",
        hostname: "127.0.0.1",
        port: 4443,
      };
      readonly listener = new FakeQuicListener();

      constructor() {
        FakeQuicEndpoint.last = this;
      }

      listen(): Deno.QuicListener {
        return this.listener as unknown as Deno.QuicListener;
      }

      close(): void {
        this.listener.stop();
      }
    }

    const mismatchSession = createFakeAcceptedSession(
      "https://127.0.0.1:4443/wrong",
    );
    const reported = deferred<unknown>();
    const events: Array<
      { name: string; error?: unknown; attributes?: unknown }
    > = [];

    await withPatchedDenoQuicEndpoint(FakeQuicEndpoint, async () => {
      await withPatchedDenoUpgradeWebTransport(() => {
        return Promise.resolve(mismatchSession.session);
      }, async () => {
        const listener = WebTransportTransport.listen({
          hostname: "127.0.0.1",
          port: 4443,
          path: "rpc",
          cert: "cert",
          key: "key",
          onConnectionError: (error) => {
            reported.resolve(error);
          },
          observability: {
            onEvent(event) {
              events.push(event);
            },
          },
        });

        FakeQuicEndpoint.last!.listener.enqueue(new FakeQuicIncoming());
        const error = await withTimeout(
          reported.promise,
          1000,
          "path mismatch report",
        );
        assert(
          error instanceof TransportError &&
            /expected \/rpc got \/wrong/i.test(error.message),
          `expected path mismatch error, got: ${String(error)}`,
        );
        assert(
          events.some((event) =>
            event.name === "rpc.transport.webtransport.connection_error" &&
            (event.attributes as Record<string, unknown>)?.[
                "rpc.connection.path.expected"
              ] === "/rpc"
          ),
          "expected path mismatch observability event",
        );

        await listener.close();
      });
    });
  },
});

Deno.test({
  name:
    "WebTransportTransport.listen reports first stream timeout through callback",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    class FakeQuicConn {
      readonly remoteAddr: Deno.NetAddr = {
        transport: "udp",
        hostname: "127.0.0.1",
        port: 5002,
      };

      close(): void {
        // no-op
      }
    }

    class FakeQuicIncoming {
      accept(): Promise<Deno.QuicConn> {
        return Promise.resolve(new FakeQuicConn() as unknown as Deno.QuicConn);
      }
    }

    class FakeQuicListener {
      #pending: ReturnType<typeof deferred<FakeQuicIncoming>> | null = null;

      incoming(): Promise<Deno.QuicIncoming> {
        this.#pending = deferred<FakeQuicIncoming>();
        return this.#pending.promise as unknown as Promise<Deno.QuicIncoming>;
      }

      enqueue(incoming: FakeQuicIncoming): void {
        this.#pending?.resolve(incoming);
        this.#pending = null;
      }

      stop(): void {
        this.#pending?.reject(new Error("listener stopped"));
        this.#pending = null;
      }
    }

    class FakeQuicEndpoint {
      static last: FakeQuicEndpoint | null = null;

      readonly addr: Deno.NetAddr = {
        transport: "udp",
        hostname: "127.0.0.1",
        port: 4444,
      };
      readonly listener = new FakeQuicListener();

      constructor() {
        FakeQuicEndpoint.last = this;
      }

      listen(): Deno.QuicListener {
        return this.listener as unknown as Deno.QuicListener;
      }

      close(): void {
        this.listener.stop();
      }
    }

    const timeoutSession = createFakeAcceptedSession(
      "https://127.0.0.1:4444/rpc",
    );
    const reported = deferred<unknown>();
    const events: Array<
      { name: string; error?: unknown; attributes?: unknown }
    > = [];

    await withPatchedDenoQuicEndpoint(FakeQuicEndpoint, async () => {
      await withPatchedDenoUpgradeWebTransport(() => {
        return Promise.resolve(timeoutSession.session);
      }, async () => {
        const listener = WebTransportTransport.listen({
          hostname: "127.0.0.1",
          port: 4444,
          path: "/rpc",
          cert: "cert",
          key: "key",
          transport: {
            streamOpenTimeoutMs: 10,
          },
          onConnectionError: (error) => {
            reported.resolve(error);
          },
          observability: {
            onEvent(event) {
              events.push(event);
            },
          },
        });

        FakeQuicEndpoint.last!.listener.enqueue(new FakeQuicIncoming());
        const error = await withTimeout(
          reported.promise,
          1000,
          "first stream timeout report",
        );
        assert(
          error instanceof TransportError &&
            /bidirectional stream accept timed out/i.test(error.message),
          `expected first stream timeout error, got: ${String(error)}`,
        );
        assert(
          events.some((event) =>
            event.name === "rpc.transport.webtransport.connection_error" &&
            (event.attributes as Record<string, unknown>)?.[
                "rpc.connection.phase"
              ] === "first_stream"
          ),
          "expected first-stream observability event",
        );

        await listener.close();
      });
    });
  },
});

Deno.test({
  name:
    "WebTransportTransport.listen accepts later sessions while an earlier session waits for its first stream",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    class FakeQuicConn {
      readonly remoteAddr: Deno.NetAddr;

      constructor(hostname: string, port: number) {
        this.remoteAddr = { transport: "udp", hostname, port };
      }

      close(): void {
        // no-op
      }
    }

    class FakeQuicIncoming {
      readonly #conn: FakeQuicConn;

      constructor(conn: FakeQuicConn) {
        this.#conn = conn;
      }

      accept(): Promise<Deno.QuicConn> {
        return Promise.resolve(this.#conn as unknown as Deno.QuicConn);
      }
    }

    class FakeQuicListener {
      readonly #queue: FakeQuicIncoming[] = [];
      #pending: ReturnType<typeof deferred<FakeQuicIncoming>> | null = null;
      #stopped = false;

      incoming(): Promise<Deno.QuicIncoming> {
        if (this.#queue.length > 0) {
          return Promise.resolve(
            this.#queue.shift()! as unknown as Deno.QuicIncoming,
          );
        }
        if (this.#stopped) {
          return Promise.reject(new Error("listener stopped"));
        }
        this.#pending = deferred<FakeQuicIncoming>();
        return this.#pending.promise as unknown as Promise<Deno.QuicIncoming>;
      }

      enqueue(incoming: FakeQuicIncoming): void {
        if (this.#pending) {
          this.#pending.resolve(incoming);
          this.#pending = null;
          return;
        }
        this.#queue.push(incoming);
      }

      stop(): void {
        this.#stopped = true;
        if (this.#pending) {
          this.#pending.reject(new Error("listener stopped"));
          this.#pending = null;
        }
      }
    }

    class FakeQuicEndpoint {
      static last: FakeQuicEndpoint | null = null;

      readonly addr: Deno.NetAddr;
      readonly listener = new FakeQuicListener();
      readonly #sessions: Array<{ close(): void }> = [];

      constructor(options: { hostname?: string; port: number }) {
        this.addr = {
          transport: "udp",
          hostname: options.hostname ?? "0.0.0.0",
          port: options.port,
        };
        FakeQuicEndpoint.last = this;
      }

      listen(): Deno.QuicListener {
        return this.listener as unknown as Deno.QuicListener;
      }

      trackSession(session: { close(): void }): void {
        this.#sessions.push(session);
      }

      close(): void {
        for (const session of this.#sessions) {
          session.close();
        }
        this.listener.stop();
      }
    }

    const sessions = new Map<
      FakeQuicConn,
      ReturnType<typeof createFakeAcceptedSession>
    >();

    await withPatchedDenoQuicEndpoint(FakeQuicEndpoint, async () => {
      await withPatchedDenoUpgradeWebTransport((conn: Deno.QuicConn) => {
        return Promise.resolve(
          sessions.get(conn as unknown as FakeQuicConn)!.session,
        );
      }, async () => {
        const listener = WebTransportTransport.listen({
          hostname: "127.0.0.1",
          port: 4443,
          path: "/rpc",
          cert: "cert",
          key: "key",
        });

        const endpoint = FakeQuicEndpoint.last!;
        const slowConn = new FakeQuicConn("127.0.0.1", 5001);
        const fastConn = new FakeQuicConn("127.0.0.1", 5002);
        const slowSession = createFakeAcceptedSession(
          "https://127.0.0.1:4443/rpc",
        );
        const fastSession = createFakeAcceptedSession(
          "https://127.0.0.1:4443/rpc",
        );
        endpoint.trackSession(slowSession);
        endpoint.trackSession(fastSession);
        sessions.set(slowConn, slowSession);
        sessions.set(fastConn, fastSession);

        const fastReader = createFakeReaderHarness();
        const fastWriter = createFakeWriterHarness();
        fastSession.pushStream(
          createFakeBidiStream(fastReader.reader, fastWriter.writer),
        );

        const acceptLoop = (async () => {
          for await (const transport of listener.accept()) {
            return transport;
          }
          return null;
        })();

        endpoint.listener.enqueue(new FakeQuicIncoming(slowConn));
        endpoint.listener.enqueue(new FakeQuicIncoming(fastConn));

        const accepted = await withTimeout(
          acceptLoop,
          1000,
          "webtransport listener accepted transport",
        );
        assert(accepted !== null, "expected accepted webtransport transport");
        assertEquals(accepted.transport, accepted);
        assertEquals(accepted.localAddress?.transport, "webtransport");
        assertEquals(accepted.localAddress?.path, "/rpc");
        assertEquals(accepted.remoteAddress?.transport, "webtransport");
        assertEquals(accepted.id, "127.0.0.1:5002");

        await accepted.close();
        await withTimeout(
          listener.close(),
          1000,
          "webtransport listener close with pending first stream",
        );
      });
    });
  },
});
