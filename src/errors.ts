/**
 * Options for constructing a {@link CapnpError} or any of its subclasses.
 */
export interface CapnpErrorOptions {
  /** The underlying cause of the error, preserved as the standard `Error.cause` property. */
  cause?: unknown;
}

/**
 * Discriminated union of error kinds used throughout the capnp-deno library.
 * Each kind maps to a specific {@link CapnpError} subclass.
 */
export type CapnpErrorKind =
  | "abi"
  | "transport"
  | "protocol"
  | "session"
  | "instantiate";

/**
 * Base error class for all capnp-deno errors.
 *
 * Every error thrown by this library extends `CapnpError`, making it easy to
 * catch all Cap'n Proto related errors in a single handler. The {@link kind}
 * property provides a string discriminator so callers can branch without
 * `instanceof` checks.
 *
 * @example
 * ```ts
 * try {
 *   await session.start();
 * } catch (error) {
 *   if (error instanceof CapnpError) {
 *     console.error(`capnp error [${error.kind}]: ${error.message}`);
 *   }
 * }
 * ```
 */
export class CapnpError extends Error {
  /** Discriminator string identifying the error category (e.g. "abi", "transport", "session"). */
  readonly kind: string;

  /**
   * @param kind - The error category discriminator.
   * @param message - A human-readable description of the error.
   * @param options - Optional settings, including a `cause` for error chaining.
   */
  constructor(kind: string, message: string, options: CapnpErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "CapnpError";
    this.kind = kind;
  }
}

/**
 * Error thrown when a WASM ABI operation fails.
 *
 * Indicates problems communicating with the Cap'n Proto WASM module, such as
 * missing exports, allocation failures, or unexpected return values from the
 * low-level ABI functions.
 */
export class AbiError extends CapnpError {
  /**
   * @param message - A human-readable description of the ABI error.
   * @param options - Optional settings, including a `cause` for error chaining.
   */
  constructor(message: string, options: CapnpErrorOptions = {}) {
    super("abi", message, options);
    this.name = "AbiError";
  }
}

/**
 * Error thrown when a transport-level operation fails.
 *
 * Covers network errors, connection failures, timeouts, and other I/O problems
 * in the underlying transport layer (TCP, WebSocket, MessagePort).
 */
export class TransportError extends CapnpError {
  /**
   * @param message - A human-readable description of the transport error.
   * @param options - Optional settings, including a `cause` for error chaining.
   */
  constructor(message: string, options: CapnpErrorOptions = {}) {
    super("transport", message, options);
    this.name = "TransportError";
  }
}

/**
 * Error thrown when a Cap'n Proto protocol violation is detected.
 *
 * Indicates malformed frames, invalid pointer structures, unsupported message
 * tags, or other violations of the Cap'n Proto wire format.
 */
export class ProtocolError extends CapnpError {
  /**
   * @param message - A human-readable description of the protocol error.
   * @param options - Optional settings, including a `cause` for error chaining.
   */
  constructor(message: string, options: CapnpErrorOptions = {}) {
    super("protocol", message, options);
    this.name = "ProtocolError";
  }
}

/**
 * Error thrown when an RPC session-level operation fails.
 *
 * Covers errors related to session lifecycle (starting, flushing, closing)
 * as well as RPC call failures, reconnection issues, and client transport
 * problems.
 */
export class SessionError extends CapnpError {
  /**
   * @param message - A human-readable description of the session error.
   * @param options - Optional settings, including a `cause` for error chaining.
   */
  constructor(message: string, options: CapnpErrorOptions = {}) {
    super("session", message, options);
    this.name = "SessionError";
  }
}

/**
 * Error thrown when WASM module instantiation fails.
 *
 * Indicates problems loading, compiling, or instantiating the Cap'n Proto
 * WASM module -- for example, a failed HTTP fetch, an unsupported buffer
 * source, or a WebAssembly compilation error.
 */
export class InstantiationError extends CapnpError {
  /**
   * @param message - A human-readable description of the instantiation error.
   * @param options - Optional settings, including a `cause` for error chaining.
   */
  constructor(message: string, options: CapnpErrorOptions = {}) {
    super("instantiate", message, options);
    this.name = "InstantiationError";
  }
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message.length > 0) return message;
    return error.name || "unexpected error";
  }
  if (typeof error === "string") {
    const message = error.trim();
    return message.length > 0 ? message : "unexpected error";
  }
  if (
    typeof error === "number" ||
    typeof error === "boolean" ||
    typeof error === "bigint" ||
    typeof error === "symbol"
  ) {
    return String(error);
  }
  if (error === null || error === undefined) {
    return "unexpected error";
  }
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") return serialized;
  } catch {
    // no-op
  }
  const fallback = String(error);
  return fallback === "[object Object]" ? "unexpected error" : fallback;
}

function composeErrorMessage(
  context: string | undefined,
  detail: string,
): string {
  if (!context) return detail;
  return `${context}: ${detail}`;
}

function createCapnpError(
  kind: CapnpErrorKind,
  message: string,
  options: CapnpErrorOptions,
): CapnpError {
  switch (kind) {
    case "abi":
      return new AbiError(message, options);
    case "transport":
      return new TransportError(message, options);
    case "protocol":
      return new ProtocolError(message, options);
    case "session":
      return new SessionError(message, options);
    case "instantiate":
      return new InstantiationError(message, options);
  }
}

/**
 * Normalizes an unknown thrown value into a typed {@link CapnpError}.
 *
 * If the value is already a `CapnpError`, it is returned as-is. Otherwise a new
 * error of the specified `fallbackKind` is created, wrapping the original value
 * as the `cause`.
 *
 * @param error - The unknown error value to normalize.
 * @param fallbackKind - The error kind to use when wrapping non-CapnpError values.
 * @param context - Optional prefix added to the error message for context.
 * @returns A typed `CapnpError` instance.
 */
export function normalizeCapnpError(
  error: unknown,
  fallbackKind: CapnpErrorKind,
  context?: string,
): CapnpError {
  if (error instanceof CapnpError) return error;
  const message = composeErrorMessage(context, formatUnknownError(error));
  return createCapnpError(fallbackKind, message, { cause: error });
}

/**
 * Normalizes an unknown thrown value into an {@link AbiError}.
 *
 * @param error - The unknown error value to normalize.
 * @param context - Optional prefix added to the error message for context.
 * @returns A `CapnpError` with kind "abi".
 */
export function normalizeAbiError(
  error: unknown,
  context?: string,
): CapnpError {
  return normalizeCapnpError(error, "abi", context);
}

/**
 * Normalizes an unknown thrown value into a {@link TransportError}.
 *
 * @param error - The unknown error value to normalize.
 * @param context - Optional prefix added to the error message for context.
 * @returns A `CapnpError` with kind "transport".
 */
export function normalizeTransportError(
  error: unknown,
  context?: string,
): CapnpError {
  return normalizeCapnpError(error, "transport", context);
}

/**
 * Normalizes an unknown thrown value into a {@link ProtocolError}.
 *
 * @param error - The unknown error value to normalize.
 * @param context - Optional prefix added to the error message for context.
 * @returns A `CapnpError` with kind "protocol".
 */
export function normalizeProtocolError(
  error: unknown,
  context?: string,
): CapnpError {
  return normalizeCapnpError(error, "protocol", context);
}

/**
 * Normalizes an unknown thrown value into a {@link SessionError}.
 *
 * @param error - The unknown error value to normalize.
 * @param context - Optional prefix added to the error message for context.
 * @returns A `CapnpError` with kind "session".
 */
export function normalizeSessionError(
  error: unknown,
  context?: string,
): CapnpError {
  return normalizeCapnpError(error, "session", context);
}

/**
 * Normalizes an unknown thrown value into an {@link InstantiationError}.
 *
 * @param error - The unknown error value to normalize.
 * @param context - Optional prefix added to the error message for context.
 * @returns A `CapnpError` with kind "instantiate".
 */
export function normalizeInstantiationError(
  error: unknown,
  context?: string,
): CapnpError {
  return normalizeCapnpError(error, "instantiate", context);
}
