import { TransportError } from "../errors.ts";
import {
  type CapnpFrameLimitsOptions,
  validateCapnpFrame,
} from "../frame_limits.ts";
import {
  emitObservabilityEvent,
  type RpcObservability,
} from "../observability.ts";
import type { RpcTransport } from "../transport.ts";

interface PendingOutboundFrame {
  frame: Uint8Array;
  enqueuedAt: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export interface WebSocketTransportOptions {
  onError?: (error: unknown) => void | Promise<void>;
  rejectTextFrames?: boolean;
  frameLimits?: CapnpFrameLimitsOptions;
  maxInboundFrameBytes?: number;
  maxOutboundFrameBytes?: number;
  maxQueuedOutboundFrames?: number;
  maxQueuedOutboundBytes?: number;
  maxSocketBufferedAmountBytes?: number;
  sendTimeoutMs?: number;
  connectTimeoutMs?: number;
  closeTimeoutMs?: number;
  outboundDrainIntervalMs?: number;
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

export class WebSocketTransport implements RpcTransport {
  readonly socket: WebSocket;
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

  static async connect(
    url: string | URL,
    protocols?: string | string[],
    options: WebSocketTransportOptions = {},
  ): Promise<WebSocketTransport> {
    const socket = protocols === undefined
      ? new WebSocket(url)
      : new WebSocket(url, protocols);

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
        next.reject(error);
        this.#rejectQueuedOutbound(error);
        throw error;
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
    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.websocket.error",
      attributes: {
        "rpc.outcome": "error",
      },
      error,
    });
    if (this.options.onError) {
      void Promise.resolve(this.options.onError(error));
      return;
    }
    throw error;
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
