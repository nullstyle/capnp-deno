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

/**
 * Tracks an in-flight streaming call.
 */
interface InFlightCall<TResult> {
  index: number;
  promise: Promise<TResult>;
  abortController: AbortController;
  cleanup: () => void;
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
   */
  send(params: TParams): Promise<void>;

  /**
   * Wait for all in-flight calls to complete. Must be called after
   * the last {@link send} to ensure all responses are received.
   */
  flush(): Promise<void>;

  /**
   * Abort all in-flight calls and prevent new calls from being sent.
   */
  cancel(reason?: unknown): Promise<void>;

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
  let nextIndex = 0;
  let totalReceived = 0;
  let firstError: unknown = undefined;
  let hasError = false;
  let canceled = false;
  let cancelReason: unknown = undefined;

  function abortReasonFromSignal(source: AbortSignal): unknown {
    return source.reason ?? new SessionError("stream aborted");
  }

  function checkAborted(): void {
    if (signal?.aborted) {
      throw new SessionError("stream aborted");
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

  async function drainOne(): Promise<void> {
    if (inFlightCalls.length === 0) return;
    const oldest = inFlightCalls.shift()!;
    try {
      const response = await oldest.promise;
      totalReceived++;
      if (onResponse) {
        await onResponse(response, oldest.index);
      }
    } catch (error) {
      totalReceived++;
      if (onError) {
        onError(error, oldest.index);
      } else {
        if (!hasError) {
          hasError = true;
          firstError = error;
        }
      }
    } finally {
      oldest.cleanup();
    }
  }

  return {
    async send(params: TParams): Promise<void> {
      checkAborted();
      checkError();

      // Wait until there's room in the window
      while (inFlightCalls.length >= maxInFlight) {
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

      let promise: Promise<TResult>;
      try {
        promise = Promise.resolve(callFn(params, {
          index,
          signal: abortController.signal,
        }));
      } catch (error) {
        for (const cleanup of cleanupCallbacks.splice(0)) cleanup();
        throw error;
      }
      inFlightCalls.push({
        index,
        promise,
        abortController,
        cleanup: () => {
          for (const cleanup of cleanupCallbacks.splice(0)) cleanup();
        },
      });
    },

    async flush(): Promise<void> {
      while (inFlightCalls.length > 0) {
        await drainOne();
      }
      checkError();
    },

    async cancel(reason?: unknown): Promise<void> {
      if (!canceled) {
        canceled = true;
        cancelReason = reason ?? new SessionError("stream canceled");
        streamAbortController.abort(cancelReason);
      }
      for (const call of inFlightCalls) {
        call.abortController.abort(cancelReason);
      }
      await this.flush().catch((error) => {
        if (onError) return;
        throw error;
      });
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
