/**
 * Circuit breaker for RPC connections.
 *
 * Implements the three-state circuit breaker pattern (closed, open,
 * half-open) to protect against cascading failures in transport
 * connections.
 *
 * @module
 */

import { TransportError } from "../../errors.ts";
import {
  assertPositiveFinite,
  assertPositiveInteger,
} from "../../validation.ts";

/**
 * The three states a circuit breaker can be in.
 *
 * - `CLOSED` -- Normal operation. Requests flow through to the underlying
 *   connection factory. Failures are counted.
 * - `OPEN` -- The circuit has tripped after too many consecutive failures.
 *   Requests are rejected immediately without attempting the underlying
 *   factory. After a cooldown period the breaker transitions to `HALF_OPEN`.
 * - `HALF_OPEN` -- A single probe request is allowed through. If it succeeds
 *   the circuit closes; if it fails the circuit reopens.
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
   * Custom function returning the current time in milliseconds.
   * Defaults to `Date.now`. Useful for testing to control time progression.
   */
  now?: () => number;
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
  readonly #now: () => number;

  #state: CircuitBreakerState = "CLOSED";
  #consecutiveFailures = 0;
  #openedAtMs = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5;
    const cooldownMs = options.cooldownMs ?? 30_000;

    assertPositiveInteger(maxConsecutiveFailures, "maxConsecutiveFailures");
    assertPositiveFinite(cooldownMs, "cooldownMs");

    this.#maxConsecutiveFailures = maxConsecutiveFailures;
    this.#cooldownMs = cooldownMs;
    this.#onStateChange = options.onStateChange;
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
      const elapsed = this.#now() - this.#openedAtMs;
      if (elapsed < this.#cooldownMs) {
        throw new TransportError(
          `circuit breaker is open; ${
            this.#cooldownMs - elapsed
          }ms remaining in cooldown`,
        );
      }
      this.#transitionTo("HALF_OPEN");
    }

    try {
      const result = await factory();
      this.#onSuccess();
      return result;
    } catch (error) {
      this.#onFailure();
      throw error;
    }
  }

  /**
   * Manually reset the circuit breaker to the `CLOSED` state with zero
   * consecutive failures. Useful when external conditions change (e.g. a
   * health-check endpoint comes back online).
   */
  reset(): void {
    this.#consecutiveFailures = 0;
    if (this.#state !== "CLOSED") {
      this.#transitionTo("CLOSED");
    }
  }

  #onSuccess(): void {
    this.#consecutiveFailures = 0;
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
    this.#state = newState;
    if (this.#onStateChange) {
      this.#onStateChange(from, newState);
    }
  }
}
