import { normalizeTransportError, TransportError } from "./errors.ts";
import {
  assertNonNegativeFinite,
  assertNonNegativeInteger,
  assertPositiveFinite,
} from "./validation.ts";

/**
 * Context passed to a {@link ReconnectPolicy} when deciding whether to retry
 * a failed connection attempt.
 */
export interface ReconnectPolicyContext {
  /** The 1-based attempt number (1 for the first retry, 2 for the second, etc.). */
  attempt: number;
  /** Milliseconds elapsed since the first connection attempt started. */
  elapsedMs: number;
  /** The error from the most recent failed connection attempt. */
  error: unknown;
}

/**
 * Extended context passed to the `onRetry` callback, adding the computed
 * delay before the next retry attempt.
 */
export interface ReconnectRetryInfo extends ReconnectPolicyContext {
  /** The delay in milliseconds before the next retry attempt. */
  delayMs: number;
}

/**
 * Strategy interface for controlling reconnection behavior.
 *
 * Implementations decide whether to retry after a failure and how long
 * to wait between attempts. Use {@link createExponentialBackoffReconnectPolicy}
 * for a ready-made implementation with exponential backoff and jitter.
 */
export interface ReconnectPolicy {
  /**
   * Determine whether a retry should be attempted.
   * @param context - Information about the current failure.
   * @returns `true` to retry, `false` to give up.
   */
  shouldRetry(context: ReconnectPolicyContext): boolean;
  /**
   * Compute the delay in milliseconds before the next retry attempt.
   * @param context - Information about the current failure.
   * @returns The delay in milliseconds (must be non-negative and finite).
   */
  nextDelayMs(context: ReconnectPolicyContext): number;
}

/**
 * Options for creating an exponential backoff reconnect policy via
 * {@link createExponentialBackoffReconnectPolicy}.
 */
export interface ExponentialBackoffReconnectPolicyOptions {
  /** Maximum number of retry attempts before giving up. Defaults to 5. */
  maxAttempts?: number;
  /** Initial delay in milliseconds before the first retry. Defaults to 100. */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds (caps the exponential growth). Defaults to 5000. */
  maxDelayMs?: number;
  /** Multiplicative factor applied per attempt. Must be >= 1. Defaults to 2. */
  factor?: number;
  /** Jitter ratio in the range [0, 1]. Adds randomness to prevent thundering herd. Defaults to 0.2. */
  jitterRatio?: number;
  /** Maximum total elapsed time in milliseconds. Retries stop once exceeded. */
  maxElapsedMs?: number;
  /** Custom random number generator returning values in [0, 1). Defaults to `Math.random`. */
  random?: () => number;
}

/**
 * Options for the {@link connectWithReconnect} utility function.
 */
export interface ConnectWithReconnectOptions {
  /** The reconnect policy that controls retry decisions and timing. */
  policy: ReconnectPolicy;
  /** An {@link AbortSignal} that can cancel the reconnect loop. */
  signal?: AbortSignal;
  /**
   * Callback invoked before each retry, after the delay has been computed
   * but before sleeping. Useful for logging.
   */
  onRetry?: (info: ReconnectRetryInfo) => void | Promise<void>;
  /**
   * Custom async sleep function. Defaults to `setTimeout`-based sleep.
   * Useful for testing to control time progression.
   */
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Custom function returning the current time in milliseconds.
   * Defaults to `Date.now`. Useful for testing.
   */
  now?: () => number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new TransportError("reconnect aborted");
  }
}

async function defaultSleep(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (delayMs <= 0) return;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new TransportError("reconnect aborted"));
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Create a {@link ReconnectPolicy} that uses exponential backoff with
 * configurable jitter.
 *
 * The delay for attempt `n` is computed as:
 * `min(initialDelayMs * factor^(n-1), maxDelayMs)` with jitter applied
 * as a random offset of +/- `jitterRatio * delay`.
 *
 * @param options - Backoff configuration. All fields have sensible defaults.
 * @returns A reconnect policy implementing exponential backoff.
 * @throws {TransportError} If any option value is out of range.
 *
 * @example
 * ```ts
 * const policy = createExponentialBackoffReconnectPolicy({
 *   maxAttempts: 10,
 *   initialDelayMs: 200,
 *   maxDelayMs: 10_000,
 * });
 * ```
 */
export function createExponentialBackoffReconnectPolicy(
  options: ExponentialBackoffReconnectPolicyOptions = {},
): ReconnectPolicy {
  const maxAttempts = options.maxAttempts ?? 5;
  const initialDelayMs = options.initialDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const factor = options.factor ?? 2;
  const jitterRatio = options.jitterRatio ?? 0.2;
  const maxElapsedMs = options.maxElapsedMs;
  const random = options.random ?? Math.random;

  assertNonNegativeInteger(maxAttempts, "maxAttempts");
  assertNonNegativeFinite(initialDelayMs, "initialDelayMs");
  assertPositiveFinite(maxDelayMs, "maxDelayMs");
  assertPositiveFinite(factor, "factor");
  if (factor < 1) {
    throw new TransportError(`factor must be >= 1, got ${factor}`);
  }
  assertNonNegativeFinite(jitterRatio, "jitterRatio");
  if (jitterRatio > 1) {
    throw new TransportError(`jitterRatio must be <= 1, got ${jitterRatio}`);
  }
  if (initialDelayMs > maxDelayMs) {
    throw new TransportError(
      `initialDelayMs ${initialDelayMs} exceeds maxDelayMs ${maxDelayMs}`,
    );
  }
  if (maxElapsedMs !== undefined) {
    assertNonNegativeInteger(maxElapsedMs, "maxElapsedMs");
  }

  return {
    shouldRetry(context): boolean {
      assertNonNegativeInteger(context.attempt, "context.attempt");
      assertNonNegativeInteger(context.elapsedMs, "context.elapsedMs");
      if (context.attempt > maxAttempts) {
        return false;
      }
      if (maxElapsedMs !== undefined && context.elapsedMs > maxElapsedMs) {
        return false;
      }
      return true;
    },

    nextDelayMs(context): number {
      assertNonNegativeInteger(context.attempt, "context.attempt");
      const exponent = Math.max(0, context.attempt - 1);
      let delay = initialDelayMs * Math.pow(factor, exponent);
      if (!Number.isFinite(delay)) {
        delay = maxDelayMs;
      }
      delay = Math.min(delay, maxDelayMs);

      if (jitterRatio === 0 || delay === 0) {
        return Math.round(delay);
      }

      const randomValue = random();
      if (
        !Number.isFinite(randomValue) ||
        randomValue < 0 ||
        randomValue >= 1
      ) {
        throw new TransportError(
          `random() must return a value in [0, 1), got ${randomValue}`,
        );
      }

      const jitter = delay * jitterRatio;
      const minDelay = delay - jitter;
      const maxDelay = delay + jitter;
      const jittered = minDelay + ((maxDelay - minDelay) * randomValue);
      return Math.max(0, Math.round(jittered));
    },
  };
}

/**
 * Attempt to establish a connection, retrying on failure according to the
 * provided {@link ReconnectPolicy}.
 *
 * @typeParam T - The type returned by the connect function.
 * @param connect - An async function that attempts to establish a connection.
 * @param options - Reconnection options including the policy, abort signal, and callbacks.
 * @returns The result of a successful `connect()` call.
 * @throws {TransportError} If all retry attempts are exhausted or the operation is aborted.
 */
export async function connectWithReconnect<T>(
  connect: () => Promise<T>,
  options: ConnectWithReconnectOptions,
): Promise<T> {
  if (!options.policy) {
    throw new TransportError(
      "connectWithReconnect requires a reconnect policy",
    );
  }

  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  let attempt = 0;

  while (true) {
    throwIfAborted(options.signal);

    try {
      return await connect();
    } catch (error) {
      const normalized = normalizeTransportError(
        error,
        "reconnect connect attempt failed",
      );
      attempt += 1;
      const elapsedMs = Math.max(0, now() - startedAtMs);
      const context: ReconnectPolicyContext = {
        attempt,
        elapsedMs,
        error: normalized,
      };

      let shouldRetry: boolean;
      try {
        shouldRetry = options.policy.shouldRetry(context);
      } catch (policyError) {
        throw normalizeTransportError(
          policyError,
          "reconnect policy shouldRetry failed",
        );
      }

      if (!shouldRetry) {
        throw normalized;
      }

      let rawDelayMs: number;
      try {
        rawDelayMs = options.policy.nextDelayMs(context);
      } catch (policyError) {
        throw normalizeTransportError(
          policyError,
          "reconnect policy nextDelayMs failed",
        );
      }
      assertNonNegativeFinite(rawDelayMs, "reconnect delay");
      const delayMs = Math.round(rawDelayMs);

      if (options.onRetry) {
        try {
          await options.onRetry({
            ...context,
            delayMs,
          });
        } catch (onRetryError) {
          throw normalizeTransportError(
            onRetryError,
            "reconnect onRetry hook failed",
          );
        }
      }

      try {
        await sleep(delayMs, options.signal);
      } catch (sleepError) {
        throw normalizeTransportError(sleepError, "reconnect sleep failed");
      }
    }
  }
}
