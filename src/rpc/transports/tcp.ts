/**
 * TCP transport for Cap'n Proto RPC.
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
import type { RpcTransport } from "./transport.ts";

/**
 * Configuration options for {@link TcpServerListener}.
 */
export interface TcpServerListenerOptions {
  /** The TCP port to listen on. */
  port: number;
  /** The hostname/address to bind to. Defaults to "0.0.0.0". */
  hostname?: string;
  /**
   * Transport options applied to each accepted connection. Options like
   * `connectTimeoutMs` are ignored since the connection is already established.
   */
  transportOptions?: TcpTransportOptions;
  /** Observability provider for emitting listener events. */
  observability?: RpcObservability;
}

/**
 * A TCP server listener that accepts inbound connections and wraps each one
 * in a {@link TcpTransport}.
 *
 * This class binds a TCP socket using `Deno.listen()` and yields a new
 * `TcpTransport` for each accepted connection. Each transport can then be
 * handed to an `RpcServerRuntime` for per-connection RPC handling.
 *
 * @example
 * ```ts
 * const listener = new TcpServerListener({ port: 4000 });
 * for await (const transport of listener.accept()) {
 *   // hand transport to an RpcServerRuntime
 *   runtime.addSession(transport);
 * }
 * ```
 */
export class TcpServerListener {
  /** The underlying Deno TCP listener. */
  readonly listener: Deno.Listener;
  /** The options this listener was configured with. */
  readonly options: TcpServerListenerOptions;

  #closed = false;

  constructor(options: TcpServerListenerOptions) {
    if (!("listen" in Deno) || typeof Deno.listen !== "function") {
      throw new TransportError(
        "Deno.listen is unavailable; run with a runtime that supports TCP listen",
      );
    }
    this.options = options;
    this.listener = Deno.listen({
      port: options.port,
      hostname: options.hostname ?? "0.0.0.0",
      transport: "tcp",
    });
    emitObservabilityEvent(options.observability, {
      name: "rpc.transport.tcp.listen",
      attributes: {
        "rpc.outcome": "ok",
        "rpc.listen.port": options.port,
        "rpc.listen.hostname": options.hostname ?? "0.0.0.0",
      },
    });
  }

  /**
   * Returns the local address the listener is bound to.
   */
  get addr(): Deno.Addr {
    return this.listener.addr;
  }

  /**
   * Returns an async iterable that yields a new {@link TcpTransport} for each
   * accepted TCP connection. The iterable terminates when the listener is
   * closed.
   *
   * @yields A `TcpTransport` wrapping the accepted connection.
   */
  async *accept(): AsyncIterable<TcpTransport> {
    while (!this.#closed) {
      let conn: Deno.Conn;
      try {
        conn = await this.listener.accept();
      } catch (error) {
        if (this.#closed) {
          // Listener was closed while waiting for a connection; exit cleanly.
          return;
        }
        throw normalizeTransportError(error, "tcp accept failed");
      }

      const transport = new TcpTransport(
        conn,
        this.options.transportOptions
          ? { ...this.options.transportOptions }
          : undefined,
      );

      emitObservabilityEvent(this.options.observability, {
        name: "rpc.transport.tcp.accept",
        attributes: {
          "rpc.outcome": "ok",
        },
      });

      yield transport;
    }
  }

  /**
   * Stops the listener and prevents any further connections from being
   * accepted. Calling close on an already-closed listener is a no-op.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.listener.close();
    } catch {
      // no-op -- listener may already be closed.
    }
    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.tcp.listen_close",
      attributes: {
        "rpc.outcome": "ok",
      },
    });
  }
}

interface PendingOutboundFrame {
  frame: Uint8Array;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * Configuration options for {@link TcpTransport}.
 */
export interface TcpTransportOptions {
  /** Size of the read buffer in bytes. Defaults to 64 KB. */
  readBufferSize?: number;
  /**
   * Cap'n Proto frame framing and validation limits. These are applied
   * incrementally as data is read from the TCP stream.
   */
  frameLimits?: CapnpFrameFramerOptions;
  /** Maximum allowed size in bytes for a single outbound frame. */
  maxOutboundFrameBytes?: number;
  /** Maximum number of outbound frames that can be queued. */
  maxQueuedOutboundFrames?: number;
  /** Maximum total bytes across all queued outbound frames. */
  maxQueuedOutboundBytes?: number;
  /** Maximum time in milliseconds to wait for the TCP connection to be established. */
  connectTimeoutMs?: number;
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

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Deno.errors.TimedOut ||
    (error instanceof Error && /timed out/i.test(error.message))
  );
}

function isPeerDisconnectError(error: unknown): boolean {
  return (
    error instanceof Deno.errors.ConnectionReset ||
    error instanceof Deno.errors.BrokenPipe ||
    error instanceof Deno.errors.NotConnected ||
    error instanceof Deno.errors.BadResource ||
    (error instanceof Error &&
      /(connection reset|broken pipe|not connected|bad resource|connection aborted|closed network connection)/i
        .test(error.message))
  );
}

/**
 * An {@link RpcTransport} implementation that communicates over a TCP connection
 * using Deno's `Deno.Conn` API.
 *
 * Uses a {@link CapnpFrameFramer} to incrementally assemble complete Cap'n Proto
 * frames from the TCP byte stream. Outbound frames are queued and written
 * sequentially with full backpressure.
 *
 * Use the static {@link connect} factory method to establish a new TCP connection,
 * or pass an existing `Deno.Conn` directly to the constructor.
 *
 * @example
 * ```ts
 * const transport = await TcpTransport.connect("localhost", 4000, {
 *   connectTimeoutMs: 5000,
 *   readIdleTimeoutMs: 30000,
 * });
 * transport.start((frame) => handleFrame(frame));
 * ```
 */
export class TcpTransport implements RpcTransport {
  /** The underlying Deno TCP connection. */
  readonly conn: Deno.Conn;
  /** The options this transport was configured with. */
  readonly options: TcpTransportOptions;

  #started = false;
  #closed = false;
  #readLoop: Promise<void> = Promise.resolve();
  #framer: CapnpFrameFramer;

  #outboundQueue: PendingOutboundFrame[] = [];
  #queuedOutboundBytes = 0;
  #inflightOutboundFrames = 0;
  #inflightOutboundBytes = 0;
  #draining = false;
  #drainLoop: Promise<void> | null = null;
  #closeNotified = false;

  constructor(conn: Deno.Conn, options: TcpTransportOptions = {}) {
    this.conn = conn;
    this.options = options;
    this.#framer = new CapnpFrameFramer(options.frameLimits);
  }

  /**
   * Establish a new TCP connection and wrap it in a {@link TcpTransport}.
   *
   * @param hostname - The TCP hostname to connect to.
   * @param port - The TCP port to connect to.
   * @param options - Transport options including connect timeout.
   * @returns A new `TcpTransport` wrapping the established connection.
   * @throws {TransportError} If the connection fails or times out.
   */
  static async connect(
    hostname: string,
    port: number,
    options: TcpTransportOptions = {},
  ): Promise<TcpTransport> {
    if (!("connect" in Deno) || typeof Deno.connect !== "function") {
      throw new TransportError(
        "Deno.connect is unavailable; run with a runtime that supports TCP connect",
      );
    }
    const connect = Deno.connect;

    const connectPromise = connect({ hostname, port, transport: "tcp" });
    const connectTimeoutMs = options.connectTimeoutMs;

    if (connectTimeoutMs === undefined) {
      let conn: Deno.Conn;
      try {
        conn = await connectPromise;
      } catch (error) {
        throw normalizeTransportError(
          error,
          `tcp connect failed (${hostname}:${port})`,
        );
      }
      return new TcpTransport(conn, options);
    }

    // Atomic flag to prevent the race where the connection succeeds at the
    // exact moment the timeout fires. Without this, the timeout handler could
    // close a connection that Promise.race already resolved with.
    let resolved = false;

    const timed = new Promise<Deno.Conn>((_resolve, reject) => {
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        reject(
          new TransportError(
            `tcp connect timed out after ${connectTimeoutMs}ms (${hostname}:${port})`,
          ),
        );
      }, connectTimeoutMs);
      void connectPromise.then(
        () => clearTimeout(timer),
        () => clearTimeout(timer),
      );
    });

    void connectPromise.then((conn) => {
      if (resolved) {
        try {
          conn.close();
        } catch {
          // no-op
        }
      }
    }).catch(() => {
      // no-op, caller handles failure via race.
    });

    let conn: Deno.Conn;
    try {
      conn = await Promise.race([connectPromise, timed]);
      resolved = true;
    } catch (error) {
      throw normalizeTransportError(
        error,
        `tcp connect failed (${hostname}:${port})`,
      );
    }
    return new TcpTransport(conn, options);
  }

  start(
    onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): void {
    const startedAt = performance.now();
    if (this.#closed) throw new TransportError("TcpTransport is closed");
    if (this.#started) throw new TransportError("TcpTransport already started");
    this.#started = true;
    this.#readLoop = this.runReadLoop(onFrame).catch((error) =>
      this.handleError(error)
    );
    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.tcp.start",
      attributes: {
        "rpc.outcome": "ok",
      },
      durationMs: performance.now() - startedAt,
    });
  }

  async send(frame: Uint8Array): Promise<void> {
    const startedAt = performance.now();
    if (!this.#started) throw new TransportError("TcpTransport not started");
    if (this.#closed) throw new TransportError("TcpTransport is closed");
    this.assertOutboundFrameSize(frame);

    const payload = new Uint8Array(frame);
    this.assertOutboundQueueCapacity(payload.byteLength);

    const completion = new Promise<void>((resolve, reject) => {
      this.#outboundQueue.push({ frame: payload, resolve, reject });
      this.#queuedOutboundBytes += payload.byteLength;
    });

    this.#ensureDrainLoop();
    await completion;

    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.tcp.send_frame",
      attributes: {
        "rpc.outcome": "ok",
        "rpc.outbound.bytes": frame.byteLength,
        "rpc.outbound.queue.frames": this.#outboundQueue.length,
        "rpc.outbound.queue.bytes": this.#queuedOutboundBytes,
      },
      durationMs: performance.now() - startedAt,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    const startedAt = performance.now();
    this.#closed = true;

    const closeError = new TransportError("TcpTransport is closed");
    this.#rejectQueuedOutbound(closeError);

    try {
      this.conn.close();
    } catch {
      // no-op
    }
    this.#notifyClose();

    const waitForRead = this.#readLoop.catch(() => {
      // no-op during shutdown.
    });
    const waitForDrain = (this.#drainLoop ?? Promise.resolve()).catch(() => {
      // no-op during shutdown.
    });

    const closeTimeoutMs = this.options.closeTimeoutMs;
    let closeTimedOut = false;
    if (closeTimeoutMs === undefined) {
      await Promise.all([waitForRead, waitForDrain]);
    } else {
      await Promise.race([
        Promise.all([waitForRead, waitForDrain]),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            closeTimedOut = true;
            resolve();
          }, closeTimeoutMs);
        }),
      ]);
    }

    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.tcp.close",
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
    const readBufferSize = this.options.readBufferSize ?? 64 * 1024;
    const buffer = new Uint8Array(readBufferSize);

    while (!this.#closed) {
      const read = await this.readChunk(buffer);
      if (read === null) {
        this.#notifyClose();
        return;
      }
      if (read === 0) continue;

      this.#framer.push(buffer.subarray(0, read));
      while (true) {
        const frame = this.#framer.popFrame();
        if (!frame) break;
        await onFrame(frame);
        emitObservabilityEvent(this.options.observability, {
          name: "rpc.transport.tcp.inbound_frame",
          attributes: {
            "rpc.outcome": "ok",
            "rpc.inbound.bytes": frame.byteLength,
          },
        });
      }
    }
  }

  private async readChunk(buffer: Uint8Array): Promise<number | null> {
    const idleTimeoutMs = this.options.readIdleTimeoutMs;
    // deno-lint-ignore no-explicit-any
    const connRecord = this.conn as any;
    const hasDeadline = typeof connRecord.setReadDeadline === "function";
    if (idleTimeoutMs !== undefined && hasDeadline) {
      connRecord.setReadDeadline(new Date(Date.now() + idleTimeoutMs));
    }

    try {
      return await this.conn.read(buffer);
    } catch (error) {
      if (idleTimeoutMs !== undefined && isTimeoutError(error)) {
        throw new TransportError(
          `tcp read idle timeout after ${idleTimeoutMs}ms`,
        );
      }
      if (isPeerDisconnectError(error)) {
        return null;
      }
      throw normalizeTransportError(error, "tcp read failed");
    } finally {
      if (idleTimeoutMs !== undefined && hasDeadline) {
        connRecord.setReadDeadline();
      }
    }
  }

  #ensureDrainLoop(): void {
    if (this.#draining) return;
    this.#draining = true;
    this.#drainLoop = this.#drainOutbound()
      .catch((_error) => {
        // Individual send() callers receive write errors through their own
        // completion promises; suppress unhandled drain-loop rejections here.
      })
      .finally(() => {
        this.#draining = false;
        this.#drainLoop = null;
        if (this.#outboundQueue.length > 0 && !this.#closed) {
          this.#ensureDrainLoop();
        }
      });
  }

  async #drainOutbound(): Promise<void> {
    while (!this.#closed && this.#outboundQueue.length > 0) {
      const next = this.#outboundQueue.shift()!;
      this.#queuedOutboundBytes -= next.frame.byteLength;
      this.#inflightOutboundFrames += 1;
      this.#inflightOutboundBytes += next.frame.byteLength;

      try {
        await this.writeFully(next.frame);
        next.resolve();
      } catch (error) {
        const normalized = normalizeTransportError(error, "tcp send failed");
        next.reject(normalized);
        this.#rejectQueuedOutbound(normalized);
        if (this.options.onError) {
          void Promise.resolve(this.options.onError(normalized));
        }
        throw normalized;
      } finally {
        this.#inflightOutboundFrames -= 1;
        this.#inflightOutboundBytes -= next.frame.byteLength;
      }
    }
  }

  private async writeFully(frame: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < frame.byteLength) {
      const chunk = frame.subarray(offset);
      const writePromise = this.conn.write(chunk);
      const written = await this.awaitWithTimeout(
        writePromise,
        this.options.sendTimeoutMs,
        (timeoutMs) =>
          new TransportError(`tcp send timed out after ${timeoutMs}ms`),
      );

      if (!Number.isInteger(written) || written <= 0) {
        throw new TransportError(
          `invalid tcp write result: ${String(written)}`,
        );
      }
      offset += written;
    }
  }

  private async awaitWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number | undefined,
    onTimeout: (timeoutMs: number) => Error,
  ): Promise<T> {
    if (timeoutMs === undefined) {
      return await promise;
    }

    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(onTimeout(timeoutMs));
      }, timeoutMs);
      void promise.then(
        (value) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          reject(error);
        },
      );
    });
  }

  private async handleError(error: unknown): Promise<void> {
    const normalized = normalizeTransportError(error, "tcp transport error");
    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.tcp.error",
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

  #notifyClose(): void {
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    const onClose = this.options.onClose;
    if (!onClose) return;
    void Promise.resolve(onClose()).catch((error) => {
      const onError = this.options.onError;
      if (!onError) return;
      const normalized = normalizeTransportError(
        error,
        "tcp onClose callback failed",
      );
      void Promise.resolve(onError(normalized)).catch(() => {
        // Swallow callback failures to avoid unhandled rejections.
      });
    });
  }

  #rejectQueuedOutbound(error: unknown): void {
    while (this.#outboundQueue.length > 0) {
      const next = this.#outboundQueue.shift()!;
      this.#queuedOutboundBytes -= next.frame.byteLength;
      next.reject(error);
    }
  }

  private assertOutboundFrameSize(frame: Uint8Array): void {
    const max = this.options.maxOutboundFrameBytes;
    if (max !== undefined && frame.byteLength > max) {
      throw new TransportError(
        `tcp outbound frame size ${frame.byteLength} exceeds configured limit ${max}`,
      );
    }
  }

  private assertOutboundQueueCapacity(frameBytes: number): void {
    const maxFrames = this.options.maxQueuedOutboundFrames;
    if (maxFrames !== undefined) {
      const used = this.#inflightOutboundFrames + this.#outboundQueue.length;
      if (used + 1 > maxFrames) {
        throw new TransportError(
          `tcp outbound queue frame limit exceeded: ${used + 1} > ${maxFrames}`,
        );
      }
    }

    const maxBytes = this.options.maxQueuedOutboundBytes;
    if (maxBytes !== undefined) {
      const used = this.#inflightOutboundBytes + this.#queuedOutboundBytes;
      if (used + frameBytes > maxBytes) {
        throw new TransportError(
          `tcp outbound queue byte limit exceeded: ${
            used + frameBytes
          } > ${maxBytes}`,
        );
      }
    }
  }
}
