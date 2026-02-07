export type CapnpcDenoErrorKind =
  | "cli_usage"
  | "cli_config"
  | "io"
  | "compile"
  | "request"
  | "emit";

export interface CapnpcDenoErrorOptions {
  cause?: unknown;
}

export class CapnpcDenoError extends Error {
  readonly kind: CapnpcDenoErrorKind;

  constructor(
    kind: CapnpcDenoErrorKind,
    message: string,
    options: CapnpcDenoErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "CapnpcDenoError";
    this.kind = kind;
  }
}

export class CliUsageError extends CapnpcDenoError {
  constructor(message: string, options: CapnpcDenoErrorOptions = {}) {
    super("cli_usage", message, options);
    this.name = "CliUsageError";
  }
}

export class CliConfigError extends CapnpcDenoError {
  constructor(message: string, options: CapnpcDenoErrorOptions = {}) {
    super("cli_config", message, options);
    this.name = "CliConfigError";
  }
}

export class CodegenIoError extends CapnpcDenoError {
  constructor(message: string, options: CapnpcDenoErrorOptions = {}) {
    super("io", message, options);
    this.name = "CodegenIoError";
  }
}

export class SchemaCompileError extends CapnpcDenoError {
  constructor(message: string, options: CapnpcDenoErrorOptions = {}) {
    super("compile", message, options);
    this.name = "SchemaCompileError";
  }
}

export class CodegenRequestError extends CapnpcDenoError {
  constructor(message: string, options: CapnpcDenoErrorOptions = {}) {
    super("request", message, options);
    this.name = "CodegenRequestError";
  }
}

export class CodegenEmitError extends CapnpcDenoError {
  constructor(message: string, options: CapnpcDenoErrorOptions = {}) {
    super("emit", message, options);
    this.name = "CodegenEmitError";
  }
}

export function formatCapnpcDenoError(error: unknown): string {
  if (error instanceof CapnpcDenoError) {
    return `[${error.kind}] ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
