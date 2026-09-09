/**
 * Internal helpers shared across transport implementations.
 *
 * @module
 */

import { normalizeTransportError, TransportError } from "../../../errors.ts";
import type { RpcTransport } from "./transport.ts";

/** Subscribe to terminal closure and safely detach, including synchronous replay. */
export function subscribeTransportClose(
  transport: RpcTransport,
  onClose: () => void,
): () => void {
  let unsubscribe: (() => void) | undefined;
  let closed = false;
  function detach(): void {
    const callback = unsubscribe;
    unsubscribe = undefined;
    try {
      callback?.();
    } catch {
      // Custom observer cleanup must not interrupt terminal state cleanup.
    }
  }
  unsubscribe = transport.subscribeClose?.(() => {
    if (closed) return;
    closed = true;
    try {
      onClose();
    } finally {
      detach();
    }
  });
  if (closed) detach();
  return detach;
}

export interface QueuedOutboundFrame {
  frame: Uint8Array;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export interface OutboundFrameQueueStats {
  queuedFrames: number;
  queuedBytes: number;
  inflightFrames: number;
  inflightBytes: number;
}

export interface OutboundFrameQueueOptions {
  maxQueuedOutboundFrames?: number;
  maxQueuedOutboundBytes?: number;
}

export class OutboundFrameQueue<T extends QueuedOutboundFrame> {
  readonly #transportName: string;
  readonly #options: OutboundFrameQueueOptions;
  readonly #queue: T[] = [];
  #queuedBytes = 0;
  #inflightFrames = 0;
  #inflightBytes = 0;

  constructor(
    transportName: string,
    options: OutboundFrameQueueOptions = {},
  ) {
    this.#transportName = transportName;
    this.#options = options;
  }

  get hasQueuedFrames(): boolean {
    return this.#queue.length > 0;
  }

  get length(): number {
    return this.#queue.length;
  }

  get queuedBytes(): number {
    return this.#queuedBytes;
  }

  get inflightFrames(): number {
    return this.#inflightFrames;
  }

  get inflightBytes(): number {
    return this.#inflightBytes;
  }

  get stats(): OutboundFrameQueueStats {
    return {
      queuedFrames: this.#queue.length,
      queuedBytes: this.#queuedBytes,
      inflightFrames: this.#inflightFrames,
      inflightBytes: this.#inflightBytes,
    };
  }

  enqueue(frame: T): void {
    this.assertCapacity(frame.frame.byteLength);
    this.#queue.push(frame);
    this.#queuedBytes += frame.frame.byteLength;
  }

  dequeue(): T | undefined {
    const next = this.#queue.shift();
    if (!next) return undefined;
    this.#queuedBytes -= next.frame.byteLength;
    this.#inflightFrames += 1;
    this.#inflightBytes += next.frame.byteLength;
    return next;
  }

  settle(frameBytes: number): void {
    this.#inflightFrames -= 1;
    this.#inflightBytes -= frameBytes;
  }

  rejectQueued(error: unknown): void {
    while (this.#queue.length > 0) {
      const next = this.#queue.shift()!;
      this.#queuedBytes -= next.frame.byteLength;
      next.reject(error);
    }
  }

  private assertCapacity(frameBytes: number): void {
    const maxFrames = this.#options.maxQueuedOutboundFrames;
    if (maxFrames !== undefined) {
      const used = this.#inflightFrames + this.#queue.length;
      if (used + 1 > maxFrames) {
        throw new TransportError(
          `${this.#transportName} outbound queue frame limit exceeded: ${
            used + 1
          } > ${maxFrames}`,
        );
      }
    }

    const maxBytes = this.#options.maxQueuedOutboundBytes;
    if (maxBytes !== undefined) {
      const used = this.#inflightBytes + this.#queuedBytes;
      if (used + frameBytes > maxBytes) {
        throw new TransportError(
          `${this.#transportName} outbound queue byte limit exceeded: ${
            used + frameBytes
          } > ${maxBytes}`,
        );
      }
    }
  }
}

export async function awaitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  onTimeout: (timeoutMs: number) => Error,
): Promise<T> {
  if (timeoutMs === undefined) {
    return await promise;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function notifyTransportClose(options: {
  onClose?: () => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}, onCloseErrorContext: string): void {
  const { onClose, onError } = options;
  if (!onClose) return;
  void (async () => {
    try {
      await onClose();
    } catch (error) {
      if (!onError) return;
      const normalized = normalizeTransportError(error, onCloseErrorContext);
      try {
        await onError(normalized);
      } catch {
        // Observers must not interrupt shutdown or cause unhandled rejections.
      }
    }
  })();
}

/** Report a transport error without allowing observer failures to escape. */
export function notifyTransportError(
  onError: ((error: unknown) => void | Promise<void>) | undefined,
  error: unknown,
): void {
  if (!onError) return;
  void (async () => {
    try {
      await onError(error);
    } catch {
      // Error observers must not replace the transport failure or escape globally.
    }
  })();
}

/** One-shot closure notification shared by the built-in transports. */
export class TransportCloseSignal {
  #closed = false;
  #observers = new Set<() => void | Promise<void>>();

  subscribe(onClose: () => void | Promise<void>): () => void {
    // A distinct registration allows the same observer to subscribe twice.
    const observer = () => onClose();
    if (this.#closed) {
      notifyTransportClose(
        { onClose: observer },
        "transport close observer failed",
      );
    } else {
      this.#observers.add(observer);
    }
    return () => {
      this.#observers.delete(observer);
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const observers = [...this.#observers];
    this.#observers.clear();
    for (const onClose of observers) {
      notifyTransportClose({ onClose }, "transport close observer failed");
    }
  }
}
