/**
 * Cross-file schema codegen coverage: schemas that IMPORT other schema files.
 *
 * Fixture bundle (tests/fixtures/schemas/crossfile/):
 *   - base.capnp     declares Level (enum), Point/Meta/Chunk (structs), and
 *                    a Watcher interface
 *   - consumer.capnp imports base.capnp and uses the imported types in struct
 *                    fields, List elements, a named union arm, a group field,
 *                    method params/results, and a `-> stream` method
 *   - nested/deep.capnp imports "../base.capnp" from a subdirectory
 *
 * Precompiled CodeGeneratorRequests (tests/fixtures/codegen_requests/):
 *   - crossfile_request.b64               both base + consumer requested
 *   - crossfile_consumer_only_request.b64 only consumer requested (base is
 *                                         import-only; per-file mode)
 *   - crossfile_nested_request.b64        only nested/deep.capnp requested
 *
 * Covered here:
 *   - cross-file struct/enum type positions resolve to `import type` names
 *   - cross-file descriptors: struct refs import the exported descriptor
 *     behind deferred getters; enum refs materialize a local mirror
 *   - zero TYPE_ANY_POINTER / TYPE_UINT16 fallbacks at typed positions
 *   - per-file generation emits identical import lines byte-for-byte
 *   - layout-aware import specifiers (flat, schema, nested directories)
 *   - runtime encode/decode round-trip through the generated codecs
 */

import { finalizeGeneratedFiles } from "../../tools/capnpc-deno/cli.ts";
import { generateTypescriptFiles } from "../../tools/capnpc-deno/emitter.ts";
import type { GeneratedFile } from "../../tools/capnpc-deno/emitter.ts";
import { parseCodeGeneratorRequest } from "../../tools/capnpc-deno/request_parser.ts";
import { assert, assertEquals } from "../test_utils.ts";

const CROSSFILE_REQUEST =
  "tests/fixtures/codegen_requests/crossfile_request.b64";
const CONSUMER_ONLY_REQUEST =
  "tests/fixtures/codegen_requests/crossfile_consumer_only_request.b64";
const NESTED_REQUEST =
  "tests/fixtures/codegen_requests/crossfile_nested_request.b64";

const EXPECTED_TYPE_IMPORT_LINE =
  'import type { Chunk, Level, Meta, Point } from "./base_types.ts";';
const EXPECTED_VALUE_IMPORT_LINE =
  'import { ChunkStruct, MetaStruct, PointStruct } from "./base_types.ts";';

async function decodeFixture(path: string): Promise<Uint8Array> {
  const base64 = (await Deno.readTextFile(path)).trim();
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function generateFromFixture(path: string): Promise<GeneratedFile[]> {
  return generateTypescriptFiles(
    parseCodeGeneratorRequest(await decodeFixture(path)),
  );
}

function fileByPath(files: GeneratedFile[], path: string): GeneratedFile {
  const file = files.find((candidate) => candidate.path === path);
  assert(file !== undefined, `expected generated file: ${path}`);
  return file;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Emitter: cross-file struct/enum resolution
// ---------------------------------------------------------------------------

Deno.test("crossfile: consumer imports cross-file types from the owning module", async () => {
  const generated = await generateFromFixture(CROSSFILE_REQUEST);
  assertEquals(
    generated.map((file) => file.path).join(","),
    "base_types.ts,base_meta.ts,consumer_types.ts,consumer_meta.ts",
  );

  const consumer = fileByPath(generated, "consumer_types.ts");
  assert(
    consumer.contents.includes(`${EXPECTED_TYPE_IMPORT_LINE}\n`),
    "expected consumer types module to import cross-file type names",
  );
  assert(
    consumer.contents.includes(`${EXPECTED_VALUE_IMPORT_LINE}\n`),
    "expected consumer types module to import cross-file struct descriptors",
  );
  assertEquals(
    JSON.stringify(consumer.crossSchemaImports),
    JSON.stringify([{
      specifier: "./base_types.ts",
      targetSourceFilename: "tests/fixtures/schemas/crossfile/base.capnp",
    }]),
  );

  // Type positions use the imported names (no bare unimported identifiers,
  // no local re-declarations of the imported types).
  for (
    const line of [
      "  meta: Meta;",
      "  level: Level;",
      "  points: Point[];",
      "  point?: Point;",
      "  fallback: Point;",
      "  chunk: Chunk;",
      "  origin: Point;",
      "  echo: Meta;",
    ]
  ) {
    assert(
      consumer.contents.includes(`${line}\n`),
      `expected imported type position: ${line.trim()}`,
    );
  }
  assert(
    !consumer.contents.includes("interface Meta ") &&
      !consumer.contents.includes("interface Point "),
    "imported struct types must not be re-declared locally",
  );

  // The owning module keeps single-file output: no sibling imports.
  const base = fileByPath(generated, "base_types.ts");
  assert(
    !base.contents.includes('from "./'),
    "base module must not gain sibling imports",
  );
});

Deno.test("crossfile: descriptors use deferred getters and enum mirrors, no fallbacks", async () => {
  const generated = await generateFromFixture(CROSSFILE_REQUEST);
  const consumer = fileByPath(generated, "consumer_types.ts").contents;

  // Struct positions: exported descriptor of the owning module behind a
  // deferred getter (TDZ-safe for mutually-importing schema modules).
  assert(
    consumer.includes('type: { kind: "struct", get: () => MetaStruct },'),
    "expected imported struct field descriptor via deferred getter",
  );
  assert(
    consumer.includes(
      'type: { kind: "list", element: { kind: "struct", get: () => PointStruct } },',
    ),
    "expected imported List element descriptor via deferred getter",
  );
  assert(
    consumer.includes("meta: MetaStruct.createDefault(),"),
    "expected imported struct default via the imported descriptor",
  );

  // Enum positions: local mirror descriptor built from the schema nodes (the
  // owning module does not export enum descriptors), typed by the imported
  // enum type.
  assert(
    consumer.includes(
      'const LevelValues = ["info", "warn", "error"] as const;',
    ),
    "expected imported enum values mirror",
  );
  assert(
    consumer.includes("const LevelType: EnumTypeDescriptor<Level> = {"),
    "expected imported enum descriptor mirror",
  );
  assert(
    consumer.includes("type: LevelType,"),
    "expected imported enum field descriptor to use the mirror",
  );
  assert(
    consumer.includes("level: LevelValues[0],"),
    "expected imported enum default to use the mirror values",
  );

  // Zero fallback lowering at typed positions: the only occurrences of the
  // fallback descriptors are the fixed runtime import block.
  assertEquals(
    countOccurrences(consumer, "TYPE_ANY_POINTER"),
    1,
    "cross-file struct positions must not lower to TYPE_ANY_POINTER",
  );
  assertEquals(
    countOccurrences(consumer, "TYPE_UINT16"),
    1,
    "cross-file enum positions must not lower to TYPE_UINT16",
  );
  assert(!consumer.includes("type: TYPE_ANY_POINTER"));
  assert(!consumer.includes("type: TYPE_UINT16"));
});

Deno.test("crossfile: repeated generation is byte-identical", async () => {
  const run1 = await generateFromFixture(CROSSFILE_REQUEST);
  const run2 = await generateFromFixture(CROSSFILE_REQUEST);
  assertEquals(run1.length, run2.length);
  for (let i = 0; i < run1.length; i += 1) {
    assertEquals(run1[i].path, run2[i].path);
    assertEquals(run1[i].contents, run2[i].contents);
    assertEquals(
      JSON.stringify(run1[i].crossSchemaImports),
      JSON.stringify(run2[i].crossSchemaImports),
    );
  }
});

// ---------------------------------------------------------------------------
// Per-file generation mode (base is import-only, not emitted by this run)
// ---------------------------------------------------------------------------

Deno.test("crossfile: per-file mode emits identical import lines for a module it does not emit", async () => {
  const generated = await generateFromFixture(CONSUMER_ONLY_REQUEST);
  assertEquals(
    generated.map((file) => file.path).join(","),
    "consumer_types.ts,consumer_meta.ts",
    "per-file mode must only emit the requested file's modules",
  );

  const consumer = fileByPath(generated, "consumer_types.ts");
  assert(
    consumer.contents.includes(`${EXPECTED_TYPE_IMPORT_LINE}\n`),
    "expected byte-identical type import line in per-file mode",
  );
  assert(
    consumer.contents.includes(`${EXPECTED_VALUE_IMPORT_LINE}\n`),
    "expected byte-identical value import line in per-file mode",
  );

  // The whole module matches the both-files run byte-for-byte: importers do
  // not depend on whether the imported module is generated in the same run.
  const bothRuns = await generateFromFixture(CROSSFILE_REQUEST);
  assertEquals(
    consumer.contents,
    fileByPath(bothRuns, "consumer_types.ts").contents,
  );
  assertEquals(
    JSON.stringify(consumer.crossSchemaImports),
    JSON.stringify(
      fileByPath(bothRuns, "consumer_types.ts").crossSchemaImports,
    ),
  );
});

// ---------------------------------------------------------------------------
// Layout-aware import specifiers via finalizeGeneratedFiles
// ---------------------------------------------------------------------------

Deno.test("crossfile: flat layout keeps sibling import specifiers", async () => {
  const generated = await generateFromFixture(CROSSFILE_REQUEST);
  const finalized = finalizeGeneratedFiles(generated, {
    layout: "flat",
    srcDirs: [],
    emitBarrel: false,
  });
  const consumer = fileByPath(finalized, "consumer_types.ts");
  assert(consumer.contents.includes(`${EXPECTED_TYPE_IMPORT_LINE}\n`));
  assert(consumer.contents.includes(`${EXPECTED_VALUE_IMPORT_LINE}\n`));
});

Deno.test("crossfile: schema layout keeps same-directory specifiers", async () => {
  const generated = await generateFromFixture(CROSSFILE_REQUEST);
  const finalized = finalizeGeneratedFiles(generated, {
    layout: "schema",
    srcDirs: ["tests/fixtures/schemas"],
    emitBarrel: false,
  });
  const consumer = fileByPath(finalized, "crossfile/consumer_types.ts");
  fileByPath(finalized, "crossfile/base_types.ts");
  assert(
    consumer.contents.includes(`${EXPECTED_TYPE_IMPORT_LINE}\n`),
    "same-directory modules keep the ./ sibling specifier",
  );
});

Deno.test("crossfile: schema layout rewrites nested-directory specifiers", async () => {
  const generated = await generateFromFixture(NESTED_REQUEST);
  const finalized = finalizeGeneratedFiles(generated, {
    layout: "schema",
    srcDirs: ["tests/fixtures/schemas/crossfile"],
    emitBarrel: false,
  });
  const deep = fileByPath(finalized, "nested/deep_types.ts");
  assert(
    deep.contents.includes(
      'import type { Level, Point } from "../base_types.ts";\n',
    ),
    "expected parent-relative type import from the nested module",
  );
  assert(
    deep.contents.includes('import { PointStruct } from "../base_types.ts";\n'),
    "expected parent-relative value import from the nested module",
  );
  assert(
    !deep.contents.includes('"./base_types.ts"'),
    "flat sibling specifier must be fully rewritten",
  );
});

Deno.test("crossfile: flat layout flattens nested-directory specifiers", async () => {
  const generated = await generateFromFixture(NESTED_REQUEST);
  const finalized = finalizeGeneratedFiles(generated, {
    layout: "flat",
    srcDirs: ["tests/fixtures/schemas/crossfile"],
    emitBarrel: false,
  });
  const deep = fileByPath(finalized, "deep_types.ts");
  assert(
    deep.contents.includes(
      'import type { Level, Point } from "./base_types.ts";\n',
    ),
    "flat layout puts all modules side by side",
  );
});

// ---------------------------------------------------------------------------
// Runtime round-trip through the generated codecs
// ---------------------------------------------------------------------------

const ENCODING_RUNTIME_URL = new URL(
  "../../src/encoding.ts",
  import.meta.url,
).href;
const RPC_RUNTIME_URL = new URL(
  "../../src/rpc.ts",
  import.meta.url,
).href;

function patchRuntimeSpecifiers(source: string): string {
  return source
    .replaceAll(`"@nullstyle/capnp/encoding"`, `"${ENCODING_RUNTIME_URL}"`)
    .replaceAll(`"@nullstyle/capnp/rpc"`, `"${RPC_RUNTIME_URL}"`);
}

function toDataUrl(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `data:application/typescript;base64,${btoa(binary)}`;
}

Deno.test("crossfile: runtime round-trip through cross-file composite codecs", async () => {
  const generated = await generateFromFixture(CROSSFILE_REQUEST);
  const baseUrl = toDataUrl(
    patchRuntimeSpecifiers(fileByPath(generated, "base_types.ts").contents),
  );
  const consumerSource = patchRuntimeSpecifiers(
    fileByPath(generated, "consumer_types.ts").contents,
  ).replaceAll(`"./base_types.ts"`, `"${baseUrl}"`);
  const mod = await import(toDataUrl(consumerSource)) as Record<
    string,
    unknown
  >;

  const codec = mod.EnvelopeCodec as {
    encode(value: unknown): Uint8Array;
    decode(bytes: Uint8Array): unknown;
  };
  assert(codec !== undefined, "expected EnvelopeCodec export");

  const value = {
    meta: { label: "hello", level: "warn" },
    level: "error",
    points: [{ x: 1, y: 2 }, { x: -3, y: 4 }],
    body: { which: "point", point: { x: 7, y: 8 } },
    extra: { tag: "cross", fallback: { x: 9, y: -10 } },
  };

  const encoded = codec.encode(value);
  assert(encoded.byteLength > 0, "expected non-empty encoded message");
  const decoded = codec.decode(encoded) as Record<string, unknown>;

  const meta = decoded.meta as Record<string, unknown>;
  assertEquals(meta.label, "hello");
  assertEquals(meta.level, "warn");
  assertEquals(decoded.level, "error");
  const points = decoded.points as Array<Record<string, unknown>>;
  assertEquals(points.length, 2);
  assertEquals(points[0].x, 1);
  assertEquals(points[0].y, 2);
  assertEquals(points[1].x, -3);
  assertEquals(points[1].y, 4);
  const body = decoded.body as Record<string, unknown>;
  assertEquals(body.which, "point");
  assertEquals((body.point as Record<string, unknown>).x, 7);
  assertEquals((body.point as Record<string, unknown>).y, 8);
  const extra = decoded.extra as Record<string, unknown>;
  assertEquals(extra.tag, "cross");
  assertEquals((extra.fallback as Record<string, unknown>).x, 9);
  assertEquals((extra.fallback as Record<string, unknown>).y, -10);

  // Cross-file defaults: a null message decodes to the imported structs' and
  // enum's defaults via the imported descriptors / mirror values.
  const nullMessage = new Uint8Array(16);
  const view = new DataView(nullMessage.buffer);
  view.setUint32(0, 0, true); // 1 segment
  view.setUint32(4, 1, true); // 1 word
  const defaults = codec.decode(nullMessage) as Record<string, unknown>;
  assertEquals((defaults.meta as Record<string, unknown>).level, "info");
  assertEquals(defaults.level, "info");
  assertEquals((defaults.points as unknown[]).length, 0);
});
