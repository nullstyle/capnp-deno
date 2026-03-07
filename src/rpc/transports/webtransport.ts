/**
 * WebTransport transport for Cap'n Proto RPC.
 *
 * @module
 */

import { normalizeTransportError, TransportError } from "../../errors.ts";
import {
  CapnpFrameFramer,
  type CapnpFrameFramerOptions,
} from "../wire/framer.ts";
import {
  emitObservabilityEvent,
  type RpcObservability,
} from "../../observability/observability.ts";
import type { RpcTransport } from "./internal/transport.ts";
import {
  awaitWithTimeout,
  notifyTransportClose,
  OutboundFrameQueue,
  type QueuedOutboundFrame,
} from "./internal/transport_internal.ts";

interface PendingOutboundFrame extends QueuedOutboundFrame {}

interface PromiseResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

/**
 * Configuration options for {@link WebTransportTransport}.
 */
export interface WebTransportTransportOptions {
  /**
   * Cap'n Proto frame framing and validation limits. These are applied
   * incrementally as data is read from the WebTransport stream.
   */
  frameLimits?: CapnpFrameFramerOptions;
  /** Maximum allowed size in bytes for a single outbound frame. */
  maxOutboundFrameBytes?: number;
  /** Maximum number of outbound frames that can be queued. */
  maxQueuedOutboundFrames?: number;
  /** Maximum total bytes across all queued outbound frames. */
  maxQueuedOutboundBytes?: number;
  /**
   * Maximum idle time in milliseconds between reads. If no data is received
   * within this period, the read loop throws a timeout error.
   */
  readIdleTimeoutMs?: number;
  /** Maximum time in milliseconds to wait for a single write to complete. */
  sendTimeoutMs?: number;
  /** Maximum time in milliseconds to wait for the close operation to complete. */
  closeTimeoutMs?: number;
  /**
   * Error handler invoked when the transport encounters an error.
   * If not provided, errors are thrown.
   */
  onError?: (error: unknown) => void | Promise<void>;
  /**
   * Lifecycle callback invoked once when the transport transitions to closed.
   *
   * This fires for both local close() and remote peer disconnects.
   */
  onClose?: () => void | Promise<void>;
  /** Observability provider for emitting transport events. */
  observability?: RpcObservability;
}

/**
 * Client-side options for {@link WebTransportTransport.connect}.
 */
export interface WebTransportTransportConnectOptions
  extends WebTransportTransportOptions {
  /** Maximum time in milliseconds to wait for the WebTransport session to connect. */
  connectTimeoutMs?: number;
  /** Maximum time in milliseconds to wait for the initial bidirectional stream. */
  streamOpenTimeoutMs?: number;
  /** Options forwarded to the underlying `WebTransport` constructor. */
  webTransport?: WebTransportOptions;
}

/**
 * Server-side options for {@link WebTransportTransport.accept}.
 */
export interface WebTransportTransportAcceptOptions
  extends WebTransportTransportOptions {
  /** Maximum time in milliseconds to wait for the initial bidirectional stream. */
  streamOpenTimeoutMs?: number;
}

function createResolvers<T>(): PromiseResolvers<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function requireWebTransportConstructor(): typeof WebTransport {
  const ctor = (globalThis as unknown as {
    WebTransport?: typeof WebTransport;
  }).WebTransport;
  if (typeof ctor !== "function") {
    throw new TransportError(
      "WebTransport is unavailable; run Deno with --unstable-net",
    );
  }
  return ctor;
}

async function readFirstBidirectionalStream(
  webTransport: WebTransport,
  timeoutMs: number | undefined,
): Promise<WebTransportBidirectionalStream> {
  const reader = webTransport.incomingBidirectionalStreams.getReader();
  try {
    const result = await awaitWithTimeout(
      reader.read(),
      timeoutMs,
      (value) =>
        new TransportError(
          `webtransport bidirectional stream accept timed out after ${value}ms`,
        ),
    );
    if (result.done || !result.value) {
      throw new TransportError(
        "webtransport session closed before a bidirectional stream was accepted",
      );
    }
    return result.value;
  } finally {
    reader.releaseLock();
  }
}

function connectTransportOptions(
  options: WebTransportTransportConnectOptions,
): WebTransportTransportOptions {
  const {
    connectTimeoutMs: _connectTimeoutMs,
    streamOpenTimeoutMs: _streamOpenTimeoutMs,
    webTransport: _webTransport,
    ...transportOptions
  } = options;
  return transportOptions;
}

function acceptTransportOptions(
  options: WebTransportTransportAcceptOptions,
): WebTransportTransportOptions {
  const { streamOpenTimeoutMs: _streamOpenTimeoutMs, ...transportOptions } =
    options;
  return transportOptions;
}

/**
 * An {@link RpcTransport} implementation backed by a single WebTransport
 * bidirectional stream.
 *
 * Cap'n Proto RPC frames are written sequentially to the stream and reassembled
 * with a {@link CapnpFrameFramer} on the receiving side. Use the static
 * {@link connect} helper for clients or {@link accept} for server-side accepted
 * `WebTransport` sessions.
 *
 * @example
 * ```ts
 * const transport = await WebTransportTransport.connect("https://127.0.0.1:8443/rpc", {
 *   webTransport: {
 *     serverCertificateHashes: [
 *       { algorithm: "sha-256", value: certHashBytes },
 *     ],
 *   },
 *   connectTimeoutMs: 5000,
 * });
 * transport.start((frame) => handleFrame(frame));
 * ```
 */
export class WebTransportTransport implements RpcTransport {
  /** The underlying `WebTransport` session. */
  readonly webTransport: WebTransport;
  /** The bidirectional stream used for RPC traffic. */
  readonly stream: WebTransportBidirectionalStream;
  /** The options this transport was configured with. */
  readonly options: WebTransportTransportOptions;

  #started = false;
  #closed = false;
  #sessionClosed = false;
  #readLoop: Promise<void> = Promise.resolve();
  #framer: CapnpFrameFramer;
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #sessionClosedWait = createResolvers<void>();
  #closeNotified = false;

  #outbound: OutboundFrameQueue<PendingOutboundFrame>;
  #drainLoop: Promise<void> | null = null;

  constructor(
    webTransport: WebTransport,
    stream: WebTransportBidirectionalStream,
    options: WebTransportTransportOptions = {},
  ) {
    this.webTransport = webTransport;
    this.stream = stream;
    this.options = options;
    this.#framer = new CapnpFrameFramer(options.frameLimits);
    this.#reader = this.stream.readable.getReader();
    this.#writer = this.stream.writable.getWriter();
    this.#outbound = new OutboundFrameQueue("webtransport", options);

    void this.webTransport.closed.then(
      () => this.#handleSessionClosed(),
      (error) => {
        this.#handleSessionClosed();
        void this.handleError(error).catch(() => {
          // Suppress callback failures from the background close watcher.
        });
      },
    );
  }

  /**
   * Establish a new client-side WebTransport session and open its RPC stream.
   *
   * @param url - The WebTransport URL to connect to (for example `"https://127.0.0.1:8443/rpc"`).
   * @param options - Transport options, connection timeouts, and `WebTransport` constructor options.
   * @returns A new `WebTransportTransport` bound to the first client-opened bidirectional stream.
   * @throws {TransportError} If WebTransport is unavailable, connection fails, or stream opening times out.
   */
  static async connect(
    url: string | URL,
    options: WebTransportTransportConnectOptions = {},
  ): Promise<WebTransportTransport> {
    const WebTransportCtor = requireWebTransportConstructor();
    let webTransport: WebTransport;
    try {
      webTransport = new WebTransportCtor(url, options.webTransport);
    } catch (error) {
      throw normalizeTransportError(
        error,
        `failed to create webtransport session: ${String(url)}`,
      );
    }

    try {
      await awaitWithTimeout(
        webTransport.ready,
        options.connectTimeoutMs,
        (timeoutMs) =>
          new TransportError(
            `webtransport connect timed out after ${timeoutMs}ms: ${
              String(url)
            }`,
          ),
      );
      const stream = await awaitWithTimeout(
        webTransport.createBidirectionalStream(),
        options.streamOpenTimeoutMs,
        (timeoutMs) =>
          new TransportError(
            `webtransport bidirectional stream open timed out after ${timeoutMs}ms: ${
              String(url)
            }`,
          ),
      );
      return new WebTransportTransport(
        webTransport,
        stream,
        connectTransportOptions(options),
      );
    } catch (error) {
      try {
        webTransport.close();
      } catch {
        // no-op
      }
      throw normalizeTransportError(
        error,
        `webtransport connect failed: ${String(url)}`,
      );
    }
  }

  /**
   * Wrap an accepted server-side WebTransport session in an RPC transport.
   *
   * @param webTransport - An accepted `WebTransport` session, typically from `Deno.upgradeWebTransport(...)`.
   * @param options - Transport options and the timeout for waiting on the first inbound bidirectional stream.
   * @returns A new `WebTransportTransport` bound to the first inbound bidirectional stream.
   * @throws {TransportError} If no bidirectional stream arrives before timeout or the session closes early.
   */
  static async accept(
    webTransport: WebTransport,
    options: WebTransportTransportAcceptOptions = {},
  ): Promise<WebTransportTransport> {
    const stream = await readFirstBidirectionalStream(
      webTransport,
      options.streamOpenTimeoutMs,
    );
    return new WebTransportTransport(
      webTransport,
      stream,
      acceptTransportOptions(options),
    );
  }

  start(
    onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): void {
    const startedAt = performance.now();
    if (this.#closed || this.#sessionClosed) {
      throw new TransportError("WebTransportTransport is closed");
    }
    if (this.#started) {
      throw new TransportError("WebTransportTransport already started");
    }
    this.#started = true;
    this.#readLoop = this.runReadLoop(onFrame).catch((error) =>
      this.handleError(error)
    );
    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.webtransport.start",
      attributes: {
        "rpc.outcome": "ok",
      },
      durationMs: performance.now() - startedAt,
    });
  }

  async send(frame: Uint8Array): Promise<void> {
    const startedAt = performance.now();
    if (!this.#started) {
      throw new TransportError("WebTransportTransport not started");
    }
    if (this.#closed || this.#sessionClosed) {
      throw new TransportError("WebTransportTransport is closed");
    }
    this.assertOutboundFrameSize(frame);

    const payload = new Uint8Array(frame);

    const completion = new Promise<void>((resolve, reject) => {
      this.#outbound.enqueue({ frame: payload, resolve, reject });
    });

    this.#ensureDrainLoop();
    await completion;

    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.webtransport.send_frame",
      attributes: {
        "rpc.outcome": "ok",
        "rpc.outbound.bytes": frame.byteLength,
        "rpc.outbound.queue.frames": this.#outbound.length,
        "rpc.outbound.queue.bytes": this.#outbound.queuedBytes,
      },
      durationMs: performance.now() - startedAt,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    const startedAt = performance.now();
    this.#closed = true;

    const closeError = new TransportError("WebTransportTransport is closed");
    this.#outbound.rejectQueued(closeError);

    try {
      await this.#writer.abort(closeError);
    } catch {
      // no-op during shutdown
    }
    try {
      this.#writer.releaseLock();
    } catch {
      // no-op during shutdown
    }

    try {
      await this.#reader.cancel(closeError);
    } catch {
      // no-op during shutdown
    }
    try {
      this.#reader.releaseLock();
    } catch {
      // no-op during shutdown
    }

    if (!this.#sessionClosed) {
      try {
        this.webTransport.close();
      } catch {
        // no-op during shutdown
      }
    }
    this.#notifyClose();

    const waitForRead = this.#readLoop.catch(() => {
      // no-op during shutdown
    });
    const waitForDrain = (this.#drainLoop ?? Promise.resolve()).catch(() => {
      // no-op during shutdown
    });
    const waitForSession = this.#waitForSessionClose().catch(() => {
      // no-op during shutdown
    });

    const closeTimeoutMs = this.options.closeTimeoutMs;
    let closeTimedOut = false;
    const waitAll = Promise.all([waitForRead, waitForDrain, waitForSession]);
    if (closeTimeoutMs === undefined) {
      await waitAll;
    } else {
      await Promise.race([
        waitAll,
        delay(closeTimeoutMs).then(() => {
          closeTimedOut = true;
        }),
      ]);
    }

    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.webtransport.close",
      attributes: {
        "rpc.outcome": "ok",
        "rpc.close.timed_out": closeTimedOut,
      },
      durationMs: performance.now() - startedAt,
    });
  }

  private async runReadLoop(
    onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): Promise<void> {
    while (!this.#closed) {
      const result = await this.readChunk();
      if (result.done || !result.value) {
        this.#handleReadStreamClosed();
        return;
      }
      if (result.value.byteLength === 0) continue;

      this.#framer.push(result.value);
      while (true) {
        const frame = this.#framer.popFrame();
        if (!frame) break;
        await onFrame(frame);
        emitObservabilityEvent(this.options.observability, {
          name: "rpc.transport.webtransport.inbound_frame",
          attributes: {
            "rpc.outcome": "ok",
            "rpc.inbound.bytes": frame.byteLength,
          },
        });
      }
    }
  }

  private async readChunk(): Promise<ReadableStreamReadResult<Uint8Array>> {
    try {
      return await awaitWithTimeout(
        this.#reader.read(),
        this.options.readIdleTimeoutMs,
        (timeoutMs) =>
          new TransportError(
            `webtransport read idle timeout after ${timeoutMs}ms`,
          ),
      );
    } catch (error) {
      if (this.#closed || this.#sessionClosed) {
        return { done: true, value: undefined };
      }
      throw normalizeTransportError(error, "webtransport read failed");
    }
  }

  #ensureDrainLoop(): void {
    if (this.#drainLoop) return;
    this.#drainLoop = this.#drainOutbound()
      .catch((_error) => {
        // Individual send() callers receive write errors through their own
        // completion promises; suppress unhandled drain-loop rejections here.
      })
      .finally(() => {
        this.#drainLoop = null;
        if (this.#outbound.hasQueuedFrames && !this.#closed) {
          this.#ensureDrainLoop();
        }
      });
  }

  async #drainOutbound(): Promise<void> {
    while (
      !this.#closed && !this.#sessionClosed && this.#outbound.hasQueuedFrames
    ) {
      const next = this.#outbound.dequeue();
      if (!next) break;

      try {
        await awaitWithTimeout(
          this.#writer.write(next.frame),
          this.options.sendTimeoutMs,
          (timeoutMs) =>
            new TransportError(
              `webtransport send timed out after ${timeoutMs}ms`,
            ),
        );
        next.resolve();
      } catch (error) {
        const normalized = normalizeTransportError(
          error,
          "webtransport send failed",
        );
        next.reject(normalized);
        this.#outbound.rejectQueued(normalized);
        if (this.options.onError) {
          void Promise.resolve(this.options.onError(normalized));
        }
        throw normalized;
      } finally {
        this.#outbound.settle(next.frame.byteLength);
      }
    }
  }

  private async handleError(error: unknown): Promise<void> {
    const normalized = normalizeTransportError(
      error,
      "webtransport transport error",
    );
    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.webtransport.error",
      attributes: {
        "rpc.outcome": "error",
      },
      error: normalized,
    });
    if (this.options.onError) {
      await this.options.onError(normalized);
      return;
    }
    throw normalized;
  }

  #handleSessionClosed(): void {
    if (this.#sessionClosed) return;
    this.#sessionClosed = true;
    this.#sessionClosedWait.resolve();
    const error = new TransportError("webtransport session is closed");
    this.#outbound.rejectQueued(error);
    this.#notifyClose();
  }

  #handleReadStreamClosed(): void {
    if (this.#sessionClosed) {
      this.#notifyClose();
      return;
    }
    try {
      this.webTransport.close();
    } catch {
      // no-op during shutdown
    }
    this.#handleSessionClosed();
  }

  #waitForSessionClose(): Promise<void> {
    if (this.#sessionClosed) {
      return Promise.resolve();
    }
    return this.#sessionClosedWait.promise;
  }

  #notifyClose(): void {
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    notifyTransportClose(this.options, "webtransport onClose callback failed");
  }

  private assertOutboundFrameSize(frame: Uint8Array): void {
    const max = this.options.maxOutboundFrameBytes;
    if (max !== undefined && frame.byteLength > max) {
      throw new TransportError(
        `webtransport outbound frame size ${frame.byteLength} exceeds configured limit ${max}`,
      );
    }
  }
}
