export interface CapnpErrorOptions {
  cause?: unknown;
}

export type CapnpErrorKind =
  | "abi"
  | "transport"
  | "protocol"
  | "session"
  | "instantiate";

export class CapnpError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string, options: CapnpErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "CapnpError";
    this.kind = kind;
  }
}

export class AbiError extends CapnpError {
  constructor(message: string, options: CapnpErrorOptions = {}) {
    super("abi", message, options);
    this.name = "AbiError";
  }
}

export class TransportError extends CapnpError {
  constructor(message: string, options: CapnpErrorOptions = {}) {
    super("transport", message, options);
    this.name = "TransportError";
  }
}

export class ProtocolError extends CapnpError {
  constructor(message: string, options: CapnpErrorOptions = {}) {
    super("protocol", message, options);
    this.name = "ProtocolError";
  }
}

export class SessionError extends CapnpError {
  constructor(message: string, options: CapnpErrorOptions = {}) {
    super("session", message, options);
    this.name = "SessionError";
  }
}

export class InstantiationError extends CapnpError {
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

export function normalizeCapnpError(
  error: unknown,
  fallbackKind: CapnpErrorKind,
  context?: string,
): CapnpError {
  if (error instanceof CapnpError) return error;
  const message = composeErrorMessage(context, formatUnknownError(error));
  return createCapnpError(fallbackKind, message, { cause: error });
}

export function normalizeAbiError(
  error: unknown,
  context?: string,
): CapnpError {
  return normalizeCapnpError(error, "abi", context);
}

export function normalizeTransportError(
  error: unknown,
  context?: string,
): CapnpError {
  return normalizeCapnpError(error, "transport", context);
}

export function normalizeProtocolError(
  error: unknown,
  context?: string,
): CapnpError {
  return normalizeCapnpError(error, "protocol", context);
}

export function normalizeSessionError(
  error: unknown,
  context?: string,
): CapnpError {
  return normalizeCapnpError(error, "session", context);
}

export function normalizeInstantiationError(
  error: unknown,
  context?: string,
): CapnpError {
  return normalizeCapnpError(error, "instantiate", context);
}
