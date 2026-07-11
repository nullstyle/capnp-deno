import {
  applyImplicitPluginDefaults,
  barrelNamespaceIdentifier,
  computeIncludePaths,
  discoverSchemaFiles,
  finalizeGeneratedFiles,
  helpText,
  loadCliFileConfig,
  mapGeneratedFilePath,
  mergeBarrelWithExistingModule,
  mergeCliOptionsWithConfig,
  parseBarrelModuleEntries,
  parseCliArgs,
  parseCliConfigToml,
  renderBarrelModule,
} from "../../tools/capnpc-deno/cli.ts";
import {
  CliConfigError,
  CliUsageError,
} from "../../tools/capnpc-deno/errors.ts";
import type { GeneratedFile } from "../../tools/capnpc-deno/emitter.ts";
import { assert, assertEquals, assertThrows } from "../test_utils.ts";

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
    output[5].contents.includes(
      'export * as personCapnp from "./person_capnp.ts";',
    ),
    "expected namespaced barrel export for person schema",
  );
  assert(
    output[5].contents.includes(
      'export * as personRpc from "./person_rpc.ts";',
    ),
    "expected namespaced barrel export for person rpc module",
  );
  assert(
    output[5].contents.includes(
      'export * as person from "./person_types.ts";',
    ),
    "expected namespaced barrel export for person types module",
  );
  assert(
    output[5].contents.includes(
      'export * as personMeta from "./person_meta.ts";',
    ),
    "expected namespaced barrel export for person meta module",
  );
  assert(
    output[5].contents.includes(
      'export * as nestedAddressbookCapnp from "./nested/addressbook_capnp.ts";',
    ),
    "expected namespaced barrel export for nested schema",
  );
  assert(
    !output[5].contents.includes("export * from"),
    "expected no flat re-exports to remain in the barrel",
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

Deno.test("capnpc-deno CLI treats option-like tokens after -- as positional schemas", () => {
  const options = parseCliArgs([
    "generate",
    "--",
    "--schema",
    "schema/foo.capnp",
    "-I",
    "vendor/capnp",
  ]);
  assertEquals(
    options.schemas.join(","),
    "--schema,schema/foo.capnp,-I,vendor/capnp",
  );
  assertEquals(options.importPaths.length, 0);
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

  const wireConstantsSuffix = mapGeneratedFilePath(
    {
      path: "person_wire_constants.ts",
      sourceFilename: "schemas/nested/person.capnp",
      contents: "// person wire constants",
    },
    "schema",
    ["schemas"],
  );
  assertEquals(wireConstantsSuffix, "nested/person_wire_constants.ts");

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

// capnp reports absolute schema paths (not under the invocation cwd) as the
// full path minus its leading "/", so `sourceFilename` here is that stripped
// form and `schemas` carries the original absolute input the user passed.
function typesFileFor(sourceFilename: string): GeneratedFile {
  return { path: "s_types.ts", sourceFilename, contents: "// types" };
}

function assertHasPath(files: GeneratedFile[], path: string): void {
  assert(
    files.some((file) => file.path === path),
    `expected output to include ${path}, got ${
      files.map((file) => file.path).join(", ")
    }`,
  );
}

Deno.test("capnpc-deno CLI flattens a single absolute --schema input to its basename", () => {
  const output = finalizeGeneratedFiles(
    [typesFileFor("private/tmp/foo/schemas/person_codegen.capnp")],
    {
      layout: "schema",
      srcDirs: [],
      emitBarrel: true,
      schemas: ["/private/tmp/foo/schemas/person_codegen.capnp"],
    },
  );
  assertEquals(output.length, 2);
  assertEquals(output[0].path, "person_codegen_types.ts");
  assertEquals(output[1].path, "mod.ts");
  assert(
    output[1].contents.includes(
      'export * as personCodegen from "./person_codegen_types.ts";',
    ),
    "expected barrel to export the flattened, non-mirrored module",
  );
});

Deno.test("capnpc-deno CLI roots multiple absolute --schema inputs at their common ancestor", () => {
  // Same basename in sibling directories must not collide, and nesting under a
  // shared parent must be preserved (common ancestor "/proj").
  const output = finalizeGeneratedFiles(
    [
      { path: "a_types.ts", sourceFilename: "proj/a.capnp", contents: "// a" },
      {
        path: "b_types.ts",
        sourceFilename: "proj/sub/b.capnp",
        contents: "// b",
      },
    ],
    {
      layout: "schema",
      srcDirs: [],
      emitBarrel: false,
      schemas: ["/proj/a.capnp", "/proj/sub/b.capnp"],
    },
  );
  assertHasPath(output, "a_types.ts");
  assertHasPath(output, "sub/b_types.ts");
});

Deno.test("capnpc-deno CLI keeps distinct absolute --schema siblings from colliding", () => {
  // "/a/x.capnp" and "/b/x.capnp" share a basename; their common ancestor is
  // the filesystem root, so each keeps its distinguishing directory instead of
  // both flattening to x_types.ts (which would abort with a path collision).
  const output = finalizeGeneratedFiles(
    [
      { path: "x_types.ts", sourceFilename: "a/x.capnp", contents: "// a" },
      { path: "x_types.ts", sourceFilename: "b/x.capnp", contents: "// b" },
    ],
    {
      layout: "schema",
      srcDirs: [],
      emitBarrel: false,
      schemas: ["/a/x.capnp", "/b/x.capnp"],
    },
  );
  assertHasPath(output, "a/x_types.ts");
  assertHasPath(output, "b/x_types.ts");
});

Deno.test("capnpc-deno CLI keeps mirroring relative --schema inputs", () => {
  const output = finalizeGeneratedFiles(
    [typesFileFor("schemas/person_codegen.capnp")],
    {
      layout: "schema",
      srcDirs: [],
      emitBarrel: false,
      schemas: ["schemas/person_codegen.capnp"],
    },
  );
  assertEquals(output[0].path, "schemas/person_codegen_types.ts");
});

Deno.test("capnpc-deno CLI does not re-anchor a relative --schema onto an unrelated absolute --src", () => {
  // The relative schema shares its first segment with the absolute srcDir's
  // basename; it must still mirror, not flatten under /schema.
  const output = finalizeGeneratedFiles(
    [{
      path: "foo_types.ts",
      sourceFilename: "schema/foo.capnp",
      contents: "",
    }],
    {
      layout: "schema",
      srcDirs: ["/schema"],
      emitBarrel: false,
      schemas: ["schema/foo.capnp"],
    },
  );
  assertEquals(output[0].path, "schema/foo_types.ts");
});

Deno.test("capnpc-deno CLI flattens absolute but mirrors relative when --schema mixes both", () => {
  // Both siblings report under "home/"; the absolute one flattens to its
  // basename, the relative one keeps mirroring — presence of the absolute
  // sibling must not change where the relative input lands.
  const output = finalizeGeneratedFiles(
    [
      {
        path: "foo_types.ts",
        sourceFilename: "home/foo.capnp",
        contents: "// abs",
      },
      {
        path: "bar_types.ts",
        sourceFilename: "home/bar.capnp",
        contents: "// rel",
      },
    ],
    {
      layout: "schema",
      srcDirs: [],
      emitBarrel: false,
      schemas: ["/home/foo.capnp", "home/bar.capnp"],
    },
  );
  assertHasPath(output, "foo_types.ts");
  assertHasPath(output, "home/bar_types.ts");
});

Deno.test("capnpc-deno CLI roots absolute --src directory schemas at the srcDir", () => {
  const output = finalizeGeneratedFiles(
    [
      {
        path: "person_types.ts",
        sourceFilename: "abs/schemas/nested/person.capnp",
        contents: "",
      },
    ],
    {
      layout: "schema",
      srcDirs: ["/abs/schemas"],
      emitBarrel: false,
      schemas: [],
    },
  );
  assertEquals(output[0].path, "nested/person_types.ts");
});

Deno.test("capnpc-deno CLI maps an absolute source at the filesystem root", () => {
  // Reconstructed absolute source with a filesystem-root ("/") layout root:
  // the leading slash is stripped without doubling the separator.
  const mapped = mapGeneratedFilePath(
    { path: "x_types.ts", sourceFilename: "/a/x.capnp", contents: "" },
    "schema",
    ["/"],
  );
  assertEquals(mapped, "a/x_types.ts");
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
    source.includes('export * as already from "./already.ts";'),
    "expected explicit relative specifier to be preserved",
  );
  assert(
    source.includes('export * as nestedFile from "./nested/file.ts";'),
    "expected implicit relative specifier to be normalized",
  );
});

Deno.test("capnpc-deno CLI barrel namespaces are sanitized valid identifiers", () => {
  // _types is the primary surface and drops its suffix; _meta keeps a Meta
  // tail; directories join the stem so sibling schemas with the same basename
  // stay distinct.
  assertEquals(barrelNamespaceIdentifier("person_types.ts"), "person");
  assertEquals(barrelNamespaceIdentifier("person_meta.ts"), "personMeta");
  assertEquals(barrelNamespaceIdentifier("a/schema_types.ts"), "aSchema");
  assertEquals(barrelNamespaceIdentifier("b/schema_types.ts"), "bSchema");
  assertEquals(
    barrelNamespaceIdentifier("nested/deep_meta.ts"),
    "nestedDeepMeta",
  );
  // Sanitization: leading digits and reserved words cannot become bare
  // namespace bindings.
  assertEquals(barrelNamespaceIdentifier("1st_schema_types.ts"), "$1stSchema");
  assertEquals(barrelNamespaceIdentifier("default_types.ts"), "default$");
  assertEquals(barrelNamespaceIdentifier("class_types.ts"), "class$");

  // Distinct paths that sanitize to the same identifier are uniqued
  // deterministically in sorted-entry order ("foo_bar_types.ts" sorts before
  // "foo/bar_types.ts" under localeCompare).
  const source = renderBarrelModule(["foo/bar_types.ts", "foo_bar_types.ts"]);
  assert(
    source.includes('export * as fooBar from "./foo_bar_types.ts";'),
    "expected first sorted entry to keep the base namespace",
  );
  assert(
    source.includes('export * as fooBar2 from "./foo/bar_types.ts";'),
    "expected colliding namespace to be uniqued with a numeric suffix",
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

async function withFakeOutputDir(
  files: Map<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  const denoMutable = Deno as unknown as {
    readTextFile: typeof Deno.readTextFile;
    stat: typeof Deno.stat;
  };
  const originalReadTextFile = denoMutable.readTextFile;
  const originalStat = denoMutable.stat;
  denoMutable.readTextFile = ((path: string | URL) => {
    const key = String(path).replaceAll("\\", "/");
    const contents = files.get(key);
    if (contents === undefined) {
      return Promise.reject(new Deno.errors.NotFound(key));
    }
    return Promise.resolve(contents);
  }) as typeof Deno.readTextFile;
  denoMutable.stat = ((path: string | URL) => {
    const key = String(path).replaceAll("\\", "/");
    if (!files.has(key)) {
      return Promise.reject(new Deno.errors.NotFound(key));
    }
    return Promise.resolve({ isFile: true } as Deno.FileInfo);
  }) as typeof Deno.stat;
  try {
    await fn();
  } finally {
    denoMutable.readTextFile = originalReadTextFile;
    denoMutable.stat = originalStat;
  }
}

Deno.test("capnpc-deno CLI parses machine-generated barrel entries", () => {
  const rendered = renderBarrelModule([
    "b_types.ts",
    "./a_types.ts",
    "nested/c_meta.ts",
  ]);
  assertEquals(
    parseBarrelModuleEntries(rendered)?.join(","),
    "a_types.ts,b_types.ts,nested/c_meta.ts",
  );
  assertEquals(parseBarrelModuleEntries(renderBarrelModule([]))?.length, 0);

  // Legacy flat barrels (from releases before namespaced barrels) must keep
  // parsing so a merge can migrate them to the namespaced form.
  assertEquals(
    parseBarrelModuleEntries(
      '// Generated by capnpc-deno\nexport * from "./a_types.ts";\nexport * from "./a_meta.ts";\n',
    )?.join(","),
    "a_types.ts,a_meta.ts",
    "expected legacy flat barrel entries to parse for migration",
  );

  assertEquals(
    parseBarrelModuleEntries('export * from "./a_types.ts";\n'),
    null,
    "expected barrel without generated header to be rejected",
  );
  assertEquals(
    parseBarrelModuleEntries(
      '// Generated by capnpc-deno\nconst custom = 1;\nexport * from "./a_types.ts";\n',
    ),
    null,
    "expected barrel with non-export statements to be rejected",
  );
  assertEquals(
    parseBarrelModuleEntries(
      '// Generated by capnpc-deno\nexport * from "../escape_types.ts";\n',
    ),
    null,
    "expected parent traversal entries to be rejected",
  );
  assertEquals(
    parseBarrelModuleEntries(
      '// Generated by capnpc-deno\nexport * from "/abs/a_types.ts";\n',
    ),
    null,
    "expected absolute entries to be rejected",
  );
});

Deno.test("capnpc-deno CLI merges barrel exports across successive per-schema runs", async () => {
  const disk = new Map<string, string>();

  const runA = finalizeGeneratedFiles(
    [
      {
        path: "a_types.ts",
        sourceFilename: "schema/a.capnp",
        contents: "// a types",
      },
      {
        path: "a_meta.ts",
        sourceFilename: "schema/a.capnp",
        contents: "// a meta",
      },
    ],
    { layout: "flat", srcDirs: [], emitBarrel: true },
  );
  await withFakeOutputDir(disk, async () => {
    const merged = await mergeBarrelWithExistingModule(runA, "gen");
    assert(
      merged === runA,
      "expected first run without an existing barrel to stay unchanged",
    );
  });
  for (const file of runA) {
    disk.set(`gen/${file.path}`, file.contents);
  }

  const runB = finalizeGeneratedFiles(
    [
      {
        path: "b_types.ts",
        sourceFilename: "schema/b.capnp",
        contents: "// b types",
      },
      {
        path: "b_meta.ts",
        sourceFilename: "schema/b.capnp",
        contents: "// b meta",
      },
    ],
    { layout: "flat", srcDirs: [], emitBarrel: true },
  );
  await withFakeOutputDir(disk, async () => {
    const merged = await mergeBarrelWithExistingModule(runB, "gen");
    const barrel = merged.find((file) => file.path === "mod.ts");
    assert(barrel !== undefined, "expected merged output to include barrel");
    assertEquals(
      barrel.contents,
      renderBarrelModule([
        "a_meta.ts",
        "a_types.ts",
        "b_meta.ts",
        "b_types.ts",
      ]),
    );
    assertEquals(
      merged.filter((file) => file.path !== "mod.ts").length,
      runB.length - 1,
      "expected only barrel contents to change",
    );
  });
});

Deno.test("capnpc-deno CLI barrel merge drops stale entries and skips hand-written barrels", async () => {
  const current = finalizeGeneratedFiles(
    [
      {
        path: "b_types.ts",
        sourceFilename: "schema/b.capnp",
        contents: "// b types",
      },
    ],
    { layout: "flat", srcDirs: [], emitBarrel: true },
  );

  const staleDisk = new Map<string, string>([
    ["gen/mod.ts", renderBarrelModule(["a_types.ts", "removed_types.ts"])],
    ["gen/a_types.ts", "// a types"],
  ]);
  await withFakeOutputDir(staleDisk, async () => {
    const merged = await mergeBarrelWithExistingModule(current, "gen");
    const barrel = merged.find((file) => file.path === "mod.ts");
    assert(barrel !== undefined, "expected merged output to include barrel");
    assert(
      barrel.contents.includes('export * as a from "./a_types.ts";'),
      "expected existing module with file on disk to be preserved",
    );
    assert(
      !barrel.contents.includes("removed_types.ts"),
      "expected stale entry without a file on disk to be dropped",
    );
  });

  const handWrittenDisk = new Map<string, string>([
    ["gen/mod.ts", '// curated by hand\nexport * from "./a_types.ts";\n'],
    ["gen/a_types.ts", "// a types"],
  ]);
  await withFakeOutputDir(handWrittenDisk, async () => {
    const merged = await mergeBarrelWithExistingModule(current, "gen");
    assert(
      merged === current,
      "expected hand-written barrel to be overwritten, not merged",
    );
  });
});

Deno.test("capnpc-deno CLI barrel merge migrates legacy flat barrels to the namespaced form", async () => {
  const current = finalizeGeneratedFiles(
    [
      {
        path: "b_types.ts",
        sourceFilename: "schema/b.capnp",
        contents: "// b types",
      },
    ],
    { layout: "flat", srcDirs: [], emitBarrel: true },
  );

  // An old-form barrel written by a release before namespaced barrels: the
  // entries carry the same module paths, so a merge rewrites them namespaced.
  const legacyDisk = new Map<string, string>([
    [
      "gen/mod.ts",
      "// Generated by capnpc-deno\n// DO NOT EDIT MANUALLY.\n\n" +
      'export * from "./a_meta.ts";\nexport * from "./a_types.ts";\n',
    ],
    ["gen/a_types.ts", "// a types"],
    ["gen/a_meta.ts", "// a meta"],
  ]);
  await withFakeOutputDir(legacyDisk, async () => {
    const merged = await mergeBarrelWithExistingModule(current, "gen");
    const barrel = merged.find((file) => file.path === "mod.ts");
    assert(barrel !== undefined, "expected merged output to include barrel");
    assertEquals(
      barrel.contents,
      renderBarrelModule(["a_meta.ts", "a_types.ts", "b_types.ts"]),
    );
    assert(
      barrel.contents.includes('export * as a from "./a_types.ts";'),
      "expected legacy flat entry to be rewritten as a namespaced export",
    );
    assert(
      barrel.contents.includes('export * as aMeta from "./a_meta.ts";'),
      "expected legacy meta entry to be rewritten as a namespaced export",
    );
    assert(
      !barrel.contents.includes("export * from"),
      "expected migration to leave no flat re-exports behind",
    );
  });
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
