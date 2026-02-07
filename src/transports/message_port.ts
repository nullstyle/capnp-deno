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

export interface MessagePortTransportOptions {
  onError?: (error: unknown) => void | Promise<void>;
  rejectNonBinaryFrames?: boolean;
  closePortOnClose?: boolean;
  frameLimits?: CapnpFrameLimitsOptions;
  maxInboundFrameBytes?: number;
  maxOutboundFrameBytes?: number;
  maxQueuedOutboundFrames?: number;
  maxQueuedOutboundBytes?: number;
  sendTimeoutMs?: number;
  observability?: RpcObservability;
}

function toBinary(
  data: unknown,
  rejectNonBinary: boolean,
): Promise<Uint8Array | null> | Uint8Array | null {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  if (rejectNonBinary) {
    throw new TransportError("MessagePort non-binary payload is not supported");
  }
  return null;
}

export class MessagePortTransport implements RpcTransport {
  readonly port: MessagePort;
  readonly options: MessagePortTransportOptions;

  #started = false;
  #closed = false;
  #listenersAttached = false;
  #onFrame: ((frame: Uint8Array) => void | Promise<void>) | null = null;
  #inboundChain: Promise<void> = Promise.resolve();

  #outboundQueue: PendingOutboundFrame[] = [];
  #queuedOutboundBytes = 0;
  #inflightOutboundFrames = 0;
  #inflightOutboundBytes = 0;
  #drainLoop: Promise<void> | null = null;

  #onMessage = (event: MessageEvent) => {
    this.#inboundChain = this.#inboundChain
      .then(async () => {
        const rejectNonBinary = this.options.rejectNonBinaryFrames ?? true;
        const decoded = await toBinary(event.data, rejectNonBinary);
        if (!decoded) return;
        this.assertInboundFrameSize(decoded);
        if (this.options.frameLimits) {
          validateCapnpFrame(decoded, this.options.frameLimits);
        }

        const onFrame = this.#onFrame;
        if (!onFrame) return;
        await onFrame(decoded);
        emitObservabilityEvent(this.options.observability, {
          name: "rpc.transport.message_port.inbound_frame",
          attributes: {
            "rpc.outcome": "ok",
            "rpc.inbound.bytes": decoded.byteLength,
          },
        });
      })
      .catch((error) => this.#handleError(error));
  };

  #onMessageError = () => {
    this.#handleError(new TransportError("message port transport error"));
  };

  constructor(port: MessagePort, options: MessagePortTransportOptions = {}) {
    this.port = port;
    this.options = options;
  }

  start(
    onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): void {
    const startedAt = performance.now();
    if (this.#closed) {
      throw new TransportError("MessagePortTransport is closed");
    }
    if (this.#started) {
      throw new TransportError("MessagePortTransport already started");
    }

    this.#started = true;
    this.#onFrame = onFrame;
    if (!this.#listenersAttached) {
      this.port.addEventListener("message", this.#onMessage);
      this.port.addEventListener("messageerror", this.#onMessageError);
      this.#listenersAttached = true;
    }
    this.port.start();
    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.message_port.start",
      attributes: {
        "rpc.outcome": "ok",
      },
      durationMs: performance.now() - startedAt,
    });
  }

  async send(frame: Uint8Array): Promise<void> {
    const startedAt = performance.now();
    if (!this.#started) {
      throw new TransportError("MessagePortTransport not started");
    }
    if (this.#closed) {
      throw new TransportError("MessagePortTransport is closed");
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
      name: "rpc.transport.message_port.send_frame",
      attributes: {
        "rpc.outcome": "ok",
        "rpc.outbound.bytes": frame.byteLength,
        "rpc.outbound.queue.frames": this.#outboundQueue.length,
        "rpc.outbound.queue.bytes": this.#queuedOutboundBytes,
      },
      durationMs: performance.now() - startedAt,
    });
  }

  close(): void {
    if (this.#closed) return;
    const startedAt = performance.now();
    this.#closed = true;

    const closeError = new TransportError("MessagePortTransport is closed");
    this.#rejectQueuedOutbound(closeError);

    if (this.#listenersAttached) {
      this.port.removeEventListener("message", this.#onMessage);
      this.port.removeEventListener("messageerror", this.#onMessageError);
      this.#listenersAttached = false;
    }

    if (this.options.closePortOnClose ?? false) {
      this.port.close();
    }
    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.message_port.close",
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
      // Yield once before each postMessage so bursts of send() calls can be
      // bounded by queue limits instead of draining synchronously inline.
      await Promise.resolve();
      if (this.#closed || this.#outboundQueue.length === 0) break;

      const next = this.#outboundQueue.shift()!;
      this.#queuedOutboundBytes -= next.frame.byteLength;
      this.#inflightOutboundFrames += 1;
      this.#inflightOutboundBytes += next.frame.byteLength;

      try {
        const timeoutMs = this.options.sendTimeoutMs;
        if (
          timeoutMs !== undefined && (Date.now() - next.enqueuedAt) >= timeoutMs
        ) {
          throw new TransportError(
            `message port send timed out after ${timeoutMs}ms`,
          );
        }

        this.port.postMessage(new Uint8Array(next.frame));
        next.resolve();
      } catch (error) {
        next.reject(error);
        this.#rejectQueuedOutbound(error);
        this.#handleError(error);
        throw error;
      } finally {
        this.#inflightOutboundFrames -= 1;
        this.#inflightOutboundBytes -= next.frame.byteLength;
      }
    }
  }

  #handleError(error: unknown): void {
    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.message_port.error",
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
        `message port inbound frame size ${frame.byteLength} exceeds configured limit ${max}`,
      );
    }
  }

  private assertOutboundFrameSize(frame: Uint8Array): void {
    const max = this.options.maxOutboundFrameBytes;
    if (max !== undefined && frame.byteLength > max) {
      throw new TransportError(
        `message port outbound frame size ${frame.byteLength} exceeds configured limit ${max}`,
      );
    }
  }

  private assertOutboundQueueCapacity(frameBytes: number): void {
    const maxFrames = this.options.maxQueuedOutboundFrames;
    if (maxFrames !== undefined) {
      const used = this.#inflightOutboundFrames + this.#outboundQueue.length;
      if (used + 1 > maxFrames) {
        throw new TransportError(
          `message port outbound queue frame limit exceeded: ${
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
          `message port outbound queue byte limit exceeded: ${
            used + frameBytes
          } > ${maxBytes}`,
        );
      }
    }
  }
}
