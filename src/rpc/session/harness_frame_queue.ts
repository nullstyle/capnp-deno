/**
 * Shared frame queue and waiter logic for RPC harness transports.
 *
 * @module
 */

import { SessionError } from "../../errors.ts";
import type { RpcClientCallOptions } from "./client.ts";

interface PendingFrameWaiter {
  resolve: (frame: Uint8Array) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

export class HarnessFrameQueue {
  #frames: Uint8Array[] = [];
  #waiters: PendingFrameWaiter[] = [];
  #closed = false;
  #closeError: SessionError = new SessionError("transport is closed");

  enqueue(frame: Uint8Array): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve(frame);
      return;
    }
    this.#frames.push(frame);
  }

  close(error = new SessionError("transport is closed")): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeError = error;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  async next(options: RpcClientCallOptions = {}): Promise<Uint8Array> {
    if (this.#frames.length > 0) {
      return this.#frames.shift()!;
    }
    if (this.#closed) {
      throw this.#closeError;
    }

    return await new Promise<Uint8Array>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const waiter: PendingFrameWaiter = {
        settled: false,
        resolve: (frame: Uint8Array): void => {
          if (waiter.settled) return;
          waiter.settled = true;
          this.#removeWaiter(waiter);
          cleanup();
          resolve(frame);
        },
        reject: (error: unknown): void => {
          if (waiter.settled) return;
          waiter.settled = true;
          this.#removeWaiter(waiter);
          cleanup();
          reject(error);
        },
      };
      const onAbort = (): void => {
        waiter.reject(new SessionError("rpc wait aborted"));
      };
      const cleanup = (): void => {
        if (timeout !== undefined) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      };

      if (options.signal?.aborted) {
        waiter.reject(new SessionError("rpc wait aborted"));
        return;
      }
      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          waiter.reject(
            new SessionError(`rpc wait timed out after ${options.timeoutMs}ms`),
          );
        }, options.timeoutMs);
      }
      if (options.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.#waiters.push(waiter);
    });
  }

  #removeWaiter(waiter: PendingFrameWaiter): void {
    const index = this.#waiters.indexOf(waiter);
    if (index >= 0) {
      this.#waiters.splice(index, 1);
    }
  }
}
