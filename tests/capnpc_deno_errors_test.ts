import {
  CapnpcDenoError,
  CliConfigError,
  CliUsageError,
  CodegenEmitError,
  CodegenIoError,
  CodegenRequestError,
  formatCapnpcDenoError,
  SchemaCompileError,
} from "../tools/capnpc-deno/errors.ts";
import { assert, assertEquals } from "./test_utils.ts";

Deno.test("capnpc-deno error subclasses set expected names and kinds", () => {
  const usage = new CliUsageError("usage");
  assertEquals(usage.name, "CliUsageError");
  assertEquals(usage.kind, "cli_usage");

  const config = new CliConfigError("config");
  assertEquals(config.name, "CliConfigError");
  assertEquals(config.kind, "cli_config");

  const io = new CodegenIoError("io");
  assertEquals(io.name, "CodegenIoError");
  assertEquals(io.kind, "io");

  const compile = new SchemaCompileError("compile");
  assertEquals(compile.name, "SchemaCompileError");
  assertEquals(compile.kind, "compile");

  const request = new CodegenRequestError("request");
  assertEquals(request.name, "CodegenRequestError");
  assertEquals(request.kind, "request");

  const emit = new CodegenEmitError("emit");
  assertEquals(emit.name, "CodegenEmitError");
  assertEquals(emit.kind, "emit");
});

Deno.test("capnpc-deno errors preserve cause option", () => {
  const cause = new Error("source");
  const error = new CodegenEmitError("emit failed", { cause });
  assertEquals(error.cause, cause);
});

Deno.test("formatCapnpcDenoError formats typed and untyped errors", () => {
  const typed = new CliUsageError("bad args");
  assertEquals(formatCapnpcDenoError(typed), "[cli_usage] bad args");

  const standard = new Error("boom");
  assertEquals(formatCapnpcDenoError(standard), "boom");

  assertEquals(formatCapnpcDenoError("raw"), "raw");
  assertEquals(formatCapnpcDenoError(123), "123");
});

Deno.test("CapnpcDenoError base class can be constructed directly", () => {
  const error = new CapnpcDenoError("emit", "base");
  assert(error instanceof Error, "expected Error inheritance");
  assertEquals(error.name, "CapnpcDenoError");
  assertEquals(error.kind, "emit");
  assertEquals(error.message, "base");
});
