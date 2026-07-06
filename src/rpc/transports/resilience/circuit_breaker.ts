/**
 * Circuit breaker for RPC connections.
 *
 * Implements the three-state circuit breaker pattern (closed, open,
 * half-open) to protect against cascading failures in transport
 * connections.
 *
 * @module
 */

import { TransportError } from "../../../errors.ts";
import {
  assertPositiveFinite,
  assertPositiveInteger,
} from "../../../validation.ts";

/**
 * The three states a circuit breaker can be in.
 *
 * - `CLOSED` -- Normal operation. Requests flow through to the underlying
 *   connection factory. Failures are counted.
 * - `OPEN` -- The circuit has tripped after too many consecutive failures.
 *   Requests are rejected immediately without attempting the underlying
 *   factory. After a cooldown period the breaker transitions to `HALF_OPEN`.
 * - `HALF_OPEN` -- A single probe request is allowed through. If it succeeds
 *   the circuit closes; if it fails the circuit reopens. Concurrent requests
 *   during the probe are rejected until the probe settles.
 */
export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

/**
 * Configuration options for {@link CircuitBreaker}.
 */
export interface CircuitBreakerOptions {
  /**
   * Number of consecutive failures required to trip the circuit breaker
   * from `CLOSED` to `OPEN`. Must be a positive integer.
   *
   * @default 5
   */
  maxConsecutiveFailures?: number;

  /**
   * Duration in milliseconds that the circuit remains `OPEN` before
   * transitioning to `HALF_OPEN` to allow a probe attempt. Must be a
   * positive finite number.
   *
   * @default 30000
   */
  cooldownMs?: number;

  /**
   * Optional callback invoked whenever the circuit breaker changes state.
   * Useful for logging or metrics.
   */
  onStateChange?: (
    from: CircuitBreakerState,
    to: CircuitBreakerState,
  ) => void;

  /**
   * Optional callback invoked when `onStateChange` throws. Errors from this
   * callback are swallowed so observer failures cannot affect breaker behavior.
   */
  onStateChangeError?: (
    error: unknown,
    from: CircuitBreakerState,
    to: CircuitBreakerState,
  ) => void;

  /**
   * Custom function returning the current time in milliseconds.
   * Defaults to `Date.now`. Useful for testing to control time progression.
   */
  now?: () => number;
}

/**
 * Snapshot of a circuit breaker's operational state.
 */
export interface CircuitBreakerStats {
  /** Current circuit breaker state. */
  readonly state: CircuitBreakerState;
  /** Current consecutive failure count. */
  readonly consecutiveFailures: number;
  /** Configured failure threshold before opening the circuit. */
  readonly maxConsecutiveFailures: number;
  /** Configured open-state cooldown in milliseconds. */
  readonly cooldownMs: number;
  /** Remaining open-state cooldown in milliseconds, or zero outside OPEN. */
  readonly cooldownRemainingMs: number;
  /** Timestamp when the current/last open window started, or null when closed. */
  readonly openedAtMs: number | null;
  /** Whether the single half-open probe slot is currently in use. */
  readonly halfOpenProbeInFlight: boolean;
}

/**
 * A circuit breaker that wraps an async connection factory to prevent
 * hammering an unavailable server with reconnection attempts.
 *
 * The breaker tracks consecutive failures. After
 * {@link CircuitBreakerOptions.maxConsecutiveFailures | maxConsecutiveFailures}
 * consecutive failures the circuit opens and all subsequent attempts are
 * rejected immediately with a {@link TransportError} for the duration of the
 * {@link CircuitBreakerOptions.cooldownMs | cooldownMs} cooldown period.
 *
 * After the cooldown elapses the circuit transitions to a half-open state
 * where a single probe attempt is allowed through. If the probe succeeds
 * the circuit closes and normal operation resumes. If the probe fails the
 * circuit reopens for another cooldown period.
 *
 * A successful connection at any point resets the failure counter and closes
 * the circuit.
 *
 * @typeParam T - The type returned by the connection factory.
 *
 * @example
 * ```ts
 * const breaker = new CircuitBreaker<MyConn>({
 *   maxConsecutiveFailures: 3,
 *   cooldownMs: 10_000,
 * });
 *
 * const conn = await breaker.call(() => connectToServer());
 * ```
 */
export class CircuitBreaker<T> {
  readonly #maxConsecutiveFailures: number;
  readonly #cooldownMs: number;
  readonly #onStateChange:
    | ((from: CircuitBreakerState, to: CircuitBreakerState) => void)
    | undefined;
  readonly #onStateChangeError:
    | ((
      error: unknown,
      from: CircuitBreakerState,
      to: CircuitBreakerState,
    ) => void)
    | undefined;
  readonly #now: () => number;

  #state: CircuitBreakerState = "CLOSED";
  #consecutiveFailures = 0;
  #openedAtMs: number | null = null;
  #halfOpenProbeInFlight = false;

  constructor(options: CircuitBreakerOptions = {}) {
    const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5;
    const cooldownMs = options.cooldownMs ?? 30_000;

    assertPositiveInteger(maxConsecutiveFailures, "maxConsecutiveFailures");
    assertPositiveFinite(cooldownMs, "cooldownMs");

    this.#maxConsecutiveFailures = maxConsecutiveFailures;
    this.#cooldownMs = cooldownMs;
    this.#onStateChange = options.onStateChange;
    this.#onStateChangeError = options.onStateChangeError;
    this.#now = options.now ?? Date.now;
  }

  /** The current state of the circuit breaker. */
  get state(): CircuitBreakerState {
    return this.#state;
  }

  /** The number of consecutive failures recorded so far. */
  get consecutiveFailures(): number {
    return this.#consecutiveFailures;
  }

  /** Snapshot of breaker state for logs, health checks, and metrics. */
  get stats(): CircuitBreakerStats {
    const openedAtMs = this.#openedAtMs;
    const cooldownRemainingMs = this.#state === "OPEN" && openedAtMs !== null
      ? Math.max(0, this.#cooldownMs - (this.#now() - openedAtMs))
      : 0;
    return {
      state: this.#state,
      consecutiveFailures: this.#consecutiveFailures,
      maxConsecutiveFailures: this.#maxConsecutiveFailures,
      cooldownMs: this.#cooldownMs,
      cooldownRemainingMs,
      openedAtMs,
      halfOpenProbeInFlight: this.#halfOpenProbeInFlight,
    };
  }

  /**
   * Execute the given connection factory through the circuit breaker.
   *
   * - In `CLOSED` state the factory is called directly. If it fails the
   *   failure counter increments; if the counter reaches the threshold the
   *   circuit opens.
   * - In `OPEN` state the call is rejected immediately with a
   *   {@link TransportError} unless the cooldown has elapsed, in which case
   *   the circuit transitions to `HALF_OPEN`.
   * - In `HALF_OPEN` state the factory is called as a probe. Success closes
   *   the circuit; failure reopens it.
   *
   * @param factory - An async function that attempts to establish a connection.
   * @returns The result of a successful `factory()` call.
   * @throws {TransportError} If the circuit is open and the cooldown has not elapsed.
   * @throws Rethrows the factory error after recording the failure.
   */
  async call(factory: () => Promise<T>): Promise<T> {
    if (this.#state === "OPEN") {
      const openedAtMs = this.#openedAtMs ?? this.#now();
      const elapsed = this.#now() - openedAtMs;
      if (elapsed < this.#cooldownMs) {
        throw new TransportError(
          `circuit breaker is open; ${
            this.#cooldownMs - elapsed
          }ms remaining in cooldown`,
        );
      }
      this.#transitionTo("HALF_OPEN");
    }

    let halfOpenProbe = false;
    if (this.#state === "HALF_OPEN") {
      if (this.#halfOpenProbeInFlight) {
        throw new TransportError(
          "circuit breaker half-open probe already in progress",
        );
      }
      this.#halfOpenProbeInFlight = true;
      halfOpenProbe = true;
    }

    try {
      const result = await factory();
      this.#onSuccess();
      return result;
    } catch (error) {
      this.#onFailure();
      throw error;
    } finally {
      if (halfOpenProbe) {
        this.#halfOpenProbeInFlight = false;
      }
    }
  }

  /**
   * Manually reset the circuit breaker to the `CLOSED` state with zero
   * consecutive failures. Useful when external conditions change (e.g. a
   * health-check endpoint comes back online).
   */
  reset(): void {
    this.#halfOpenProbeInFlight = false;
    this.#consecutiveFailures = 0;
    this.#openedAtMs = null;
    if (this.#state !== "CLOSED") {
      this.#transitionTo("CLOSED");
    }
  }

  #onSuccess(): void {
    this.#consecutiveFailures = 0;
    this.#openedAtMs = null;
    if (this.#state !== "CLOSED") {
      this.#transitionTo("CLOSED");
    }
  }

  #onFailure(): void {
    this.#consecutiveFailures += 1;
    if (this.#state === "HALF_OPEN") {
      this.#openedAtMs = this.#now();
      this.#transitionTo("OPEN");
    } else if (
      this.#state === "CLOSED" &&
      this.#consecutiveFailures >= this.#maxConsecutiveFailures
    ) {
      this.#openedAtMs = this.#now();
      this.#transitionTo("OPEN");
    }
  }

  #transitionTo(newState: CircuitBreakerState): void {
    const from = this.#state;
    if (from === newState) return;
    this.#state = newState;
    if (this.#onStateChange) {
      try {
        this.#onStateChange(from, newState);
      } catch (error) {
        try {
          this.#onStateChangeError?.(error, from, newState);
        } catch {
          // Observer failures must not alter circuit-breaker behavior.
        }
      }
    }
  }
}
