/**
 * WebSocket transport for Cap'n Proto RPC.
 *
 * @module
 */

import { normalizeTransportError, TransportError } from "../../errors.ts";
import {
  type CapnpFrameLimitsOptions,
  validateCapnpFrame,
} from "../frame_limits.ts";
import {
  emitObservabilityEvent,
  type RpcObservability,
} from "../../observability.ts";
import type { RpcTransport } from "../transport.ts";

interface PendingOutboundFrame {
  frame: Uint8Array;
  enqueuedAt: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * Configuration options for {@link WebSocketTransport}.
 */
export interface WebSocketTransportOptions {
  /**
   * Error handler invoked when the transport encounters an error.
   * If not provided, errors are thrown.
   */
  onError?: (error: unknown) => void | Promise<void>;
  /**
   * Whether to reject WebSocket text frames. Cap'n Proto uses binary only.
   * Defaults to `true`.
   */
  rejectTextFrames?: boolean;
  /** Cap'n Proto frame validation limits applied to inbound frames. */
  frameLimits?: CapnpFrameLimitsOptions;
  /** Maximum allowed size in bytes for a single inbound frame. */
  maxInboundFrameBytes?: number;
  /** Maximum allowed size in bytes for a single outbound frame. */
  maxOutboundFrameBytes?: number;
  /** Maximum number of outbound frames that can be queued. */
  maxQueuedOutboundFrames?: number;
  /** Maximum total bytes across all queued outbound frames. */
  maxQueuedOutboundBytes?: number;
  /**
   * Maximum bytes the WebSocket is allowed to have buffered before the
   * transport applies backpressure (waits before sending more).
   */
  maxSocketBufferedAmountBytes?: number;
  /** Maximum time in milliseconds for a send operation before timing out. */
  sendTimeoutMs?: number;
  /** Maximum time in milliseconds to wait for the WebSocket connection to open. */
  connectTimeoutMs?: number;
  /** Maximum time in milliseconds to wait for the WebSocket to close gracefully. */
  closeTimeoutMs?: number;
  /**
   * Interval in milliseconds between backpressure checks when waiting for
   * the socket's buffered amount to drain. Defaults to 4.
   */
  outboundDrainIntervalMs?: number;
  /** Observability provider for emitting transport events. */
  observability?: RpcObservability;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function toBinary(
  data: string | ArrayBuffer | Blob | ArrayBufferView,
  rejectText: boolean,
): Promise<Uint8Array | null> | Uint8Array | null {
  if (typeof data === "string") {
    if (rejectText) {
      throw new TransportError(
        "WebSocket text frame is not supported for Cap'n Proto RPC",
      );
    }
    return null;
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof Blob) {
    return data.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  throw new TransportError("unsupported websocket message payload");
}

/**
 * An {@link RpcTransport} implementation that communicates over a WebSocket connection.
 *
 * Binary frames are sent and received via the standard `WebSocket` API with
 * `binaryType` set to `"arraybuffer"`. Outbound frames are queued and drained
 * asynchronously with backpressure based on the socket's `bufferedAmount`.
 *
 * Use the static {@link connect} factory method to establish a new WebSocket
 * connection, or pass an already-open `WebSocket` directly to the constructor.
 *
 * @example
 * ```ts
 * const transport = await WebSocketTransport.connect("ws://localhost:8080/rpc", undefined, {
 *   connectTimeoutMs: 5000,
 *   maxSocketBufferedAmountBytes: 1_000_000,
 * });
 * transport.start((frame) => handleFrame(frame));
 * ```
 */
export class WebSocketTransport implements RpcTransport {
  /** The underlying WebSocket connection. */
  readonly socket: WebSocket;
  /** The options this transport was configured with. */
  readonly options: WebSocketTransportOptions;

  #started = false;
  #closed = false;
  #socketClosed = false;
  #onFrame: ((frame: Uint8Array) => void | Promise<void>) | null = null;
  #inboundChain: Promise<void> = Promise.resolve();
  #listenersAttached = false;

  #outboundQueue: PendingOutboundFrame[] = [];
  #queuedOutboundBytes = 0;
  #inflightOutboundFrames = 0;
  #inflightOutboundBytes = 0;
  #drainLoop: Promise<void> | null = null;

  #onMessage = (event: MessageEvent) => {
    this.#inboundChain = this.#inboundChain
      .then(async () => {
        const rejectText = this.options.rejectTextFrames ?? true;
        const decoded = await toBinary(event.data, rejectText);
        if (!decoded) return;
        this.assertInboundFrameSize(decoded);
        if (this.options.frameLimits) {
          validateCapnpFrame(decoded, this.options.frameLimits);
        }
        const onFrame = this.#onFrame;
        if (!onFrame) return;
        await onFrame(decoded);
        emitObservabilityEvent(this.options.observability, {
          name: "rpc.transport.websocket.inbound_frame",
          attributes: {
            "rpc.outcome": "ok",
            "rpc.inbound.bytes": decoded.byteLength,
          },
        });
      })
      .catch((error) => this.#handleError(error));
  };

  #onError = (_event: Event) => {
    this.#handleError(new TransportError("websocket transport error"));
  };

  #onClose = (event: CloseEvent) => {
    this.#socketClosed = true;
    const error = new TransportError(
      `websocket closed (code=${event.code} reason=${event.reason || ""})`,
    );
    this.#rejectQueuedOutbound(error);
    if (this.options.onError) {
      void Promise.resolve(this.options.onError(error));
    }
  };

  constructor(socket: WebSocket, options: WebSocketTransportOptions = {}) {
    this.socket = socket;
    this.options = options;
    this.socket.binaryType = "arraybuffer";
  }

  /**
   * Open a new WebSocket connection and wrap it in a {@link WebSocketTransport}.
   *
   * @param url - The WebSocket URL to connect to (e.g. `"ws://localhost:8080/rpc"`).
   * @param protocols - Optional sub-protocol(s) to request during the handshake.
   * @param options - Transport options including connect timeout.
   * @returns A new `WebSocketTransport` wrapping the opened connection.
   * @throws {TransportError} If the connection fails or times out.
   */
  static async connect(
    url: string | URL,
    protocols?: string | string[],
    options: WebSocketTransportOptions = {},
  ): Promise<WebSocketTransport> {
    let socket: WebSocket;
    try {
      socket = protocols === undefined
        ? new WebSocket(url)
        : new WebSocket(url, protocols);
    } catch (error) {
      throw normalizeTransportError(
        error,
        `failed to create websocket: ${String(url)}`,
      );
    }

    const timeoutMs = options.connectTimeoutMs;
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        if (timer !== null) clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onErr);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(
          new TransportError(`failed to connect websocket: ${String(url)}`),
        );
      };

      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onErr, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          cleanup();
          try {
            socket.close();
          } catch {
            // no-op
          }
          reject(
            new TransportError(
              `websocket connect timed out after ${timeoutMs}ms: ${
                String(url)
              }`,
            ),
          );
        }, timeoutMs);
      }
    });

    return new WebSocketTransport(socket, options);
  }

  start(
    onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): void {
    const startedAt = performance.now();
    if (this.#closed) throw new TransportError("WebSocketTransport is closed");
    if (this.#started) {
      throw new TransportError("WebSocketTransport already started");
    }

    this.#started = true;
    this.#onFrame = onFrame;
    if (!this.#listenersAttached) {
      this.socket.addEventListener("message", this.#onMessage);
      this.socket.addEventListener("error", this.#onError);
      this.socket.addEventListener("close", this.#onClose);
      this.#listenersAttached = true;
    }
    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.websocket.start",
      attributes: {
        "rpc.outcome": "ok",
      },
      durationMs: performance.now() - startedAt,
    });
  }

  async send(frame: Uint8Array): Promise<void> {
    const startedAt = performance.now();
    if (!this.#started) {
      throw new TransportError("WebSocketTransport not started");
    }
    if (this.#closed) throw new TransportError("WebSocketTransport is closed");
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new TransportError(
        `websocket not open: readyState=${this.socket.readyState}`,
      );
    }

    this.assertOutboundFrameSize(frame);
    const payload = new Uint8Array(frame);
    this.assertOutboundQueueCapacity(payload.byteLength);

    const completion = new Promise<void>((resolve, reject) => {
      this.#outboundQueue.push({
        frame: payload,
        enqueuedAt: Date.now(),
        resolve,
        reject,
      });
      this.#queuedOutboundBytes += payload.byteLength;
    });

    this.#ensureDrainLoop();
    await completion;

    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.websocket.send_frame",
      attributes: {
        "rpc.outcome": "ok",
        "rpc.outbound.bytes": frame.byteLength,
        "rpc.outbound.queue.frames": this.#outboundQueue.length,
        "rpc.outbound.queue.bytes": this.#queuedOutboundBytes,
        "rpc.websocket.buffered_amount": this.socket.bufferedAmount,
      },
      durationMs: performance.now() - startedAt,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    const startedAt = performance.now();
    this.#closed = true;

    const closeError = new TransportError("WebSocketTransport is closed");
    this.#rejectQueuedOutbound(closeError);

    const closeNeeded = this.socket.readyState === WebSocket.CONNECTING ||
      this.socket.readyState === WebSocket.OPEN;

    if (closeNeeded) {
      try {
        this.socket.close();
      } catch {
        // no-op
      }

      const closeTimeoutMs = this.options.closeTimeoutMs;
      if (closeTimeoutMs === undefined) {
        await this.#waitForClose();
      } else {
        await Promise.race([
          this.#waitForClose(),
          delay(closeTimeoutMs),
        ]);
      }
    }

    if (this.#listenersAttached) {
      this.socket.removeEventListener("message", this.#onMessage);
      this.socket.removeEventListener("error", this.#onError);
      this.socket.removeEventListener("close", this.#onClose);
      this.#listenersAttached = false;
    }

    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.websocket.close",
      attributes: {
        "rpc.outcome": "ok",
      },
      durationMs: performance.now() - startedAt,
    });
  }

  #ensureDrainLoop(): void {
    if (this.#drainLoop) return;
    this.#drainLoop = this.#drainOutbound()
      .catch((_error) => {
        // queued send callers already receive the error.
      })
      .finally(() => {
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
        await this.#waitForBufferedCapacity(
          next.frame.byteLength,
          next.enqueuedAt,
        );
        this.socket.send(next.frame);
        next.resolve();
      } catch (error) {
        const normalized = normalizeTransportError(
          error,
          "websocket send failed",
        );
        next.reject(normalized);
        this.#rejectQueuedOutbound(normalized);
        throw normalized;
      } finally {
        this.#inflightOutboundFrames -= 1;
        this.#inflightOutboundBytes -= next.frame.byteLength;
      }
    }
  }

  async #waitForBufferedCapacity(
    frameBytes: number,
    startedAtMs: number,
  ): Promise<void> {
    const maxBuffered = this.options.maxSocketBufferedAmountBytes;
    if (maxBuffered === undefined) return;

    const timeoutMs = this.options.sendTimeoutMs;
    const intervalMs = this.options.outboundDrainIntervalMs ?? 4;

    while (!this.#closed) {
      if (this.socket.readyState !== WebSocket.OPEN) {
        throw new TransportError(
          `websocket not open: readyState=${this.socket.readyState}`,
        );
      }
      if (this.socket.bufferedAmount + frameBytes <= maxBuffered) {
        return;
      }
      if (timeoutMs !== undefined && (Date.now() - startedAtMs) >= timeoutMs) {
        throw new TransportError(
          `websocket send timed out after ${timeoutMs}ms`,
        );
      }
      await delay(intervalMs);
    }

    throw new TransportError("WebSocketTransport is closed");
  }

  #handleError(error: unknown): void {
    const normalized = normalizeTransportError(
      error,
      "websocket transport error",
    );
    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.websocket.error",
      attributes: {
        "rpc.outcome": "error",
      },
      error: normalized,
    });
    if (this.options.onError) {
      void Promise.resolve(this.options.onError(normalized));
      return;
    }
    throw normalized;
  }

  async #waitForClose(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED || this.#socketClosed) {
      return;
    }
    await new Promise<void>((resolve) => {
      const onClose = (): void => {
        this.socket.removeEventListener("close", onClose);
        resolve();
      };
      this.socket.addEventListener("close", onClose, { once: true });
    });
  }

  #rejectQueuedOutbound(error: unknown): void {
    while (this.#outboundQueue.length > 0) {
      const next = this.#outboundQueue.shift()!;
      this.#queuedOutboundBytes -= next.frame.byteLength;
      next.reject(error);
    }
  }

  private assertInboundFrameSize(frame: Uint8Array): void {
    const max = this.options.maxInboundFrameBytes;
    if (max !== undefined && frame.byteLength > max) {
      throw new TransportError(
        `websocket inbound frame size ${frame.byteLength} exceeds configured limit ${max}`,
      );
    }
  }

  private assertOutboundFrameSize(frame: Uint8Array): void {
    const max = this.options.maxOutboundFrameBytes;
    if (max !== undefined && frame.byteLength > max) {
      throw new TransportError(
        `websocket outbound frame size ${frame.byteLength} exceeds configured limit ${max}`,
      );
    }
  }

  private assertOutboundQueueCapacity(frameBytes: number): void {
    const maxFrames = this.options.maxQueuedOutboundFrames;
    if (maxFrames !== undefined) {
      const used = this.#inflightOutboundFrames + this.#outboundQueue.length;
      if (used + 1 > maxFrames) {
        throw new TransportError(
          `websocket outbound queue frame limit exceeded: ${
            used + 1
          } > ${maxFrames}`,
        );
      }
    }

    const maxBytes = this.options.maxQueuedOutboundBytes;
    if (maxBytes !== undefined) {
      const used = this.#inflightOutboundBytes + this.#queuedOutboundBytes;
      if (used + frameBytes > maxBytes) {
        throw new TransportError(
          `websocket outbound queue byte limit exceeded: ${
            used + frameBytes
          } > ${maxBytes}`,
        );
      }
    }
  }
}
