/**
 * MessagePort transport for Cap'n Proto RPC.
 *
 * @module
 */

import { normalizeTransportError, TransportError } from "../../errors.ts";
import {
  type CapnpFrameLimitsOptions,
  validateCapnpFrame,
} from "../wire/frame_limits.ts";
import {
  emitObservabilityEvent,
  type RpcObservability,
} from "../../observability/observability.ts";
import type { RpcTransport } from "./internal/transport.ts";
import {
  OutboundFrameQueue,
  type QueuedOutboundFrame,
} from "./internal/transport_internal.ts";

interface PendingOutboundFrame extends QueuedOutboundFrame {
  enqueuedAt: number;
}

/**
 * Configuration options for {@link MessagePortTransport}.
 */
export interface MessagePortTransportOptions {
  /**
   * Error handler invoked when the transport encounters an error.
   * If not provided, errors are thrown.
   */
  onError?: (error: unknown) => void | Promise<void>;
  /**
   * Whether to reject non-binary (e.g. string) messages received on the port.
   * Defaults to `true`.
   */
  rejectNonBinaryFrames?: boolean;
  /** Whether to call `port.close()` when the transport is closed. Defaults to `false`. */
  closePortOnClose?: boolean;
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
  /** Maximum time in milliseconds a queued frame can wait before being sent. */
  sendTimeoutMs?: number;
  /** Observability provider for emitting transport events. */
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

/**
 * An {@link RpcTransport} implementation backed by the Web {@link MessagePort} API.
 *
 * Suitable for communication between browser tabs, workers, iframes, or any
 * environment that exposes a `MessagePort` interface (including Deno workers).
 * Binary data is transferred via `postMessage` with `Uint8Array` payloads.
 *
 * Outbound frames are queued and drained asynchronously to prevent blocking
 * the event loop. Inbound frames are delivered sequentially through a chain
 * of promises to preserve ordering.
 *
 * @example
 * ```ts
 * const channel = new MessageChannel();
 * const transport = new MessagePortTransport(channel.port1, {
 *   closePortOnClose: true,
 * });
 * transport.start((frame) => handleFrame(frame));
 * ```
 */
export class MessagePortTransport implements RpcTransport {
  /** The underlying `MessagePort` used for communication. */
  readonly port: MessagePort;
  /** The options this transport was configured with. */
  readonly options: MessagePortTransportOptions;

  #started = false;
  #closed = false;
  #listenersAttached = false;
  #onFrame: ((frame: Uint8Array) => void | Promise<void>) | null = null;
  #inboundChain: Promise<void> = Promise.resolve();

  #outbound: OutboundFrameQueue<PendingOutboundFrame>;
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
    this.#outbound = new OutboundFrameQueue("message port", options);
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

    const completion = new Promise<void>((resolve, reject) => {
      this.#outbound.enqueue({
        frame: payload,
        enqueuedAt: Date.now(),
        resolve,
        reject,
      });
    });

    this.#ensureDrainLoop();
    await completion;

    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.message_port.send_frame",
      attributes: {
        "rpc.outcome": "ok",
        "rpc.outbound.bytes": frame.byteLength,
        "rpc.outbound.queue.frames": this.#outbound.length,
        "rpc.outbound.queue.bytes": this.#outbound.queuedBytes,
      },
      durationMs: performance.now() - startedAt,
    });
  }

  close(): void {
    if (this.#closed) return;
    const startedAt = performance.now();
    this.#closed = true;

    const closeError = new TransportError("MessagePortTransport is closed");
    this.#outbound.rejectQueued(closeError);

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
        if (this.#outbound.hasQueuedFrames && !this.#closed) {
          this.#ensureDrainLoop();
        }
      });
  }

  async #drainOutbound(): Promise<void> {
    while (!this.#closed && this.#outbound.hasQueuedFrames) {
      // Yield once before each postMessage so bursts of send() calls can be
      // bounded by queue limits instead of draining synchronously inline.
      await Promise.resolve();
      if (this.#closed || !this.#outbound.hasQueuedFrames) break;

      const next = this.#outbound.dequeue();
      if (!next) break;

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
        const normalized = normalizeTransportError(
          error,
          "message port send failed",
        );
        next.reject(normalized);
        this.#outbound.rejectQueued(normalized);
        this.#handleError(normalized);
        throw normalized;
      } finally {
        this.#outbound.settle(next.frame.byteLength);
      }
    }
  }

  #handleError(error: unknown): void {
    const normalized = normalizeTransportError(
      error,
      "message port transport error",
    );
    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.message_port.error",
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
}
