export interface CapnpErrorOptions {
  cause?: unknown;
}

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
