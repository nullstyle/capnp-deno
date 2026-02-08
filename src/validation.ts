/**
 * Shared configuration validation helpers.
 *
 * These utilities provide consistent, descriptive error messages when
 * numeric configuration values are out of range. They are used by
 * reconnect, connection pool, circuit breaker, and other modules.
 *
 * All validators throw a plain {@link Error} so they are not tied to any
 * specific error subclass (TransportError, SessionError, etc.).
 *
 * @module
 */

/**
 * Assert that `value` is a positive integer (>= 1, integer).
 *
 * @param value - The number to validate.
 * @param name - A human-readable name for the parameter (used in the error message).
 * @throws {Error} If `value` is not a positive integer.
 */
export function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
}

/**
 * Assert that `value` is a non-negative integer (>= 0, integer).
 *
 * @param value - The number to validate.
 * @param name - A human-readable name for the parameter (used in the error message).
 * @throws {Error} If `value` is not a non-negative integer.
 */
export function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `${name} must be a non-negative integer, got ${value}`,
    );
  }
}

/**
 * Assert that `value` is a non-negative finite number (>= 0, finite).
 *
 * @param value - The number to validate.
 * @param name - A human-readable name for the parameter (used in the error message).
 * @throws {Error} If `value` is negative or non-finite.
 */
export function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `${name} must be a non-negative finite number, got ${value}`,
    );
  }
}

/**
 * Assert that `value` is a positive finite number (> 0, finite).
 *
 * @param value - The number to validate.
 * @param name - A human-readable name for the parameter (used in the error message).
 * @throws {Error} If `value` is not a positive finite number.
 */
export function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive finite number, got ${value}`,
    );
  }
}
