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
   * Wait until at least one in-flight slot is available.
   *
   * This exposes the same backpressure boundary used by {@link send} without
   * starting another RPC call, which is useful when producing stream items is
   * expensive and should pause before allocating more work.
   *
   * @param options - Optional abort signal for the wait itself.
   * @returns Resolves when `inFlight < maxInFlight`.
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

  /** Total number of calls sent so far (including completed ones). */
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

  const signal = options.signal;
  const onResponse = options.onResponse;
  const onError = options.onError;
  const streamAbortController = new AbortController();

  const inFlightCalls: InFlightCall<TResult>[] = [];
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

  async function drainOneUnlocked(
    options: StreamDrainOptions = {},
  ): Promise<void> {
    const oldest = inFlightCalls[0];
    if (!oldest) return;

    while (!oldest.settled) {
      if (!options.allowClosed) {
        checkAborted();
        checkError();
      }
      await waitForStateChange(options);
    }

    const settled = oldest.settled;
    try {
      totalReceived++;
      if (settled.ok) {
        try {
          if (onResponse) {
            await onResponse(settled.value, oldest.index);
          }
        } catch (error) {
          rememberError(error);
          throw error;
        }
      } else {
        if (onError) {
          try {
            onError(settled.error, oldest.index);
          } catch (error) {
            rememberError(error);
            throw error;
          }
        } else {
          rememberError(settled.error);
          throw settled.error;
        }
      }
    } finally {
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
    }
  }

  async function drainOne(options?: StreamDrainOptions): Promise<void> {
    await withDrainLock(() => drainOneUnlocked(options));
  }

  async function waitForCapacity(
    options: StreamSenderWaitOptions = {},
  ): Promise<void> {
    checkAborted();
    checkError();
    while (inFlightCalls.length >= maxInFlight) {
      await drainOne(options);
      checkAborted();
      checkError();
    }
  }

  return {
    async send(params: TParams): Promise<void> {
      await waitForCapacity();

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

      const call: InFlightCall<TResult> = {
        index,
        abortController,
        cleanup: () => {
          for (const cleanup of cleanupCallbacks.splice(0)) cleanup();
        },
      };
      try {
        Promise.resolve(callFn(params, {
          index,
          signal: abortController.signal,
        })).then(
          (value) => {
            call.settled = { ok: true, value };
            notifyStateChange();
          },
          (error) => {
            call.settled = { ok: false, error };
            notifyStateChange();
          },
        );
      } catch (error) {
        for (const cleanup of cleanupCallbacks.splice(0)) cleanup();
        rememberError(error);
        throw error;
      }
      inFlightCalls.push(call);
      notifyStateChange();
    },

    async waitForCapacity(
      options?: StreamSenderWaitOptions,
    ): Promise<void> {
      await waitForCapacity(options);
    },

    async flush(): Promise<void> {
      let firstUnhandledError: unknown = undefined;
      while (inFlightCalls.length > 0) {
        try {
          await drainOne({ allowClosed: true });
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

    get totalSent(): number {
      return nextIndex;
    },

    get totalReceived(): number {
      return totalReceived;
    },
  };
}
