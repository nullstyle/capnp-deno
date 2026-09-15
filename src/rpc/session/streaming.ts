/**
 * Cap'n Proto streaming utilities.
 *
 * Provides a {@link StreamSender} abstraction for sending a sequence of RPC
 * calls with client-side flow control. Cap'n Proto streaming uses regular
 * Call/Return messages; the sender limits concurrency to provide backpressure.
 *
 * @module
 */

import { SessionError } from "../../errors.ts";

/** Current lifecycle state of a {@link StreamSender}. */
export type StreamSenderState =
  | "open"
  | "draining"
  | "canceling"
  | "canceled"
  | "failed";

/**
 * Context for a single streaming call.
 */
export interface StreamSendContext {
  /** Zero-based index of the streaming call within this sender. */
  readonly index: number;
  /** Abort signal scoped to this send. */
  readonly signal: AbortSignal;
  /**
   * Acquire the sender's single encoding slot before constructing encoded
   * parameters. Generated helpers call this automatically when byte bounded.
   * The slot is released by reserveBytes(), or when the call rejects.
   */
  prepare(): Promise<void>;
  /**
   * Reserve the exact encoded parameter-message length before sending it.
   * Excludes RPC envelopes, capability descriptors, and transport queues.
   * Non-Uint8Array call functions must use this hook when a byte limit is set.
   */
  reserveBytes(byteLength: number): Promise<void>;
}

/**
 * A function that sends a single streaming call and returns the result.
 *
 * The caller provides the encoded params and receives the response bytes.
 * The implementation is typically a thin wrapper around
 * `client.call(capability, methodId, params)`.
 */
export type StreamCallFn<TParams = Uint8Array, TResult = Uint8Array> = (
  params: TParams,
  context: StreamSendContext,
) => Promise<TResult>;

/**
 * Options for creating a {@link StreamSender}.
 */
export interface StreamSenderOptions<TResult = Uint8Array> {
  /**
   * Maximum number of in-flight calls before the sender blocks.
   * Controls the streaming window size. Defaults to `8`.
   */
  maxInFlight?: number;
  /**
   * Maximum admitted encoded parameter-message bytes awaiting ordered
   * completion. Unset means unlimited. Generated helpers serialize once and
   * reserve the exact length before sending. One encoded candidate may wait
   * outside this budget; its length is exposed as pendingEncodedBytes.
   */
  maxInFlightBytes?: number;
  /**
   * Called for each successful response in order.
   * Can be used to track progress or accumulate results.
   */
  onResponse?: (response: TResult, index: number) => void | Promise<void>;
  /**
   * Called when a streaming call fails. If this callback throws or is not
   * provided, the error propagates to {@link StreamSender.send} or
   * {@link StreamSender.flush}.
   */
  onError?: (error: unknown, index: number) => void;
  /** Abort signal to cancel the stream. */
  signal?: AbortSignal;
}

/** Options for waiting until a {@link StreamSender} has capacity. */
export interface StreamSenderWaitOptions {
  /** Minimum parameter bytes needed, if known. Defaults to one byte with a byte limit. */
  byteLength?: number;
  /** Abort signal that cancels only the capacity wait, not the stream itself. */
  signal?: AbortSignal;
}

/**
 * Tracks an in-flight streaming call.
 */
interface InFlightCall<TResult> {
  readonly index: number;
  readonly abortController: AbortController;
  readonly cleanup: () => void;
  byteLength: number;
  settled?: StreamCallSettled<TResult>;
}

type StreamCallSettled<TResult> =
  | { ok: true; value: TResult }
  | { ok: false; error: unknown };

interface StreamDrainOptions extends StreamSenderWaitOptions {
  readonly allowClosed?: boolean;
}

/**
 * A stream sender that provides flow-controlled, ordered streaming of
 * RPC calls over a Cap'n Proto connection.
 *
 * Usage:
 * ```ts
 * const sender = createStreamSender(
 *   (params) => client.call(cap, methodId, params),
 *   { maxInFlight: 4 },
 * );
 *
 * for (const chunk of chunks) {
 *   await sender.send(encodeChunk(chunk));
 * }
 * await sender.flush();
 * ```
 */
export interface StreamSender<TParams = Uint8Array, TResult = Uint8Array> {
  /**
   * Send one streaming call. Blocks if the in-flight window is full,
   * providing natural backpressure.
   *
   * @param params - Parameters for one generated streaming method call.
   * @returns Resolves once the call has been accepted into the in-flight window.
   */
  send(params: TParams): Promise<void>;

  /**
   * Wait until an in-flight slot and the requested byte capacity are available.
   *
   * This exposes the same backpressure boundary used by {@link send} without
   * starting another RPC call, which is useful when producing stream items is
   * expensive and should pause before allocating more work.
   *
   * @param options - Optional abort signal and encoded byte requirement.
   * @returns Resolves when both count and configured byte limits allow admission.
   *
   * @example
   * ```ts
   * await sender.waitForCapacity();
   * const next = await readNextExpensiveChunk();
   * await sender.send(next);
   * ```
   */
  waitForCapacity(options?: StreamSenderWaitOptions): Promise<void>;

  /**
   * Wait for all in-flight calls to complete. Must be called after
   * the last {@link send} to ensure all responses are received.
   *
   * @returns Resolves after every accepted stream call has completed.
   */
  flush(): Promise<void>;

  /**
   * Abort all in-flight calls and prevent new calls from being sent.
   *
   * @param reason - Optional cancellation reason propagated to in-flight calls.
   * @returns Resolves after in-flight calls have been drained, or rejects with
   * the first unhandled in-flight error.
   */
  cancel(reason?: unknown): Promise<void>;

  /** Lifecycle state for diagnostics and producer coordination. */
  readonly state: StreamSenderState;

  /** Maximum number of calls allowed in-flight at once. */
  readonly maxInFlight: number;

  /** Number of calls currently in-flight. */
  readonly inFlight: number;

  /** Configured parameter-message byte budget, or null when unlimited. */
  readonly maxInFlightBytes: number | null;

  /** Admitted encoded parameter-message bytes awaiting ordered completion. */
  readonly inFlightBytes: number;

  /** Bytes of the single encoded candidate waiting for admission. */
  readonly pendingEncodedBytes: number;

  /** Total calls accepted into the count window, including preparations. */
  readonly totalSent: number;

  /** Total number of responses received so far. */
  readonly totalReceived: number;
}

/**
 * Create a {@link StreamSender} that wraps an RPC call function with
 * flow-controlled streaming.
 *
 * @param callFn - Function that performs the actual RPC call.
 * @param options - Streaming configuration.
 * @returns A new stream sender.
 *
 * @example
 * ```ts
 * const sender = createStreamSender(
 *   (params, context) =>
 *     client.call(capability, methodId, params, { signal: context.signal }),
 *   { maxInFlight: 4 },
 * );
 *
 * for (const chunk of chunks) {
 *   await sender.send(chunk);
 * }
 * await sender.flush();
 * ```
 */
export function createStreamSender(
  callFn: StreamCallFn,
  options?: StreamSenderOptions,
): StreamSender;
export function createStreamSender<TParams, TResult = Uint8Array>(
  callFn: StreamCallFn<TParams, TResult>,
  options?: StreamSenderOptions<TResult>,
): StreamSender<TParams, TResult>;
export function createStreamSender<TParams, TResult = Uint8Array>(
  callFn: StreamCallFn<TParams, TResult>,
  options: StreamSenderOptions<TResult> = {},
): StreamSender<TParams, TResult> {
  const maxInFlight = options.maxInFlight ?? 8;
  if (maxInFlight < 1 || !Number.isInteger(maxInFlight)) {
    throw new SessionError(
      `maxInFlight must be a positive integer, got ${String(maxInFlight)}`,
    );
  }

  const maxInFlightBytes = options.maxInFlightBytes ?? null;
  if (
    maxInFlightBytes !== null &&
    (!Number.isSafeInteger(maxInFlightBytes) || maxInFlightBytes < 1)
  ) {
    throw new SessionError("maxInFlightBytes must be a positive safe integer");
  }
  let inFlightBytes = 0;
  let pendingEncodedBytes = 0;
  let encodingTail: Promise<void> = Promise.resolve();

  function validateByteLength(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SessionError(
        "encoded byte length must be a non-negative safe integer",
      );
    }
    if (maxInFlightBytes !== null && value > maxInFlightBytes) {
      throw new SessionError(
        `encoded stream item (${value} bytes) exceeds maxInFlightBytes (${maxInFlightBytes})`,
      );
    }
  }

  function hasByteCapacity(byteLength: number): boolean {
    return maxInFlightBytes === null ||
      byteLength <= maxInFlightBytes - inFlightBytes;
  }

  const signal = options.signal;
  const onResponse = options.onResponse;
  const onError = options.onError;
  const streamAbortController = new AbortController();

  const inFlightCalls: InFlightCall<TResult>[] = [];
  const readyResponses: InFlightCall<TResult>[] = [];
  const stateWaiters = new Set<() => void>();
  let nextIndex = 0;
  let totalReceived = 0;
  let firstError: unknown = undefined;
  let hasError = false;
  let canceled = false;
  let cancelReason: unknown = undefined;
  let drainDepth = 0;
  let drainTail: Promise<void> = Promise.resolve();

  function abortReasonFromSignal(source: AbortSignal): unknown {
    return source.reason ?? new SessionError("stream aborted");
  }

  function notifyStateChange(): void {
    if (stateWaiters.size === 0) return;
    const waiters = [...stateWaiters];
    stateWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  function currentState(): StreamSenderState {
    const streamClosed = canceled ||
      streamAbortController.signal.aborted ||
      signal?.aborted === true;
    if (streamClosed) {
      return inFlightCalls.length > 0 ? "canceling" : "canceled";
    }
    if (hasError) return "failed";
    if (drainDepth > 0) return "draining";
    return "open";
  }

  function checkAborted(): void {
    if (signal?.aborted) {
      throw new SessionError("stream aborted", {
        cause: abortReasonFromSignal(signal),
      });
    }
    if (canceled || streamAbortController.signal.aborted) {
      throw cancelReason instanceof SessionError
        ? cancelReason
        : new SessionError("stream canceled", { cause: cancelReason });
    }
  }

  function checkError(): void {
    if (hasError) {
      throw firstError;
    }
  }

  function rememberError(error: unknown): void {
    if (!hasError) {
      hasError = true;
      firstError = error;
      notifyStateChange();
    }
  }

  function waitForStateChange(
    options: StreamSenderWaitOptions = {},
  ): Promise<void> {
    if (options.signal?.aborted) {
      return Promise.reject(
        options.signal.reason ??
          new SessionError("stream capacity wait aborted"),
      );
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (
        complete: () => void,
      ): void => {
        if (settled) return;
        settled = true;
        stateWaiters.delete(onChange);
        options.signal?.removeEventListener("abort", onWaitAbort);
        signal?.removeEventListener("abort", onStreamAbort);
        streamAbortController.signal.removeEventListener(
          "abort",
          onStreamAbort,
        );
        complete();
      };
      const onChange = (): void => finish(resolve);
      const onWaitAbort = (): void =>
        finish(() =>
          reject(
            options.signal?.reason ??
              new SessionError("stream capacity wait aborted"),
          )
        );
      const onStreamAbort = (): void => finish(resolve);

      stateWaiters.add(onChange);
      options.signal?.addEventListener("abort", onWaitAbort, { once: true });
      signal?.addEventListener("abort", onStreamAbort, { once: true });
      streamAbortController.signal.addEventListener("abort", onStreamAbort, {
        once: true,
      });
    });
  }

  function withDrainLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = drainTail;
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    drainTail = previous.then(() => next, () => next);
    const run = async (): Promise<T> => {
      drainDepth += 1;
      notifyStateChange();
      try {
        return await operation();
      } finally {
        drainDepth -= 1;
        release();
        notifyStateChange();
      }
    };
    return previous.then(run, run);
  }

  async function takeSettledHead(
    options: StreamDrainOptions,
  ): Promise<InFlightCall<TResult> | undefined> {
    const oldest = inFlightCalls[0];
    if (!oldest) return undefined;

    while (!oldest.settled) {
      if (!options.allowClosed) {
        checkAborted();
        checkError();
      }
      await waitForStateChange(options);
    }

    totalReceived++;
    inFlightBytes -= oldest.byteLength;
    oldest.cleanup();
    if (inFlightCalls[0] === oldest) {
      inFlightCalls.shift();
    } else {
      const index = inFlightCalls.indexOf(oldest);
      if (index >= 0) {
        inFlightCalls.splice(index, 1);
      }
    }
    notifyStateChange();
    return oldest;
  }

  async function deliverSettled(call: InFlightCall<TResult>): Promise<void> {
    const settled = call.settled;
    if (!settled) return;
    if (settled.ok) {
      if (!onResponse) return;
      try {
        await onResponse(settled.value, call.index);
      } catch (error) {
        rememberError(error);
        throw error;
      }
      return;
    }
    if (onError) {
      try {
        onError(settled.error, call.index);
      } catch (error) {
        rememberError(error);
        throw error;
      }
      return;
    }
    rememberError(settled.error);
    throw settled.error;
  }

  async function deliverReadyResponses(): Promise<void> {
    while (readyResponses.length > 0) {
      // Remove before invoking user code so re-entrant flush/send can drain
      // the remainder without waiting for their own callback to finish.
      await deliverSettled(readyResponses.shift()!);
    }
  }

  async function drainOne(options: StreamDrainOptions = {}): Promise<void> {
    // The lock only guards waiting for the window head to settle and removing
    // it. User callbacks run after the lock is released and the call has left
    // the window, so re-entrant send()/flush()/waitForCapacity()/cancel()
    // calls from inside a callback cannot deadlock on the drain in progress.
    const drained = await withDrainLock(() => takeSettledHead(options));
    if (drained) readyResponses.push(drained);
    await deliverReadyResponses();
  }

  async function waitForCapacity(
    options: StreamSenderWaitOptions = {},
  ): Promise<void> {
    checkAborted();
    checkError();
    const byteLength = options.byteLength ??
      (maxInFlightBytes === null ? 0 : 1);
    validateByteLength(byteLength);
    while (
      inFlightCalls.length >= maxInFlight || !hasByteCapacity(byteLength)
    ) {
      await drainOne(options);
      checkAborted();
      checkError();
    }
  }

  return {
    async send(params: TParams): Promise<void> {
      checkAborted();
      checkError();
      // The final capacity check and the push into the window below must
      // share one synchronous segment (async bodies run synchronously until
      // the first await): an intervening microtask would let unawaited
      // concurrent sends overshoot maxInFlight and let a same-task cancel()
      // miss this call.
      const initialBytes = params instanceof Uint8Array ? params.byteLength : 0;
      validateByteLength(initialBytes);
      while (
        inFlightCalls.length >= maxInFlight || !hasByteCapacity(initialBytes)
      ) {
        await drainOne();
        checkAborted();
        checkError();
      }

      const index = nextIndex++;
      const abortController = new AbortController();
      const cleanupCallbacks: Array<() => void> = [];
      const relayAbort = (source: AbortSignal): void => {
        const onAbort = (): void => {
          abortController.abort(abortReasonFromSignal(source));
        };
        if (source.aborted) {
          onAbort();
          return;
        }
        source.addEventListener("abort", onAbort, { once: true });
        cleanupCallbacks.push(() =>
          source.removeEventListener("abort", onAbort)
        );
      };
      if (signal) relayAbort(signal);
      relayAbort(streamAbortController.signal);

      let ownsEncoding = false;
      let releaseEncodingTicket: (() => void) | undefined;
      const previousEncoding = encodingTail;
      if (maxInFlightBytes !== null && !(params instanceof Uint8Array)) {
        const ticket = new Promise<void>((resolve) => {
          releaseEncodingTicket = resolve;
        });
        encodingTail = previousEncoding.then(() => ticket, () => ticket);
      }
      let bytesReserved = params instanceof Uint8Array;
      let resolveAdmission!: () => void;
      let rejectAdmission!: (error: unknown) => void;
      const admission = new Promise<void>((resolve, reject) => {
        resolveAdmission = resolve;
        rejectAdmission = reject;
      });
      // The rejection is observed immediately even when the caller awaits a
      // preceding send. send() still returns the original admission promise.
      admission.catch(() => {});
      const releaseEncoding = (): void => {
        if (ownsEncoding) {
          ownsEncoding = false;
          pendingEncodedBytes = 0;
        }
        releaseEncodingTicket?.();
        releaseEncodingTicket = undefined;
        notifyStateChange();
      };
      const call: InFlightCall<TResult> = {
        index,
        byteLength: initialBytes,
        abortController,
        cleanup: () => {
          for (const cleanup of cleanupCallbacks.splice(0)) cleanup();
        },
      };
      const prepare = async (): Promise<void> => {
        if (maxInFlightBytes === null || ownsEncoding) return;
        await previousEncoding;
        checkAborted();
        checkError();
        ownsEncoding = true;
      };
      const reserveBytes = async (byteLength: number): Promise<void> => {
        try {
          validateByteLength(byteLength);
          if (bytesReserved) {
            if (byteLength !== call.byteLength) {
              throw new SessionError("stream call byte reservation changed");
            }
            return;
          }
          await prepare();
          if (maxInFlightBytes !== null) pendingEncodedBytes = byteLength;
          while (!hasByteCapacity(byteLength)) {
            const drained = await withDrainLock(() => takeSettledHead({}));
            if (drained) readyResponses.push(drained);
            // User callbacks must not run while this encoded candidate owns
            // the preparation slot: a callback can itself await send().
            checkAborted();
            checkError();
          }
          checkAborted();
          checkError();
          call.byteLength = byteLength;
          inFlightBytes += byteLength;
          bytesReserved = true;
          resolveAdmission();
        } finally {
          releaseEncoding();
        }
      };
      const abandonUnadmitted = (): void => {
        if (bytesReserved || maxInFlightBytes === null) return;
        const slot = inFlightCalls.indexOf(call);
        if (slot >= 0) inFlightCalls.splice(slot, 1);
        call.cleanup();
      };
      inFlightCalls.push(call);
      inFlightBytes += initialBytes;
      if (bytesReserved || maxInFlightBytes === null) resolveAdmission();
      try {
        Promise.resolve(callFn(params, {
          index,
          signal: abortController.signal,
          prepare,
          reserveBytes,
        })).then(
          (value) => {
            releaseEncoding();
            if (!bytesReserved && maxInFlightBytes !== null) {
              const error = new SessionError(
                "byte-bounded call must reserve encoded bytes before sending",
              );
              call.settled = { ok: false, error };
              abandonUnadmitted();
              rejectAdmission(error);
            } else {
              call.settled = { ok: true, value };
              resolveAdmission();
            }
            notifyStateChange();
          },
          (error) => {
            releaseEncoding();
            call.settled = { ok: false, error };
            abandonUnadmitted();
            rejectAdmission(error);
            notifyStateChange();
          },
        );
      } catch (error) {
        releaseEncoding();
        const slot = inFlightCalls.indexOf(call);
        if (slot >= 0) inFlightCalls.splice(slot, 1);
        inFlightBytes -= call.byteLength;
        for (const cleanup of cleanupCallbacks.splice(0)) cleanup();
        rememberError(error);
        rejectAdmission(error);
        notifyStateChange();
        throw error;
      }
      notifyStateChange();
      if (maxInFlightBytes !== null) {
        await admission;
        await deliverReadyResponses();
      }
    },

    async waitForCapacity(
      options?: StreamSenderWaitOptions,
    ): Promise<void> {
      await waitForCapacity(options);
    },

    async flush(): Promise<void> {
      let firstUnhandledError: unknown = undefined;
      while (inFlightCalls.length > 0 || readyResponses.length > 0) {
        try {
          if (readyResponses.length > 0) await deliverReadyResponses();
          else await drainOne({ allowClosed: true });
        } catch (error) {
          if (firstUnhandledError === undefined) {
            firstUnhandledError = error;
          }
        }
      }
      if (firstUnhandledError !== undefined) {
        throw firstUnhandledError;
      }
      checkError();
    },

    async cancel(reason?: unknown): Promise<void> {
      if (!canceled) {
        canceled = true;
        cancelReason = reason ?? new SessionError("stream canceled");
        streamAbortController.abort(cancelReason);
        notifyStateChange();
      }
      for (const call of inFlightCalls) {
        call.abortController.abort(cancelReason);
      }
      await this.flush().catch((error) => {
        if (onError) return;
        throw error;
      });
    },

    get state(): StreamSenderState {
      return currentState();
    },

    get maxInFlight(): number {
      return maxInFlight;
    },

    get inFlight(): number {
      return inFlightCalls.length;
    },

    get maxInFlightBytes(): number | null {
      return maxInFlightBytes;
    },

    get inFlightBytes(): number {
      return inFlightBytes;
    },

    get pendingEncodedBytes(): number {
      return pendingEncodedBytes;
    },

    get totalSent(): number {
      return nextIndex;
    },

    get totalReceived(): number {
      return totalReceived;
    },
  };
}
