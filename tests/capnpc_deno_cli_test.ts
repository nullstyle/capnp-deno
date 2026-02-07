import {
  applyImplicitPluginDefaults,
  finalizeGeneratedFiles,
  mergeCliOptionsWithConfig,
  parseCliArgs,
  parseCliConfigToml,
  renderBarrelModule,
} from "../tools/capnpc-deno/cli.ts";
import { CliConfigError, CliUsageError } from "../tools/capnpc-deno/errors.ts";
import type { GeneratedFile } from "../tools/capnpc-deno/emitter.ts";
import { assert, assertEquals, assertThrows } from "./test_utils.ts";

Deno.test("capnpc-deno CLI parses generate mode options", () => {
  const options = parseCliArgs([
    "generate",
    "--src",
    "schemas",
    "-I",
    "vendor",
    "--layout",
    "flat",
    "--no-barrel",
    "--out",
    "dist",
    "schemas/person.capnp",
  ]);

  assertEquals(options.showHelp, false);
  assertEquals(options.outDir, "dist");
  assertEquals(options.schemas.join(","), "schemas/person.capnp");
  assertEquals(options.srcDirs.join(","), "schemas");
  assertEquals(options.importPaths.join(","), "vendor");
  assertEquals(options.layout, "flat");
  assertEquals(options.emitBarrel, false);
  assertEquals(options.pluginResponse, false);
});

Deno.test("capnpc-deno CLI preserves plugin out-dir compatibility", () => {
  const options = parseCliArgs(["generated"]);
  assertEquals(options.outDir, "generated");
  assertEquals(options.schemas.length, 0);

  assertThrows(
    () => parseCliArgs(["generated", "schema/foo.capnp"]),
    /unexpected positional argument in plugin mode/,
  );
});

Deno.test("capnpc-deno CLI keeps legacy --schema mode without subcommand", () => {
  const options = parseCliArgs([
    "--schema",
    "tests/fixtures/schemas/person_codegen.capnp",
  ]);
  assertEquals(
    options.schemas.join(","),
    "tests/fixtures/schemas/person_codegen.capnp",
  );
  assertEquals(options.outDir, "generated");
});

Deno.test("capnpc-deno CLI maps schema layout and emits barrel", () => {
  const generated: GeneratedFile[] = [
    {
      path: "person_codegen_capnp.ts",
      sourceFilename: "schemas/person.capnp",
      contents: "// person",
    },
    {
      path: "person_codegen_rpc.ts",
      sourceFilename: "schemas/person.capnp",
      contents: "// person rpc",
    },
    {
      path: "person_codegen_meta.ts",
      sourceFilename: "schemas/person.capnp",
      contents: "// person meta",
    },
    {
      path: "addressbook_capnp.ts",
      sourceFilename: "schemas/nested/addressbook.capnp",
      contents: "// addressbook",
    },
  ];

  const output = finalizeGeneratedFiles(generated, {
    layout: "schema",
    srcDirs: ["schemas"],
    emitBarrel: true,
  });

  assertEquals(output.length, 5);
  assertEquals(output[0].path, "nested/addressbook_capnp.ts");
  assertEquals(output[1].path, "person_capnp.ts");
  assertEquals(output[2].path, "person_meta.ts");
  assertEquals(output[3].path, "person_rpc.ts");
  assertEquals(output[4].path, "mod.ts");
  assert(
    output[4].contents.includes('export * from "./person_capnp.ts";'),
    "expected barrel export for person schema",
  );
  assert(
    output[4].contents.includes(
      'export * from "./person_rpc.ts";',
    ),
    "expected barrel export for person rpc module",
  );
  assert(
    output[4].contents.includes(
      'export * from "./person_meta.ts";',
    ),
    "expected barrel export for person meta module",
  );
  assert(
    output[4].contents.includes(
      'export * from "./nested/addressbook_capnp.ts";',
    ),
    "expected barrel export for nested schema",
  );
});

Deno.test("capnpc-deno CLI reports output collisions in flat layout", () => {
  const generated: GeneratedFile[] = [
    {
      path: "same_capnp.ts",
      sourceFilename: "one/same.capnp",
      contents: "// one",
    },
    {
      path: "same_capnp.ts",
      sourceFilename: "two/same.capnp",
      contents: "// two",
    },
  ];

  assertThrows(
    () =>
      finalizeGeneratedFiles(generated, {
        layout: "flat",
        srcDirs: [],
        emitBarrel: false,
      }),
    /output path collision/,
  );
});

Deno.test("capnpc-deno CLI rejects parent traversal in schema source paths", () => {
  const generated: GeneratedFile[] = [
    {
      path: "safe_capnp.ts",
      sourceFilename: "../escape.capnp",
      contents: "// x",
    },
  ];
  assertThrows(
    () =>
      finalizeGeneratedFiles(generated, {
        layout: "schema",
        srcDirs: [],
        emitBarrel: false,
      }),
    /must not contain '\.\.'/,
  );
});

Deno.test("capnpc-deno CLI rejects parent traversal in output paths", () => {
  const generated: GeneratedFile[] = [
    {
      path: "../escape_capnp.ts",
      sourceFilename: "schema/ok.capnp",
      contents: "// x",
    },
  ];
  assertThrows(
    () =>
      finalizeGeneratedFiles(generated, {
        layout: "flat",
        srcDirs: [],
        emitBarrel: false,
      }),
    /must not contain '\.\.'/,
  );
});

Deno.test("capnpc-deno CLI renders empty barrel module", () => {
  const source = renderBarrelModule([]);
  assert(source.includes("export {};"), "expected empty barrel export");
});

Deno.test("capnpc-deno CLI parses supported TOML config keys", () => {
  const config = parseCliConfigToml(`
src = ["schema", "idl"]
out_dir = "generated/ts"
import_paths = ["schema", "vendor/capnp"]
layout = "flat"
emit_barrel = false
plugin_response = true
`);

  assertEquals(config.srcDirs?.join(","), "schema,idl");
  assertEquals(config.outDir, "generated/ts");
  assertEquals(config.importPaths?.join(","), "schema,vendor/capnp");
  assertEquals(config.layout, "flat");
  assertEquals(config.emitBarrel, false);
  assertEquals(config.pluginResponse, true);
});

Deno.test("capnpc-deno CLI rejects unsupported TOML config keys", () => {
  assertThrows(
    () => parseCliConfigToml('runtime_import = "@capnp/deno"'),
    /unsupported config key/,
  );
});

Deno.test("capnpc-deno CLI throws typed usage error for unknown argument", () => {
  let thrown: unknown;
  try {
    parseCliArgs(["--wat"]);
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof CliUsageError,
    `expected CliUsageError, got: ${String(thrown)}`,
  );
});

Deno.test("capnpc-deno CLI throws typed config error for invalid config key", () => {
  let thrown: unknown;
  try {
    parseCliConfigToml("1bad = true");
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof CliConfigError,
    `expected CliConfigError, got: ${String(thrown)}`,
  );
});

Deno.test("capnpc-deno CLI merges config with CLI precedence", () => {
  const cli = parseCliArgs([
    "generate",
    "--layout",
    "flat",
    "--schema",
    "local.capnp",
  ]);
  const merged = mergeCliOptionsWithConfig(cli, {
    outDir: "generated/from-config",
    srcDirs: ["schema"],
    importPaths: ["vendor/capnp"],
    layout: "schema",
    emitBarrel: false,
  });

  assertEquals(merged.outDir, "generated/from-config");
  assertEquals(merged.srcDirs.join(","), "schema");
  assertEquals(merged.importPaths.join(","), "vendor/capnp");
  assertEquals(merged.layout, "flat");
  assertEquals(merged.emitBarrel, false);
  assertEquals(merged.pluginResponse, false);
  assertEquals(merged.schemas.join(","), "local.capnp");
});

Deno.test("capnpc-deno CLI can explicitly override config barrel setting", () => {
  const cli = parseCliArgs(["generate", "--barrel"]);
  const merged = mergeCliOptionsWithConfig(cli, { emitBarrel: false });
  assertEquals(merged.emitBarrel, true);
});

Deno.test("capnpc-deno CLI parses plugin response flag", () => {
  const options = parseCliArgs(["generate", "--plugin-response"]);
  assertEquals(options.pluginResponse, true);
});

Deno.test("capnpc-deno CLI can explicitly override config plugin response setting", () => {
  const cli = parseCliArgs(["generate", "--plugin-response"]);
  const merged = mergeCliOptionsWithConfig(cli, { pluginResponse: false });
  assertEquals(merged.pluginResponse, true);
});

Deno.test("capnpc-deno CLI applies implicit plugin defaults for stdin/no-args mode", () => {
  const parsed = parseCliArgs([]);
  const adjusted = applyImplicitPluginDefaults(parsed, {
    argvLength: 0,
    stdinIsTerminal: false,
  });
  assertEquals(adjusted.outDir, ".");
  assertEquals(adjusted.useConfig, false);
  assertEquals(adjusted.quiet, true);
});

Deno.test("capnpc-deno CLI keeps normal defaults outside implicit plugin mode", () => {
  const parsed = parseCliArgs([]);
  const adjusted = applyImplicitPluginDefaults(parsed, {
    argvLength: 0,
    stdinIsTerminal: true,
  });
  assertEquals(adjusted.outDir, "generated");
  assertEquals(adjusted.useConfig, true);
  assertEquals(adjusted.quiet, false);
});
