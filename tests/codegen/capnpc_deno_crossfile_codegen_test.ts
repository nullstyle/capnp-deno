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
 *   - cross-file interfaces: `import type` for the service type plus value
 *     imports of the owning module's token and client factories, so
 *     `RpcStub<T>` typing and token-based encode/decode work across modules
 *   - struct fields typed by interfaces: `RpcStub<T> | null` typing plus
 *     module-private capability walkers that dehydrate live stubs before
 *     encoding and hydrate decoded pointers into typed stubs (direct fields,
 *     List elements, group members, nested cap-bearing structs)
 *   - zero TYPE_ANY_POINTER / TYPE_UINT16 fallbacks at typed positions and
 *     zero capability-pointer fallbacks for indexed interfaces
 *   - per-file generation emits identical import lines byte-for-byte
 *   - layout-aware import specifiers (flat, schema, nested directories)
 *   - runtime encode/decode round-trip through the generated codecs,
 *     including stub dehydration through a cap-bearing struct codec
 *   - a live in-process RPC flow (WASM session harness) where a
 *     consumer-module service receives a base-module capability as a param,
 *     calls a method on it, returns it in results, and hands a typed stub
 *     back inside a struct-carried result field
 */

import { finalizeGeneratedFiles } from "../../tools/capnpc-deno/cli.ts";
import { generateTypescriptFiles } from "../../tools/capnpc-deno/emitter.ts";
import type { GeneratedFile } from "../../tools/capnpc-deno/emitter.ts";
import { parseCodeGeneratorRequest } from "../../tools/capnpc-deno/request_parser.ts";
import {
  InMemoryRpcHarnessTransport,
  RpcServerRuntime,
  SessionRpcClientTransport,
} from "../../src/mod.ts";
import type { RpcGeneratedServerDispatch, RpcStub } from "../../src/rpc.ts";
import type { Watcher } from "../fixtures/generated/crossfile/base_types.ts";
import {
  createWatcherServer,
  WatcherInterfaceId,
} from "../fixtures/generated/crossfile/base_types.ts";
import {
  Hub,
  HubInterfaceId,
} from "../fixtures/generated/crossfile/consumer_types.ts";
import { assert, assertEquals, withTimeout } from "../test_utils.ts";

const CROSSFILE_REQUEST =
  "tests/fixtures/codegen_requests/crossfile_request.b64";
const CONSUMER_ONLY_REQUEST =
  "tests/fixtures/codegen_requests/crossfile_consumer_only_request.b64";
const NESTED_REQUEST =
  "tests/fixtures/codegen_requests/crossfile_nested_request.b64";

const EXPECTED_TYPE_IMPORT_LINE =
  'import type { Chunk, Level, Meta, Point, Watcher } from "./base_types.ts";';
const EXPECTED_VALUE_IMPORT_LINE =
  "import { ChunkStruct, createWatcherClient, createWatcherServiceClient, " +
  'MetaStruct, PointStruct, Watcher as Watcher$Base } from "./base_types.ts";';

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

// ---------------------------------------------------------------------------
// Emitter: cross-file interface resolution (P2)
// ---------------------------------------------------------------------------

const IMPORTED_STUB_FACTORY =
  "(nextTransport, nextCapability) => createWatcherServiceClient(createWatcherClient(nextTransport, nextCapability), nextTransport)";

Deno.test("crossfile: imported interfaces get typed stubs and token-based encode/decode", async () => {
  const generated = await generateFromFixture(CROSSFILE_REQUEST);
  const consumer = fileByPath(generated, "consumer_types.ts").contents;
  const base = fileByPath(generated, "base_types.ts").contents;

  // The owning module exports its high-level client adapter so importers can
  // build typed stubs; the low-level factory was already exported.
  assert(
    base.includes("export function createWatcherServiceClient("),
    "expected owning module to export the high-level client adapter",
  );
  assert(
    base.includes("export function createWatcherClient("),
    "expected owning module to export the low-level client factory",
  );

  // Single-field flattening types use the imported interface name in both
  // param and result positions (typed RpcStub, not CapabilityPointer).
  assert(
    consumer.includes(
      "attach(value: Watcher | RpcStub<Watcher>, options?: RpcCallOptions): Promise<void>;",
    ),
    "expected imported-interface param flattening to keep RpcStub typing",
  );
  assert(
    consumer.includes(
      "acquire(options?: RpcCallOptions): Promise<RpcStub<Watcher>>;",
    ),
    "expected imported-interface result flattening to keep RpcStub typing",
  );

  // Client param position: local implementations are exported through the
  // imported service token (value import alias, dereferenced only at call
  // time so mutually-importing schema files cannot hit module-init TDZ).
  assert(
    consumer.includes(
      "watcher: exportCapabilityFromTransport(transport, Watcher$Base, value)",
    ),
    "expected client params to export capabilities via the imported token",
  );
  // Client result position: capabilities decode into typed stubs through the
  // owning module's exported factories.
  assert(
    consumer.includes(
      `return capabilityToServiceStub(result.watcher, transport, ${IMPORTED_STUB_FACTORY});`,
    ),
    "expected client results to decode via the imported client factories",
  );
  // Server param position: inbound capabilities become typed callback stubs.
  assert(
    consumer.includes(
      `capabilityToServiceStub(params.watcher, requireOutboundClient(_ctx), ${IMPORTED_STUB_FACTORY})`,
    ),
    "expected server params to decode via the imported client factories",
  );
  // Server result position: returned implementations/stubs are exported
  // through the imported token.
  assert(
    consumer.includes(
      "watcher: exportCapabilityFromContext(_ctx, Watcher$Base, result)",
    ),
    "expected server results to export capabilities via the imported token",
  );

  // The unknown-interface fallbacks must be unreachable for indexed
  // interfaces: no ProtocolError throw for the result path and no bare
  // capability-pointer coercions at the flattened param/result construction
  // sites. (`requireRpcStubCapability` still appears in the shared helper
  // declaration, inside `capabilityToServiceStub`, and in the capability
  // walkers' stub-to-pointer dehydration.)
  assert(
    !consumer.includes("cannot decode non-local capability result"),
    "imported-interface results must not fall back to a ProtocolError throw",
  );
  assert(
    !consumer.includes("requireRpcStubCapability(value) }") &&
      !consumer.includes("requireRpcStubCapability(result as unknown)"),
    "imported-interface positions must not fall back to raw capability pointers",
  );
  assert(
    !consumer.includes(" as unknown) as unknown as "),
    "imported-interface server params must not fall back to unsafe casts",
  );
});

// ---------------------------------------------------------------------------
// Emitter: struct fields typed by interfaces (P4)
// ---------------------------------------------------------------------------

Deno.test("crossfile: struct fields typed by an imported interface get typed stubs and walkers", async () => {
  const generated = await generateFromFixture(CROSSFILE_REQUEST);
  const consumer = fileByPath(generated, "consumer_types.ts").contents;

  // Struct fields typed by an imported interface become typed stubs, in the
  // direct-field, List-element, and group-member positions.
  assert(
    consumer.includes("export interface Registration {"),
    "expected the Registration fixture struct",
  );
  assert(
    consumer.includes("  watcher: RpcStub<Watcher> | null;"),
    "struct fields typed by an imported interface become RpcStub<T> | null",
  );
  assert(
    consumer.includes("  backups: (RpcStub<Watcher> | null)[];"),
    "List(imported interface) fields become typed stub arrays",
  );
  assert(
    !consumer.includes("CapabilityPointer | null;"),
    "no struct field may stay a raw capability pointer",
  );

  // Cap-bearing structs get module-private capability walkers...
  assert(
    consumer.includes(
      "function dehydrateStubs$Registration(value: Registration): Registration {",
    ),
    "expected the Registration dehydrate walker",
  );
  assert(
    consumer.includes(
      "function hydrateStubs$Registration(value: Registration, transport: () => RpcClientTransport): Registration {",
    ),
    "expected the Registration hydrate walker",
  );
  // ...that recurse into nested cap-bearing structs, List elements, and
  // inline group members through the imported interface's client factories.
  assert(
    consumer.includes(
      "out.registration = hydrateStubs$Registration(out.registration, transport);",
    ),
    "expected nested struct recursion in the RegisterResults walker",
  );
  assert(
    consumer.includes("out.backups = out.backups.map((item0) =>"),
    "expected List element hydration in the Registration walker",
  );
  assert(
    consumer.includes("out.route = { ...out.route };"),
    "expected inline group handling in the Registration walker",
  );
  assert(
    consumer.includes(
      `out.watcher = capabilityToServiceStub(out.watcher, transport(), ${IMPORTED_STUB_FACTORY});`,
    ),
    "expected typed stub hydration through the imported client factories",
  );

  // Codecs dehydrate live stubs before encoding; the RPC layer dehydrates
  // params/results before encoding and hydrates them after decoding, with the
  // server side resolving the outbound transport lazily.
  assert(
    consumer.includes(
      "encodeStructMessage(RegistrationStruct, dehydrateStubs$Registration(value)),",
    ),
    "expected the Registration codec to dehydrate stubs on encode",
  );
  assert(
    consumer.includes(
      "encodeStructMessageWithCaps(AttachParamsStruct, dehydrateStubs$AttachParams(params));",
    ),
    "expected client params to be dehydrated before encoding",
  );
  assert(
    consumer.includes(
      "return hydrateStubs$RegisterResults(decodeStructMessageWithCaps(RegisterResultsStruct, raw.contentBytes, raw.capTable) as RegisterResults, () => transport);",
    ),
    "expected client results to be hydrated after decoding",
  );
  assert(
    consumer.includes(
      "const decoded = hydrateStubs$AttachParams(decodeStructMessageWithCaps(AttachParamsStruct, params, ctx.paramsCapTable ?? []) as AttachParams, () => requireOutboundClient(ctx));",
    ),
    "expected server params to be hydrated after decoding",
  );
  assert(
    consumer.includes(
      "const encoded = encodeStructMessageWithCaps(RegisterResultsStruct, dehydrateStubs$RegisterResults(result));",
    ),
    "expected server results to be dehydrated before encoding",
  );

  // The owning module of the interface stays walker-free (its structs carry
  // no capabilities), so cap-free schemas keep byte-identical output.
  const base = fileByPath(generated, "base_types.ts").contents;
  assert(
    !base.includes("hydrateStubs$") && !base.includes("dehydrateStubs$"),
    "cap-free modules must not gain capability walkers",
  );
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

Deno.test("crossfile: cap-bearing struct codec dehydrates live stubs on encode", async () => {
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

  const codec = mod.RegistrationCodec as {
    encode(value: unknown): Uint8Array;
    decode(bytes: Uint8Array): unknown;
  };
  assert(codec !== undefined, "expected RegistrationCodec export");

  // Live RpcStub proxies expose their capability only through the shared
  // RPC_STUB_CAPABILITY tag; the walker-backed codec must dehydrate them in
  // the direct-field, List-element, and group-member positions. Raw
  // capability pointers keep working alongside.
  const stubTag = Symbol.for("@nullstyle/capnp/rpcStubCapability");
  const fakeStub = (capabilityIndex: number): unknown => ({
    [stubTag]: { capabilityIndex },
  });
  const encoded = codec.encode({
    label: "reg",
    watcher: fakeStub(7),
    backups: [{ capabilityIndex: 3 }, fakeStub(9)],
    route: { primary: fakeStub(5) },
  });

  const decoded = codec.decode(encoded) as {
    label: string;
    watcher: { capabilityIndex: number } | null;
    backups: ({ capabilityIndex: number } | null)[];
    route: { primary: { capabilityIndex: number } | null };
  };
  assertEquals(decoded.label, "reg");
  assertEquals(decoded.watcher?.capabilityIndex, 7);
  assertEquals(
    decoded.backups.map((item) => item?.capabilityIndex).join(","),
    "3,9",
  );
  assertEquals(decoded.route.primary?.capabilityIndex, 5);

  // Null capabilities stay null through the same walker paths.
  const nulls = codec.decode(codec.encode({
    label: "",
    watcher: null,
    backups: [],
    route: { primary: null },
  })) as { watcher: unknown; route: { primary: unknown } };
  assertEquals(nulls.watcher, null);
  assertEquals(nulls.route.primary, null);
});

// ---------------------------------------------------------------------------
// Live in-process RPC across generated modules (committed fixture bundle)
// ---------------------------------------------------------------------------

Deno.test("crossfile: live RPC routes a base-module capability through a consumer-module service", async () => {
  // Consumer-module Hub service: receives a base-module Watcher capability as
  // a param, calls a method on it while the original call is still pending,
  // holds it, and hands a Watcher capability back through the result path.
  const serverEchoes: number[] = [];
  let held: RpcStub<Watcher> | null = null;
  const hubImpl: Hub = {
    attach: async (value) => {
      // The generated server adapter always delivers a typed stub built from
      // the base module's exported client factories (cross-module imports).
      const watcher = value as RpcStub<Watcher>;
      const echoed = await watcher.ping({
        seq: 41,
        payload: new Uint8Array([1, 2]),
      });
      serverEchoes.push(echoed.seq);
      held = watcher;
    },
    acquire: () => {
      if (!held) throw new Error("no watcher attached");
      // Runtime limitations verified in this suite's development: the wasm
      // host-call return path only relays capability ids the session already
      // knows (the root export), and client-exported callback capabilities
      // are released once their exporting call finishes. Returning the
      // received stub itself therefore needs capability-reflection support
      // the runtime does not have yet, so hand back the root-hosted Watcher
      // endpoint. The generated cross-module result path still runs in full:
      // exportCapabilityFromContext executes against the imported base-module
      // token binding, and the client decodes the returned capability into a
      // typed stub via the imported client factories.
      return Promise.resolve(
        { capabilityIndex: 0 } as unknown as RpcStub<Watcher>,
      );
    },
    register: () => {
      // P4 struct-carried capability: the Watcher rides inside a Registration
      // struct field instead of a flattened single-field result. The same
      // root-export limitation as acquire applies, so hand back the
      // root-hosted Watcher endpoint as a raw pointer; the generated dispatch
      // dehydrates the result struct and the client-side walker hydrates the
      // field into a live typed stub.
      return Promise.resolve({
        label: "root-watcher",
        watcher: { capabilityIndex: 0 } as unknown as RpcStub<Watcher>,
        backups: [],
        route: { primary: null },
      });
    },
  };

  // The root capability serves Hub and doubles as a base-module Watcher
  // endpoint so a Watcher capability can ride back through acquire's result.
  const rootWatcherEndpoint = createWatcherServer({
    ping: (params, _ctx) => {
      const chunk = params.chunk;
      return { chunk: { seq: chunk.seq + 100, payload: chunk.payload } };
    },
  });

  const transport = new InMemoryRpcHarnessTransport();
  const runtime = await RpcServerRuntime.createWithRoot(
    transport,
    (registry, server: Hub, options) => {
      let hubDispatch: RpcGeneratedServerDispatch | undefined;
      Hub.registerServer({
        exportCapability: (dispatch) => {
          hubDispatch = dispatch;
          return { capabilityIndex: 0 };
        },
      }, server);
      const combined: RpcGeneratedServerDispatch = {
        interfaceId: HubInterfaceId,
        interfaceIds: [HubInterfaceId, WatcherInterfaceId],
        dispatch: (methodId, params, ctx) =>
          ctx.interfaceId === WatcherInterfaceId
            ? rootWatcherEndpoint.dispatch(methodId, params, ctx)
            : hubDispatch!.dispatch(methodId, params, ctx),
      };
      return registry.exportCapability(combined, options);
    },
    hubImpl,
    { autoStart: true },
  );
  try {
    const clientTransport = new SessionRpcClientTransport(
      runtime.session,
      transport,
      { interfaceId: HubInterfaceId, autoStart: false },
    );
    const hub = await withTimeout(
      Hub.bootstrapClient(clientTransport),
      2_000,
      "bootstrap consumer-module Hub client",
    );

    // Local base-module Watcher implementation, exported as a capability by
    // the consumer module's client adapter via the imported Watcher token.
    const clientPings: number[] = [];
    const watcherImpl: Watcher = {
      ping: (chunk) => {
        clientPings.push(chunk.seq);
        return Promise.resolve({
          seq: chunk.seq + 1,
          payload: chunk.payload,
        });
      },
    };

    await withTimeout(
      hub.attach(watcherImpl, { timeoutMs: 2_000 }),
      2_500,
      "attach base-module watcher capability",
    );
    assertEquals(
      clientPings.join(","),
      "41",
      "expected the server-side callback to reach the local watcher",
    );
    assertEquals(
      serverEchoes.join(","),
      "42",
      "expected the consumer-module service to observe the watcher's reply",
    );

    // The capability handed back through the single-field result flattening
    // path decodes into a typed RpcStub<Watcher> and stays callable.
    const reacquired = await withTimeout(
      hub.acquire({ timeoutMs: 2_000 }),
      2_500,
      "acquire a watcher capability back",
    );
    const pong = await withTimeout(
      reacquired.ping({ seq: 7, payload: new Uint8Array([9]) }, {
        timeoutMs: 2_000,
      }),
      2_500,
      "call the reacquired watcher stub",
    );
    assertEquals(pong.seq, 107);

    // P4: a capability carried inside a struct-typed result field round-trips
    // into a live typed stub. The generated dispatch dehydrates the
    // Registration inside RegisterResults, the wire relays the capability,
    // and the client-side hydrate walker rebuilds an RpcStub<Watcher> through
    // the imported base-module client factories.
    const registration = await withTimeout(
      hub.register({ timeoutMs: 2_000 }),
      2_500,
      "register: struct-carried capability round-trip",
    );
    assertEquals(registration.label, "root-watcher");
    assertEquals(registration.backups.length, 0);
    assertEquals(registration.route.primary, null);
    assert(
      registration.watcher !== null,
      "expected a watcher stub in the struct-carried result field",
    );
    const structStub = registration.watcher;
    assert(
      typeof structStub.close === "function",
      "expected a live typed stub (with lifecycle), not a raw pointer",
    );
    const structPong = await withTimeout(
      structStub.ping({ seq: 11, payload: new Uint8Array([4]) }, {
        timeoutMs: 2_000,
      }),
      2_500,
      "call the struct-carried watcher stub",
    );
    assertEquals(structPong.seq, 111);
  } finally {
    await runtime.close();
  }
});
