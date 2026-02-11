import {
  applyImplicitPluginDefaults,
  computeIncludePaths,
  discoverSchemaFiles,
  finalizeGeneratedFiles,
  helpText,
  loadCliFileConfig,
  mapGeneratedFilePath,
  mergeCliOptionsWithConfig,
  parseCliArgs,
  parseCliConfigToml,
  renderBarrelModule,
} from "../tools/capnpc-deno/cli.ts";
import { CliConfigError, CliUsageError } from "../tools/capnpc-deno/errors.ts";
import type { GeneratedFile } from "../tools/capnpc-deno/emitter.ts";
import { assert, assertEquals, assertThrows } from "./test_utils.ts";

async function withPatchedReadTextFile(
  readTextFile: (path: string | URL) => Promise<string>,
  fn: () => Promise<void>,
): Promise<void> {
  const denoMutable = Deno as unknown as {
    readTextFile: typeof Deno.readTextFile;
  };
  const original = denoMutable.readTextFile;
  denoMutable.readTextFile =
    readTextFile as unknown as typeof Deno.readTextFile;
  try {
    await fn();
  } finally {
    denoMutable.readTextFile = original;
  }
}

function withPatchedJsonParse(
  patch: (original: typeof JSON.parse) => typeof JSON.parse,
  fn: () => void,
): void {
  const jsonMutable = JSON as unknown as {
    parse: typeof JSON.parse;
  };
  const original = jsonMutable.parse;
  jsonMutable.parse = patch(original);
  try {
    fn();
  } finally {
    jsonMutable.parse = original;
  }
}

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
      path: "person_codegen_types.ts",
      sourceFilename: "schemas/person.capnp",
      contents: "// person types",
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

  assertEquals(output.length, 6);
  assertEquals(output[0].path, "nested/addressbook_capnp.ts");
  assertEquals(output[1].path, "person_capnp.ts");
  assertEquals(output[2].path, "person_meta.ts");
  assertEquals(output[3].path, "person_rpc.ts");
  assertEquals(output[4].path, "person_types.ts");
  assertEquals(output[5].path, "mod.ts");
  assert(
    output[5].contents.includes('export * from "./person_capnp.ts";'),
    "expected barrel export for person schema",
  );
  assert(
    output[5].contents.includes(
      'export * from "./person_rpc.ts";',
    ),
    "expected barrel export for person rpc module",
  );
  assert(
    output[5].contents.includes(
      'export * from "./person_types.ts";',
    ),
    "expected barrel export for person types module",
  );
  assert(
    output[5].contents.includes(
      'export * from "./person_meta.ts";',
    ),
    "expected barrel export for person meta module",
  );
  assert(
    output[5].contents.includes(
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

Deno.test("capnpc-deno CLI help text includes usage and default output directory", () => {
  const text = helpText();
  assert(text.includes("capnpc-deno"), "expected help heading");
  assert(text.includes("Usage:"), "expected usage section");
  assert(
    text.includes(
      "--out <dir>            Output directory (default: generated)",
    ),
    "expected default out directory in help text",
  );
});

Deno.test("capnpc-deno CLI validates incompatible argument combinations", () => {
  assertThrows(
    () => parseCliArgs(["generate", "--no-config", "--config", "cfg.toml"]),
    /cannot be used with --config/,
  );
  assertThrows(
    () =>
      parseCliArgs([
        "generate",
        "--request-bin",
        "request.bin",
        "--schema",
        "schema/foo.capnp",
      ]),
    /--request-bin cannot be used with --schema\/--src/,
  );
  assertThrows(
    () => parseCliArgs(["generate", "--layout", "invalid"]),
    /must be "schema" or "flat"/,
  );
});

Deno.test("capnpc-deno CLI config parser rejects tables, duplicates, and malformed arrays", () => {
  assertThrows(
    () => parseCliConfigToml('[section]\nout_dir = "generated"'),
    /config tables are not supported/i,
  );
  assertThrows(
    () => parseCliConfigToml('src = "schema"\nsrc = "schema2"'),
    /duplicate config key: src/i,
  );
  assertThrows(
    () => parseCliConfigToml('src = ["schema"'),
    /unterminated array/i,
  );
  assertThrows(
    () => parseCliConfigToml('emit_barrel = "true"'),
    /must be true or false/i,
  );
});

Deno.test("capnpc-deno CLI loadCliFileConfig returns null for missing optional default config", async () => {
  const options = parseCliArgs(["generate"]);
  await withPatchedReadTextFile(() => {
    throw new Deno.errors.NotFound("missing");
  }, async () => {
    const loaded = await loadCliFileConfig(options);
    assertEquals(loaded, null);
  });
});

Deno.test("capnpc-deno CLI loadCliFileConfig throws typed error for missing explicit config", async () => {
  const options = parseCliArgs([
    "generate",
    "--config",
    "cfg/capnpc-deno.toml",
  ]);
  await withPatchedReadTextFile(() => {
    throw new Deno.errors.NotFound("missing");
  }, async () => {
    let thrown: unknown;
    try {
      await loadCliFileConfig(options);
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof CliConfigError &&
        /failed to read config file cfg\/capnpc-deno\.toml/i.test(
          thrown.message,
        ),
      `expected explicit config read error, got: ${String(thrown)}`,
    );
  });
});

Deno.test("capnpc-deno CLI loadCliFileConfig resolves config-relative paths", async () => {
  const options = parseCliArgs([
    "generate",
    "--config",
    "configs/capnpc-deno.toml",
  ]);
  await withPatchedReadTextFile(
    () =>
      Promise.resolve(`
src = ["schema", "idl/nested"]
out_dir = "generated"
import_paths = ["vendor/capnp"]
layout = "flat"
emit_barrel = false
plugin_response = true
`),
    async () => {
      const loaded = await loadCliFileConfig(options);
      assert(loaded !== null, "expected loaded config");
      assertEquals(
        loaded.srcDirs?.join(","),
        "configs/schema,configs/idl/nested",
      );
      assertEquals(loaded.outDir, "configs/generated");
      assertEquals(loaded.importPaths?.join(","), "configs/vendor/capnp");
      assertEquals(loaded.layout, "flat");
      assertEquals(loaded.emitBarrel, false);
      assertEquals(loaded.pluginResponse, true);
    },
  );
});

Deno.test("capnpc-deno CLI discovers schema files recursively and deterministically", async () => {
  const denoMutable = Deno as unknown as {
    readDir: typeof Deno.readDir;
  };
  const originalReadDir = denoMutable.readDir;

  const dirEntries = new Map<string, Deno.DirEntry[]>([
    [
      "schemas",
      [
        { name: "nested", isDirectory: true, isFile: false, isSymlink: false },
        { name: "b.capnp", isDirectory: false, isFile: true, isSymlink: false },
      ],
    ],
    [
      "schemas/nested",
      [
        { name: "deep", isDirectory: true, isFile: false, isSymlink: false },
        { name: "a.capnp", isDirectory: false, isFile: true, isSymlink: false },
      ],
    ],
    [
      "schemas/nested/deep",
      [
        {
          name: "readme.txt",
          isDirectory: false,
          isFile: true,
          isSymlink: false,
        },
      ],
    ],
  ]);

  denoMutable.readDir = ((path: string | URL) => {
    const key = String(path).replaceAll("\\", "/");
    const entries = dirEntries.get(key);
    if (!entries) throw new Deno.errors.NotFound(`missing ${key}`);
    return (async function* (): AsyncGenerator<Deno.DirEntry> {
      for (const entry of entries) {
        yield entry;
      }
    })();
  }) as typeof Deno.readDir;

  try {
    const files = await discoverSchemaFiles(["schemas"]);
    const normalized = files.map((path) => path.replaceAll("\\", "/"));
    assertEquals(
      normalized.join(","),
      "schemas/b.capnp,schemas/nested/a.capnp",
    );
  } finally {
    denoMutable.readDir = originalReadDir;
  }
});

Deno.test("capnpc-deno CLI computeIncludePaths deduplicates and normalizes path inputs", () => {
  const include = computeIncludePaths(
    ["vendor\\capnp", "vendor/capnp", "imports"],
    ["schemas", "schemas"],
    ["schemas/person.capnp", "other/team.capnp", "C:\\proto\\x.capnp"],
  );
  assertEquals(
    include.join(","),
    "vendor/capnp,imports,schemas,other,C:/proto",
  );
});

Deno.test("capnpc-deno CLI rejects barrel generation when generated files already include mod.ts", () => {
  const generated: GeneratedFile[] = [{
    path: "mod.ts",
    contents: "// existing barrel",
  }];
  assertThrows(
    () =>
      finalizeGeneratedFiles(generated, {
        layout: "flat",
        srcDirs: [],
        emitBarrel: true,
      }),
    /already include mod\.ts/i,
  );
});

Deno.test("capnpc-deno CLI validates missing values for value-taking flags", () => {
  const cases: Array<{ args: string[]; pattern: RegExp }> = [
    {
      args: ["generate", "--config"],
      pattern: /--config requires a value/,
    },
    {
      args: ["generate", "--out"],
      pattern: /--out requires a value/,
    },
    {
      args: ["generate", "--request-bin"],
      pattern: /--request-bin requires a value/,
    },
    {
      args: ["generate", "--schema"],
      pattern: /--schema requires a value/,
    },
    {
      args: ["generate", "--src"],
      pattern: /--src requires a value/,
    },
    {
      args: ["generate", "-I"],
      pattern: /-I requires a value/,
    },
    {
      args: ["generate", "--layout"],
      pattern: /--layout requires a value/,
    },
  ];

  for (const testCase of cases) {
    assertThrows(
      () => parseCliArgs(testCase.args),
      testCase.pattern,
    );
  }
});

Deno.test("capnpc-deno CLI accepts -- sentinel and keeps positional schemas", () => {
  const options = parseCliArgs(["generate", "--", "schema/foo.capnp"]);
  assertEquals(options.schemas.join(","), "schema/foo.capnp");
});

Deno.test("capnpc-deno CLI parses mixed-quote arrays and rejects malformed multiline arrays", () => {
  const parsed = parseCliConfigToml(`
src = ["schema", 'idl']
import_paths = [
  "vendor/capnp",
  'vendor/local'
]
`);
  assertEquals(parsed.srcDirs?.join(","), "schema,idl");
  assertEquals(parsed.importPaths?.join(","), "vendor/capnp,vendor/local");

  assertThrows(
    () =>
      parseCliConfigToml(`
src = [
  "schema",
  idl
]
`),
    /must contain only quoted strings/i,
  );
  assertThrows(
    () => parseCliConfigToml('src = ["schema]'),
    /unterminated array/i,
  );
});

Deno.test("capnpc-deno CLI skips file reads entirely when config is disabled", async () => {
  const options = parseCliArgs(["generate", "--no-config"]);
  await withPatchedReadTextFile(() => {
    throw new Error(
      "readTextFile should not be called when --no-config is set",
    );
  }, async () => {
    const loaded = await loadCliFileConfig(options);
    assertEquals(loaded, null);
  });
});

Deno.test("capnpc-deno CLI schema layout falls back when source filename has no relative schema path", () => {
  const out = finalizeGeneratedFiles(
    [
      {
        path: "fallback_capnp.ts",
        sourceFilename: "schema",
        contents: "// fallback",
      },
      {
        path: "manual_capnp.ts",
        contents: "// manual",
      },
    ],
    {
      layout: "schema",
      srcDirs: ["schema"],
      emitBarrel: false,
    },
  );

  assertEquals(out[0].path, "fallback_capnp.ts");
  assertEquals(out[1].path, "manual_capnp.ts");
});

Deno.test("capnpc-deno CLI parses help/quiet flags and request-bin/src conflict", () => {
  const parsed = parseCliArgs(["generate", "-h", "--quiet"]);
  assertEquals(parsed.showHelp, true);
  assertEquals(parsed.quiet, true);
  assertEquals(parseCliArgs(["generate", "--help"]).showHelp, true);

  assertThrows(
    () =>
      parseCliArgs([
        "generate",
        "--request-bin",
        "request.bin",
        "--src",
        "schema",
      ]),
    /--request-bin cannot be used with --schema\/--src/i,
  );
});

Deno.test("capnpc-deno CLI merge handles null config and adopts config defaults", () => {
  const parsed = parseCliArgs(["generate"]);
  const mergedNull = mergeCliOptionsWithConfig(parsed, null);
  assert(
    mergedNull === parsed,
    "expected merge with null config to be identity",
  );

  const merged = mergeCliOptionsWithConfig(parsed, {
    layout: "flat",
    pluginResponse: true,
  });
  assertEquals(merged.layout, "flat");
  assertEquals(merged.pluginResponse, true);
});

Deno.test("capnpc-deno CLI loadCliFileConfig wraps non-Error failures", async () => {
  const options = parseCliArgs(["generate", "--config", "cfg.toml"]);
  await withPatchedReadTextFile(() => {
    throw "boom";
  }, async () => {
    let thrown: unknown;
    try {
      await loadCliFileConfig(options);
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof CliConfigError &&
        /failed to read config file cfg\.toml/i.test(thrown.message),
      `expected CliConfigError for non-Error throw, got: ${String(thrown)}`,
    );
  });
});

Deno.test("capnpc-deno CLI loadCliFileConfig resolves cwd and absolute config roots", async () => {
  await withPatchedReadTextFile(
    (path) => {
      const normalized = String(path).replaceAll("\\", "/");
      if (normalized === "capnpc-deno.toml") {
        return Promise.resolve(`
src = "schema"
import_paths = ["vendor///"]
layout = "schema"
plugin_response = true
`);
      }
      if (normalized === "/capnpc-deno.toml") {
        return Promise.resolve(`
out_dir = "generated"
src = ["proto"]
`);
      }
      throw new Deno.errors.NotFound(normalized);
    },
    async () => {
      const cwdLoaded = await loadCliFileConfig(parseCliArgs(["generate"]));
      assert(cwdLoaded !== null, "expected default config to load");
      assertEquals(cwdLoaded.outDir, undefined);
      assertEquals(cwdLoaded.srcDirs?.join(","), "schema");
      assertEquals(cwdLoaded.importPaths?.join(","), "vendor///");
      assertEquals(cwdLoaded.layout, "schema");
      assertEquals(cwdLoaded.pluginResponse, true);

      const rootLoaded = await loadCliFileConfig(
        parseCliArgs(["generate", "--config", "/capnpc-deno.toml"]),
      );
      assert(rootLoaded !== null, "expected absolute config to load");
      assertEquals(rootLoaded.outDir, "/generated");
      assertEquals(rootLoaded.srcDirs?.join(","), "/proto");
    },
  );
});

Deno.test("capnpc-deno CLI parser handles additional scalar and array edge cases", () => {
  const singleSrc = parseCliConfigToml('src = "schema"');
  assertEquals(singleSrc.srcDirs?.join(","), "schema");

  const singleQuoted = parseCliConfigToml("out_dir = 'generated'");
  assertEquals(singleQuoted.outDir, "generated");

  const emptyArray = parseCliConfigToml("src = []");
  assertEquals(emptyArray.srcDirs?.length ?? 0, 0);
  const spacedEmptyArray = parseCliConfigToml("src = [   ]");
  assertEquals(spacedEmptyArray.srcDirs?.length ?? 0, 0);

  const withComment = parseCliConfigToml(
    String.raw`out_dir = "gen\"#x" # tail`,
  );
  assertEquals(withComment.outDir, 'gen"#x');

  const escaped = parseCliConfigToml(String.raw`src = ["sche\"ma"]`);
  assertEquals(escaped.srcDirs?.join(","), 'sche"ma');

  assertThrows(
    () => parseCliConfigToml("invalid"),
    /invalid config line/i,
  );
  assertThrows(
    () => parseCliConfigToml("out_dir ="),
    /missing a value/i,
  );
  assertThrows(
    () => parseCliConfigToml("out_dir = generated"),
    /quoted string/i,
  );
  assertThrows(
    () => parseCliConfigToml('layout = "weird"'),
    /must be "schema" or "flat"/i,
  );
  assertThrows(
    () => parseCliConfigToml('src = ["schema"] trailing'),
    /array of strings/i,
  );
  assertThrows(
    () => parseCliConfigToml(String.raw`src = ["\uZZZZ"]`),
    /invalid string value/i,
  );
  assertThrows(
    () => parseCliConfigToml('out_dir = "unterminated'),
    /quoted string/i,
  );
});

Deno.test("capnpc-deno CLI parser validates JSON parse result types", () => {
  withPatchedJsonParse(
    (original) =>
      ((text: string, reviver?: (key: string, value: unknown) => unknown) => {
        if (text === '"from-parse"') return 123 as unknown;
        return original(text, reviver);
      }) as typeof JSON.parse,
    () => {
      assertThrows(
        () => parseCliConfigToml('out_dir = "from-parse"'),
        /quoted string/i,
      );
      assertThrows(
        () => parseCliConfigToml('src = ["from-parse"]'),
        /invalid string value/i,
      );
    },
  );
});

Deno.test("capnpc-deno CLI schema mapping handles root precedence and suffix fallbacks", () => {
  const longestRoot = mapGeneratedFilePath(
    {
      path: "person_rpc.ts",
      sourceFilename: "schemas/nested/person.capnp",
      contents: "// person",
    },
    "schema",
    ["", "schemas", "schemas/nested"],
  );
  assertEquals(longestRoot, "person_rpc.ts");

  const absoluteNoExt = mapGeneratedFilePath(
    {
      path: "custom.ts",
      sourceFilename: "/abs/schema/noext",
      contents: "// custom",
    },
    "schema",
    ["schemas"],
  );
  assertEquals(absoluteNoExt, "noext_capnp.ts");

  const absoluteRootMismatch = mapGeneratedFilePath(
    {
      path: "person_rpc.ts",
      sourceFilename: "/abs/schema/person.capnp",
      contents: "// person",
    },
    "schema",
    ["/other"],
  );
  assertEquals(absoluteRootMismatch, "person_rpc.ts");

  const typesSuffix = mapGeneratedFilePath(
    {
      path: "person_types.ts",
      sourceFilename: "schemas/nested/person.capnp",
      contents: "// person types",
    },
    "schema",
    ["schemas"],
  );
  assertEquals(typesSuffix, "nested/person_types.ts");

  const emptyStem = mapGeneratedFilePath(
    {
      path: "root_meta.ts",
      sourceFilename: ".capnp",
      contents: "// root",
    },
    "schema",
    [],
  );
  assertEquals(emptyStem, "schema_meta.ts");
});

Deno.test("capnpc-deno CLI normalizes output paths and rejects empty normalized output", () => {
  assertThrows(
    () =>
      finalizeGeneratedFiles(
        [{ path: ".", sourceFilename: "schema/person.capnp", contents: "//" }],
        {
          layout: "flat",
          srcDirs: [],
          emitBarrel: false,
        },
      ),
    /invalid output path/i,
  );

  const out = finalizeGeneratedFiles(
    [
      {
        path: "./nested//person_capnp.ts",
        sourceFilename: "schema/person.capnp",
        contents: "// normalized",
      },
    ],
    {
      layout: "flat",
      srcDirs: [],
      emitBarrel: false,
    },
  );
  assertEquals(out[0].path, "nested/person_capnp.ts");
});

Deno.test("capnpc-deno CLI barrel rendering preserves explicit relative specifiers", () => {
  const source = renderBarrelModule(["./already.ts", "nested/file.ts"]);
  assert(
    source.includes('export * from "./already.ts";'),
    "expected explicit relative specifier to be preserved",
  );
  assert(
    source.includes('export * from "./nested/file.ts";'),
    "expected implicit relative specifier to be normalized",
  );
});

Deno.test("capnpc-deno CLI include path computation trims repeated trailing separators", () => {
  const include = computeIncludePaths(
    ["vendor///"],
    ["schemas///"],
    ["schemas/person.capnp"],
  );
  assertEquals(include.join(","), "vendor,schemas");
});

Deno.test("capnpc-deno CLI keeps absolute out_dir config paths unchanged", async () => {
  const options = parseCliArgs(["generate", "--config", "cfg.toml"]);
  await withPatchedReadTextFile(
    () => Promise.resolve('out_dir = "/tmp/generated"'),
    async () => {
      const loaded = await loadCliFileConfig(options);
      assert(loaded !== null, "expected config to load");
      assertEquals(loaded.outDir, "/tmp/generated");
    },
  );
});
