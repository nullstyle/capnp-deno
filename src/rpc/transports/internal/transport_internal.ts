/**
 * Internal helpers shared across transport implementations.
 *
 * @module
 */

import { normalizeTransportError, TransportError } from "../../../errors.ts";

export interface QueuedOutboundFrame {
  frame: Uint8Array;
  resolve: () => void;
  reject: (error: unknown) => void;
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
  void Promise.resolve(onClose()).catch((error) => {
    if (!onError) return;
    const normalized = normalizeTransportError(error, onCloseErrorContext);
    void Promise.resolve(onError(normalized)).catch(() => {
      // Swallow callback failures to avoid unhandled rejections.
    });
  });
}
