/**
 * Shared configuration validation helpers.
 *
 * These utilities provide consistent, descriptive error messages when
 * numeric configuration values are out of range. They are used by
 * reconnect, connection pool, circuit breaker, and other modules.
 *
 * **Design decision — plain `Error` vs. `CapnpError`:**
 *
 * All validators intentionally throw a plain {@link Error} rather than a
 * {@link CapnpError} subclass. This reflects the distinction between two
 * categories of errors in the library:
 *
 * - **Argument validation errors** (this module): These indicate programmer
 *   mistakes — invalid configuration values passed at construction time.
 *   They are analogous to `TypeError` or `RangeError` in the standard
 *   library: deterministic, immediately thrown, and fixable by correcting
 *   the calling code. They should **not** be caught by a blanket
 *   `catch (e) { if (e instanceof CapnpError) ... }` handler, because
 *   they represent bugs, not recoverable runtime conditions.
 *
 * - **Runtime / wire-format errors** (`CapnpError` hierarchy): These
 *   indicate problems discovered at runtime — malformed frames
 *   ({@link ProtocolError}), network failures ({@link TransportError}),
 *   session lifecycle issues ({@link SessionError}), etc. Callers are
 *   expected to catch and handle these.
 *
 * Keeping argument validation as plain `Error` ensures callers cannot
 * accidentally swallow configuration bugs inside a `CapnpError` catch
 * block, and keeps these helpers decoupled from any specific error
 * subclass.
 *
 * @module
 */

/**
 * Assert that `value` is a positive integer (>= 1, integer).
 *
 * @param value - The number to validate.
 * @param name - A human-readable name for the parameter (used in the error message).
 * @throws {Error} A plain `Error` (not `CapnpError`) if `value` is not a
 *   positive integer. Plain `Error` is used because this validates
 *   programmer-supplied arguments, not runtime wire data.
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
 * @throws {Error} A plain `Error` (not `CapnpError`) if `value` is not a
 *   non-negative integer. Plain `Error` is used because this validates
 *   programmer-supplied arguments, not runtime wire data.
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
 * @throws {Error} A plain `Error` (not `CapnpError`) if `value` is negative
 *   or non-finite. Plain `Error` is used because this validates
 *   programmer-supplied arguments, not runtime wire data.
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
 * @throws {Error} A plain `Error` (not `CapnpError`) if `value` is not a
 *   positive finite number. Plain `Error` is used because this validates
 *   programmer-supplied arguments, not runtime wire data.
 */
export function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive finite number, got ${value}`,
    );
  }
}
