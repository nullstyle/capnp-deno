/**
 * Roundtrip serialization tests for the codegen binary codec.
 *
 * These tests verify that the generated encode/decode functions produce
 * correct byte-level output: encode a struct value, serialize to bytes,
 * decode the bytes back, and assert the decoded field values match.
 *
 * Coverage:
 *   - Simple struct with primitive fields (UInt32, UInt64, Bool, Text)
 *   - Struct with enum field
 *   - Struct with union (named and unnamed; discriminant roundtrips)
 *   - Struct with list fields (List(UInt32), List(Text))
 *   - Nested struct (struct containing another struct)
 *   - Empty/default values
 */

import { generateTypescriptFiles } from "../tools/capnpc-deno/emitter.ts";
import type { CodeGeneratorRequestModel } from "../tools/capnpc-deno/model.ts";
import { parseCodeGeneratorRequest } from "../tools/capnpc-deno/request_parser.ts";
import { assert, assertEquals } from "./test_utils.ts";

// ---------------------------------------------------------------------------
// Base64-encoded CodeGeneratorRequests compiled from fixture schemas
// ---------------------------------------------------------------------------

// person_codegen.capnp: Person { id: UInt64, name: Text, age: UInt32, favorite: Color, tags: List(Text) }
const PERSON_REQUEST_BASE64 =
  "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";

// union_group_codegen.capnp: Example { id: UInt64, mode :union { none, name, count, cfg :group { enabled, label } } }
const UNION_GROUP_REQUEST_BASE64 =
  "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";

// unnamed_union_codegen.capnp: Sample { id: UInt64, union { none, name, count }, after: Bool }
const UNNAMED_UNION_REQUEST_BASE64 =
  "AAAAALYAAAAAAAAAAAAEABEAAADHAAAAVQIAACcAAAAEAAAAAQAAAOkBAABHAAAAAQADAAAAAAAIAAAABgAGAMH+Xl35ltiWLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEUAAACaAQAAXQAAABcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFzdy/BhTOXYMwAAAAEAAgDB/l5d+ZbYlgEABwAAAAMABAAAAAAAAAAWAAAAlgAAAEEAAADSAQAAXQAAAAcAAAAAAAAAAAAAAFkAAAAfAQAAAAAAAAAAAAAAAAAAAAAAAHRlc3RzL2ZpeHR1cmVzL3NjaGVtYXMvdW5uYW1lZF91bmlvbl9jb2RlZ2VuLmNhcG5wAAAAAAAABAAAAAEAAQBc3cvwYUzl2AEAAAA6AAAAU2FtcGxlAAB0ZXN0cy9maXh0dXJlcy9zY2hlbWFzL3VubmFtZWRfdW5pb25fY29kZWdlbi5jYXBucDpTYW1wbGUAAAAAAAAAAAAAAAEAAQAUAAAAAwAEAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAH0AAAAaAAAAAAAAAAAAAAB4AAAAAwABAIQAAAACAAEAAQD//wAAAAAAAAEAAQAAAAAAAAAAAAAAgQAAACoAAAAAAAAAAAAAAHwAAAADAAEAiAAAAAIAAQACAP7/AAAAAAAAAQACAAAAAAAAAAAAAACFAAAAKgAAAAAAAAAAAAAAgAAAAAMAAQCMAAAAAgABAAMA/f8DAAAAAAABAAMAAAAAAAAAAAAAAIkAAAAyAAAAAAAAAAAAAACEAAAAAwABAJAAAAACAAEABAAAAFAAAAAAAAEABAAAAAAAAAAAAAAAjQAAADIAAAAAAAAAAAAAAIgAAAADAAEAlAAAAAIAAQBpZAAAAAAAAAkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAbm9uZQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG5hbWUAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABjb3VudAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYWZ0ZXIAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAACAAIAXN3L8GFM5dgWAAAAlgAAAAAAAAAAAAAAEQAAAH8AAADB/l5d+ZbYlgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQAAAABAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAEAAwDB/l5d+ZbYlgkAAACaAQAAIQAAAAcAAAAgAAAAAAABAHRlc3RzL2ZpeHR1cmVzL3NjaGVtYXMvdW5uYW1lZF91bmlvbl9jb2RlZ2VuLmNhcG5wAAAAAAAAAAAAAAEAAQABAAAAfwAAABQAAAADAAAALwAAADUAAAD/AwAAAAAAAAAAAAAAAAAATwAAAFMAAAD2AwAAAAAAAAAAAAAAAAAAYgAAAGYAAAACBAAAAAAAAAAAAAAAAAAAdgAAAHwAAAD+AwAAAAAAAAAAAAAAAAAAjwAAAJMAAAD3AwAAAAAAAAAAAAAAAAAA";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

const CODEGEN_RUNTIME_URL = new URL(
  "../src/codegen_runtime.ts",
  import.meta.url,
).href;

async function importGeneratedModule(
  source: string,
): Promise<Record<string, unknown>> {
  const patched = source.replaceAll(
    `"@nullstyle/capnp/codegen_runtime"`,
    `"${CODEGEN_RUNTIME_URL}"`,
  );
  const url = `data:application/typescript;base64,${btoa(patched)}`;
  return await import(url);
}

function fileByPath(
  files: Array<{ path: string; contents: string }>,
  path: string,
): { path: string; contents: string } {
  const file = files.find((candidate) => candidate.path === path);
  assert(file !== undefined, `expected generated file: ${path}`);
  return file;
}

type Codec = {
  encode(value: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
};

// ---------------------------------------------------------------------------
// Synthetic CodeGeneratorRequestModel builders for schemas not in fixtures
// ---------------------------------------------------------------------------

/**
 * Builds a synthetic request for a struct with nested struct and List(UInt32):
 *
 *   struct Inner {
 *     x @0 :UInt32;
 *     y @1 :UInt32;
 *   }
 *
 *   struct Outer {
 *     label @0 :Text;
 *     inner @1 :Inner;
 *     scores @2 :List(UInt32);
 *   }
 */
function makeNestedStructRequest(): CodeGeneratorRequestModel {
  const fileId = 0xaaa0n;
  const innerId = 0xaaa1n;
  const outerId = 0xaaa2n;
  const prefix = "schema/nested.capnp:";
  return {
    nodes: [
      {
        id: fileId,
        displayName: "schema/nested.capnp",
        displayNamePrefixLength: 0,
        scopeId: 0n,
        nestedNodes: [
          { name: "Inner", id: innerId },
          { name: "Outer", id: outerId },
        ],
        kind: "file",
      },
      {
        id: innerId,
        displayName: `${prefix}Inner`,
        displayNamePrefixLength: prefix.length,
        scopeId: fileId,
        nestedNodes: [],
        kind: "struct",
        structNode: {
          dataWordCount: 1,
          pointerCount: 0,
          isGroup: false,
          discriminantCount: 0,
          discriminantOffset: 0,
          fields: [
            {
              name: "x",
              codeOrder: 0,
              discriminantValue: 0xffff,
              slot: { offset: 0, type: { kind: "uint32" } },
            },
            {
              name: "y",
              codeOrder: 1,
              discriminantValue: 0xffff,
              slot: { offset: 1, type: { kind: "uint32" } },
            },
          ],
        },
      },
      {
        id: outerId,
        displayName: `${prefix}Outer`,
        displayNamePrefixLength: prefix.length,
        scopeId: fileId,
        nestedNodes: [],
        kind: "struct",
        structNode: {
          dataWordCount: 0,
          pointerCount: 3,
          isGroup: false,
          discriminantCount: 0,
          discriminantOffset: 0,
          fields: [
            {
              name: "label",
              codeOrder: 0,
              discriminantValue: 0xffff,
              slot: { offset: 0, type: { kind: "text" } },
            },
            {
              name: "inner",
              codeOrder: 1,
              discriminantValue: 0xffff,
              slot: {
                offset: 1,
                type: { kind: "struct", typeId: innerId },
              },
            },
            {
              name: "scores",
              codeOrder: 2,
              discriminantValue: 0xffff,
              slot: {
                offset: 2,
                type: { kind: "list", elementType: { kind: "uint32" } },
              },
            },
          ],
        },
      },
    ],
    requestedFiles: [
      { id: fileId, filename: "schema/nested.capnp", imports: [] },
    ],
  };
}

/**
 * Builds a synthetic request for a struct with multiple primitive types:
 *
 *   struct Primitives {
 *     b @0 :Bool;
 *     u8 @1 :UInt8;
 *     u16 @2 :UInt16;
 *     u32 @3 :UInt32;
 *     u64 @4 :UInt64;
 *     i8 @5 :Int8;
 *     i16 @6 :Int16;
 *     i32 @7 :Int32;
 *     i64 @8 :Int64;
 *     f32 @9 :Float32;
 *     f64 @10 :Float64;
 *     txt @11 :Text;
 *   }
 */
function makePrimitivesRequest(): CodeGeneratorRequestModel {
  const fileId = 0xbbb0n;
  const structId = 0xbbb1n;
  const prefix = "schema/prims.capnp:";
  return {
    nodes: [
      {
        id: fileId,
        displayName: "schema/prims.capnp",
        displayNamePrefixLength: 0,
        scopeId: 0n,
        nestedNodes: [{ name: "Primitives", id: structId }],
        kind: "file",
      },
      {
        id: structId,
        displayName: `${prefix}Primitives`,
        displayNamePrefixLength: prefix.length,
        scopeId: fileId,
        nestedNodes: [],
        kind: "struct",
        structNode: {
          // Layout (6 data words = 48 bytes, 1 pointer):
          //   word 0 (bytes 0-7):   bool@bit0, u8@byte1, u16@bytes2-3, u32@bytes4-7
          //   word 1 (bytes 8-15):  u64@bytes8-15
          //   word 2 (bytes 16-23): i8@byte16, i16@bytes18-19, i32@bytes20-23
          //   word 3 (bytes 24-31): i64@bytes24-31
          //   word 4 (bytes 32-39): f32@bytes32-35
          //   word 5 (bytes 40-47): f64@bytes40-47
          dataWordCount: 6,
          pointerCount: 1,
          isGroup: false,
          discriminantCount: 0,
          discriminantOffset: 0,
          fields: [
            {
              name: "b",
              codeOrder: 0,
              discriminantValue: 0xffff,
              slot: { offset: 0, type: { kind: "bool" } },
            },
            {
              name: "u8",
              codeOrder: 1,
              discriminantValue: 0xffff,
              slot: { offset: 1, type: { kind: "uint8" } },
            },
            {
              name: "u16",
              codeOrder: 2,
              discriminantValue: 0xffff,
              slot: { offset: 1, type: { kind: "uint16" } },
            },
            {
              name: "u32",
              codeOrder: 3,
              discriminantValue: 0xffff,
              slot: { offset: 1, type: { kind: "uint32" } },
            },
            {
              name: "u64",
              codeOrder: 4,
              discriminantValue: 0xffff,
              slot: { offset: 1, type: { kind: "uint64" } },
            },
            {
              name: "i8",
              codeOrder: 5,
              discriminantValue: 0xffff,
              slot: { offset: 16, type: { kind: "int8" } },
            },
            {
              name: "i16",
              codeOrder: 6,
              discriminantValue: 0xffff,
              slot: { offset: 9, type: { kind: "int16" } },
            },
            {
              name: "i32",
              codeOrder: 7,
              discriminantValue: 0xffff,
              slot: { offset: 5, type: { kind: "int32" } },
            },
            {
              name: "i64",
              codeOrder: 8,
              discriminantValue: 0xffff,
              slot: { offset: 3, type: { kind: "int64" } },
            },
            {
              name: "f32",
              codeOrder: 9,
              discriminantValue: 0xffff,
              slot: { offset: 8, type: { kind: "float32" } },
            },
            {
              name: "f64",
              codeOrder: 10,
              discriminantValue: 0xffff,
              slot: { offset: 5, type: { kind: "float64" } },
            },
            {
              name: "txt",
              codeOrder: 11,
              discriminantValue: 0xffff,
              slot: { offset: 0, type: { kind: "text" } },
            },
          ],
        },
      },
    ],
    requestedFiles: [
      { id: fileId, filename: "schema/prims.capnp", imports: [] },
    ],
  };
}

/**
 * Builds a synthetic request for a struct with various list types:
 *
 *   struct ListHost {
 *     bools @0 :List(Bool);
 *     u32s @1 :List(UInt32);
 *     u64s @2 :List(UInt64);
 *     texts @3 :List(Text);
 *   }
 */
function makeListsRequest(): CodeGeneratorRequestModel {
  const fileId = 0xccc0n;
  const structId = 0xccc1n;
  const prefix = "schema/lists.capnp:";
  return {
    nodes: [
      {
        id: fileId,
        displayName: "schema/lists.capnp",
        displayNamePrefixLength: 0,
        scopeId: 0n,
        nestedNodes: [{ name: "ListHost", id: structId }],
        kind: "file",
      },
      {
        id: structId,
        displayName: `${prefix}ListHost`,
        displayNamePrefixLength: prefix.length,
        scopeId: fileId,
        nestedNodes: [],
        kind: "struct",
        structNode: {
          dataWordCount: 0,
          pointerCount: 4,
          isGroup: false,
          discriminantCount: 0,
          discriminantOffset: 0,
          fields: [
            {
              name: "bools",
              codeOrder: 0,
              discriminantValue: 0xffff,
              slot: {
                offset: 0,
                type: { kind: "list", elementType: { kind: "bool" } },
              },
            },
            {
              name: "u32s",
              codeOrder: 1,
              discriminantValue: 0xffff,
              slot: {
                offset: 1,
                type: { kind: "list", elementType: { kind: "uint32" } },
              },
            },
            {
              name: "u64s",
              codeOrder: 2,
              discriminantValue: 0xffff,
              slot: {
                offset: 2,
                type: { kind: "list", elementType: { kind: "uint64" } },
              },
            },
            {
              name: "texts",
              codeOrder: 3,
              discriminantValue: 0xffff,
              slot: {
                offset: 3,
                type: { kind: "list", elementType: { kind: "text" } },
              },
            },
          ],
        },
      },
    ],
    requestedFiles: [
      { id: fileId, filename: "schema/lists.capnp", imports: [] },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests: simple struct with primitive fields (Person schema)
// ---------------------------------------------------------------------------

Deno.test("roundtrip: Person with all fields populated", async () => {
  const bytes = decodeBase64(PERSON_REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "person_codegen_capnp.ts").contents,
  );
  const codec = mod.PersonCodec as Codec | undefined;
  assert(codec !== undefined, "expected PersonCodec export");

  const value = {
    id: 123456789n,
    name: "Alice Wonderland",
    age: 30,
    favorite: "blue",
    tags: ["developer", "capnp", "deno"],
  };

  const encoded = codec.encode(value);
  assert(encoded.byteLength > 0, "expected non-empty encoded message");

  const decoded = codec.decode(encoded) as Record<string, unknown>;
  assertEquals(decoded.id, value.id);
  assertEquals(decoded.name, value.name);
  assertEquals(decoded.age, value.age);
  assertEquals(decoded.favorite, value.favorite);
  assertEquals(
    (decoded.tags as string[]).join(","),
    value.tags.join(","),
  );
});

Deno.test("roundtrip: Person with empty/default values", async () => {
  const bytes = decodeBase64(PERSON_REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "person_codegen_capnp.ts").contents,
  );
  const codec = mod.PersonCodec as Codec | undefined;
  assert(codec !== undefined, "expected PersonCodec export");

  // Encode with default/empty values
  const value = {
    id: 0n,
    name: "",
    age: 0,
    favorite: "red",
    tags: [] as string[],
  };

  const encoded = codec.encode(value);
  const decoded = codec.decode(encoded) as Record<string, unknown>;
  assertEquals(decoded.id, 0n);
  assertEquals(decoded.name, "");
  assertEquals(decoded.age, 0);
  assertEquals(decoded.favorite, "red");
  assertEquals((decoded.tags as string[]).length, 0);
});

Deno.test("roundtrip: Person with large UInt64 value", async () => {
  const bytes = decodeBase64(PERSON_REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "person_codegen_capnp.ts").contents,
  );
  const codec = mod.PersonCodec as Codec | undefined;
  assert(codec !== undefined, "expected PersonCodec export");

  const value = {
    id: 0xffff_ffff_ffff_ffffn,
    name: "Max",
    age: 4294967295,
    favorite: "green",
    tags: ["single"],
  };

  const encoded = codec.encode(value);
  const decoded = codec.decode(encoded) as Record<string, unknown>;
  assertEquals(decoded.id, 0xffff_ffff_ffff_ffffn);
  assertEquals(decoded.name, "Max");
  // UInt32 wraps: 4294967295 = 0xFFFFFFFF which is max UInt32
  assertEquals(decoded.age, 4294967295);
  assertEquals(decoded.favorite, "green");
  assertEquals((decoded.tags as string[]).join(","), "single");
});

Deno.test("roundtrip: Person decode from zero-length message returns defaults", async () => {
  const bytes = decodeBase64(PERSON_REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "person_codegen_capnp.ts").contents,
  );
  const codec = mod.PersonCodec as Codec | undefined;
  assert(codec !== undefined, "expected PersonCodec export");

  // Build a minimal message with a null root pointer (8-byte header + 8-byte zero pointer word)
  const nullMessage = new Uint8Array(16);
  const view = new DataView(nullMessage.buffer);
  view.setUint32(0, 0, true); // 1 segment
  view.setUint32(4, 1, true); // 1 word

  const decoded = codec.decode(nullMessage) as Record<string, unknown>;
  assertEquals(decoded.id, 0n);
  assertEquals(decoded.name, "");
  assertEquals(decoded.age, 0);
  assertEquals(decoded.favorite, "red"); // first enum value is default
  assertEquals((decoded.tags as string[]).length, 0);
});

// ---------------------------------------------------------------------------
// Tests: struct with named union (Example schema)
// ---------------------------------------------------------------------------

Deno.test("roundtrip: Example union variant 'none'", async () => {
  const bytes = decodeBase64(UNION_GROUP_REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "union_group_codegen_capnp.ts").contents,
  );
  const codec = mod.ExampleCodec as Codec | undefined;
  assert(codec !== undefined, "expected ExampleCodec export");

  const value = { id: 1n, mode: { which: "none" } };
  const decoded = codec.decode(codec.encode(value)) as Record<string, unknown>;
  assertEquals(decoded.id, 1n);
  const mode = decoded.mode as Record<string, unknown>;
  assertEquals(mode.which, "none");
});

Deno.test("roundtrip: Example union variant 'name'", async () => {
  const bytes = decodeBase64(UNION_GROUP_REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "union_group_codegen_capnp.ts").contents,
  );
  const codec = mod.ExampleCodec as Codec | undefined;
  assert(codec !== undefined, "expected ExampleCodec export");

  const value = { id: 42n, mode: { which: "name", name: "hello world" } };
  const decoded = codec.decode(codec.encode(value)) as Record<string, unknown>;
  assertEquals(decoded.id, 42n);
  const mode = decoded.mode as Record<string, unknown>;
  assertEquals(mode.which, "name");
  assertEquals(mode.name, "hello world");
});

Deno.test("roundtrip: Example union variant 'count'", async () => {
  const bytes = decodeBase64(UNION_GROUP_REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "union_group_codegen_capnp.ts").contents,
  );
  const codec = mod.ExampleCodec as Codec | undefined;
  assert(codec !== undefined, "expected ExampleCodec export");

  const value = { id: 7n, mode: { which: "count", count: 999 } };
  const decoded = codec.decode(codec.encode(value)) as Record<string, unknown>;
  assertEquals(decoded.id, 7n);
  const mode = decoded.mode as Record<string, unknown>;
  assertEquals(mode.which, "count");
  assertEquals(mode.count, 999);
});

Deno.test("roundtrip: Example union variant 'cfg' (group)", async () => {
  const bytes = decodeBase64(UNION_GROUP_REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "union_group_codegen_capnp.ts").contents,
  );
  const codec = mod.ExampleCodec as Codec | undefined;
  assert(codec !== undefined, "expected ExampleCodec export");

  const value = {
    id: 100n,
    mode: {
      which: "cfg",
      cfg: { enabled: true, label: "production" },
    },
  };
  const decoded = codec.decode(codec.encode(value)) as Record<string, unknown>;
  assertEquals(decoded.id, 100n);
  const mode = decoded.mode as Record<string, unknown>;
  assertEquals(mode.which, "cfg");
  const cfg = mode.cfg as Record<string, unknown>;
  assertEquals(cfg.enabled, true);
  assertEquals(cfg.label, "production");
});

Deno.test("roundtrip: Example union discriminant changes between encode/decode cycles", async () => {
  const bytes = decodeBase64(UNION_GROUP_REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "union_group_codegen_capnp.ts").contents,
  );
  const codec = mod.ExampleCodec as Codec | undefined;
  assert(codec !== undefined, "expected ExampleCodec export");

  // Encode as 'name', decode, re-encode as 'count', decode again
  const nameValue = { id: 50n, mode: { which: "name", name: "first" } };
  const nameDecoded = codec.decode(codec.encode(nameValue)) as Record<
    string,
    unknown
  >;
  assertEquals(
    (nameDecoded.mode as Record<string, unknown>).which,
    "name",
  );

  const countValue = { id: 50n, mode: { which: "count", count: 77 } };
  const countDecoded = codec.decode(codec.encode(countValue)) as Record<
    string,
    unknown
  >;
  assertEquals(
    (countDecoded.mode as Record<string, unknown>).which,
    "count",
  );
  assertEquals((countDecoded.mode as Record<string, unknown>).count, 77);
});

// ---------------------------------------------------------------------------
// Tests: struct with unnamed union (Sample schema)
// ---------------------------------------------------------------------------

Deno.test("roundtrip: Sample unnamed union variant 'none'", async () => {
  const bytes = decodeBase64(UNNAMED_UNION_REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "unnamed_union_codegen_capnp.ts").contents,
  );
  const codec = mod.SampleCodec as Codec | undefined;
  assert(codec !== undefined, "expected SampleCodec export");

  const value = { id: 1n, which: "none", after: false };
  const decoded = codec.decode(codec.encode(value)) as Record<string, unknown>;
  assertEquals(decoded.id, 1n);
  assertEquals(decoded.which, "none");
  assertEquals(decoded.after, false);
});

Deno.test("roundtrip: Sample unnamed union variant 'name'", async () => {
  const bytes = decodeBase64(UNNAMED_UNION_REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "unnamed_union_codegen_capnp.ts").contents,
  );
  const codec = mod.SampleCodec as Codec | undefined;
  assert(codec !== undefined, "expected SampleCodec export");

  const value = { id: 99n, which: "name", name: "Bob", after: true };
  const decoded = codec.decode(codec.encode(value)) as Record<string, unknown>;
  assertEquals(decoded.id, 99n);
  assertEquals(decoded.which, "name");
  assertEquals(decoded.name, "Bob");
  assertEquals(decoded.after, true);
});

Deno.test("roundtrip: Sample unnamed union variant 'count'", async () => {
  const bytes = decodeBase64(UNNAMED_UNION_REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "unnamed_union_codegen_capnp.ts").contents,
  );
  const codec = mod.SampleCodec as Codec | undefined;
  assert(codec !== undefined, "expected SampleCodec export");

  const value = { id: 5n, which: "count", count: 42, after: true };
  const decoded = codec.decode(codec.encode(value)) as Record<string, unknown>;
  assertEquals(decoded.id, 5n);
  assertEquals(decoded.which, "count");
  assertEquals(decoded.count, 42);
  assertEquals(decoded.after, true);
});

// ---------------------------------------------------------------------------
// Tests: nested struct and List(UInt32) (synthetic schema)
// ---------------------------------------------------------------------------

Deno.test("roundtrip: nested struct with Inner/Outer", async () => {
  const request = makeNestedStructRequest();
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "nested_capnp.ts").contents,
  );
  const codec = mod.OuterCodec as Codec | undefined;
  assert(codec !== undefined, "expected OuterCodec export");

  const value = {
    label: "parent",
    inner: { x: 10, y: 20 },
    scores: [100, 200, 300, 0, 4294967295],
  };

  const encoded = codec.encode(value);
  assert(encoded.byteLength > 0, "expected non-empty encoded message");

  const decoded = codec.decode(encoded) as Record<string, unknown>;
  assertEquals(decoded.label, "parent");
  const inner = decoded.inner as Record<string, unknown>;
  assertEquals(inner.x, 10);
  assertEquals(inner.y, 20);
  const scores = decoded.scores as number[];
  assertEquals(scores.length, 5);
  assertEquals(scores[0], 100);
  assertEquals(scores[1], 200);
  assertEquals(scores[2], 300);
  assertEquals(scores[3], 0);
  assertEquals(scores[4], 4294967295);
});

Deno.test("roundtrip: nested struct with empty inner and empty list", async () => {
  const request = makeNestedStructRequest();
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "nested_capnp.ts").contents,
  );
  const codec = mod.OuterCodec as Codec | undefined;
  assert(codec !== undefined, "expected OuterCodec export");

  const value = {
    label: "",
    inner: { x: 0, y: 0 },
    scores: [] as number[],
  };

  const decoded = codec.decode(codec.encode(value)) as Record<string, unknown>;
  assertEquals(decoded.label, "");
  const inner = decoded.inner as Record<string, unknown>;
  assertEquals(inner.x, 0);
  assertEquals(inner.y, 0);
  assertEquals((decoded.scores as number[]).length, 0);
});

Deno.test("roundtrip: nested struct with null inner yields defaults", async () => {
  const request = makeNestedStructRequest();
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "nested_capnp.ts").contents,
  );
  const codec = mod.OuterCodec as Codec | undefined;
  assert(codec !== undefined, "expected OuterCodec export");

  // When inner is not provided, encode should write a null pointer and
  // decode should produce the default Inner struct
  const value = { label: "only-label" };
  const decoded = codec.decode(codec.encode(value)) as Record<string, unknown>;
  assertEquals(decoded.label, "only-label");
  const inner = decoded.inner as Record<string, unknown>;
  assertEquals(inner.x, 0);
  assertEquals(inner.y, 0);
  assertEquals((decoded.scores as number[]).length, 0);
});

// ---------------------------------------------------------------------------
// Tests: list types (synthetic schema)
// ---------------------------------------------------------------------------

Deno.test("roundtrip: List(Bool), List(UInt32), List(UInt64), List(Text)", async () => {
  const request = makeListsRequest();
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "lists_capnp.ts").contents,
  );
  const codec = mod.ListHostCodec as Codec | undefined;
  assert(codec !== undefined, "expected ListHostCodec export");

  const value = {
    bools: [true, false, true, true, false],
    u32s: [0, 1, 1000, 4294967295],
    u64s: [0n, 1n, 0xdeadbeefcafen],
    texts: ["hello", "world", "", "capnp"],
  };

  const encoded = codec.encode(value);
  assert(encoded.byteLength > 0, "expected non-empty encoded message");

  const decoded = codec.decode(encoded) as Record<string, unknown>;
  const bools = decoded.bools as boolean[];
  assertEquals(bools.length, 5);
  assertEquals(bools[0], true);
  assertEquals(bools[1], false);
  assertEquals(bools[2], true);
  assertEquals(bools[3], true);
  assertEquals(bools[4], false);

  const u32s = decoded.u32s as number[];
  assertEquals(u32s.length, 4);
  assertEquals(u32s[0], 0);
  assertEquals(u32s[1], 1);
  assertEquals(u32s[2], 1000);
  assertEquals(u32s[3], 4294967295);

  const u64s = decoded.u64s as bigint[];
  assertEquals(u64s.length, 3);
  assertEquals(u64s[0], 0n);
  assertEquals(u64s[1], 1n);
  assertEquals(u64s[2], 0xdeadbeefcafen);

  const texts = decoded.texts as string[];
  assertEquals(texts.length, 4);
  assertEquals(texts[0], "hello");
  assertEquals(texts[1], "world");
  assertEquals(texts[2], "");
  assertEquals(texts[3], "capnp");
});

Deno.test("roundtrip: all lists empty", async () => {
  const request = makeListsRequest();
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "lists_capnp.ts").contents,
  );
  const codec = mod.ListHostCodec as Codec | undefined;
  assert(codec !== undefined, "expected ListHostCodec export");

  const value = {
    bools: [] as boolean[],
    u32s: [] as number[],
    u64s: [] as bigint[],
    texts: [] as string[],
  };

  const decoded = codec.decode(codec.encode(value)) as Record<string, unknown>;
  assertEquals((decoded.bools as boolean[]).length, 0);
  assertEquals((decoded.u32s as number[]).length, 0);
  assertEquals((decoded.u64s as bigint[]).length, 0);
  assertEquals((decoded.texts as string[]).length, 0);
});

Deno.test("roundtrip: single-element lists", async () => {
  const request = makeListsRequest();
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "lists_capnp.ts").contents,
  );
  const codec = mod.ListHostCodec as Codec | undefined;
  assert(codec !== undefined, "expected ListHostCodec export");

  const value = {
    bools: [false],
    u32s: [42],
    u64s: [99n],
    texts: ["one"],
  };

  const decoded = codec.decode(codec.encode(value)) as Record<string, unknown>;
  assertEquals((decoded.bools as boolean[]).length, 1);
  assertEquals((decoded.bools as boolean[])[0], false);
  assertEquals((decoded.u32s as number[]).length, 1);
  assertEquals((decoded.u32s as number[])[0], 42);
  assertEquals((decoded.u64s as bigint[]).length, 1);
  assertEquals((decoded.u64s as bigint[])[0], 99n);
  assertEquals((decoded.texts as string[]).length, 1);
  assertEquals((decoded.texts as string[])[0], "one");
});

// ---------------------------------------------------------------------------
// Tests: comprehensive primitives (synthetic schema)
// ---------------------------------------------------------------------------

Deno.test("roundtrip: all primitive types", async () => {
  const request = makePrimitivesRequest();
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "prims_capnp.ts").contents,
  );
  const codec = mod.PrimitivesCodec as Codec | undefined;
  assert(codec !== undefined, "expected PrimitivesCodec export");

  const value = {
    b: true,
    u8: 255,
    u16: 65535,
    u32: 4294967295,
    u64: 0xdeadbeefn,
    i8: -128,
    i16: -32768,
    i32: -2147483648,
    i64: -9007199254740991n,
    f32: 3.140000104904175, // Float32 has limited precision
    f64: 3.141592653589793,
    txt: "hello primitives",
  };

  const encoded = codec.encode(value);
  assert(encoded.byteLength > 0, "expected non-empty encoded message");

  const decoded = codec.decode(encoded) as Record<string, unknown>;
  assertEquals(decoded.b, true);
  assertEquals(decoded.u8, 255);
  assertEquals(decoded.u16, 65535);
  assertEquals(decoded.u32, 4294967295);
  assertEquals(decoded.u64, 0xdeadbeefn);
  assertEquals(decoded.i8, -128);
  assertEquals(decoded.i16, -32768);
  assertEquals(decoded.i32, -2147483648);
  assertEquals(decoded.i64, -9007199254740991n);
  // Float32 precision: roundtrip value should match when re-read
  const f32View = new DataView(new ArrayBuffer(4));
  f32View.setFloat32(0, value.f32, true);
  const expectedF32 = f32View.getFloat32(0, true);
  assertEquals(decoded.f32, expectedF32);
  assertEquals(decoded.f64, 3.141592653589793);
  assertEquals(decoded.txt, "hello primitives");
});

Deno.test("roundtrip: primitives with zero/default values", async () => {
  const request = makePrimitivesRequest();
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "prims_capnp.ts").contents,
  );
  const codec = mod.PrimitivesCodec as Codec | undefined;
  assert(codec !== undefined, "expected PrimitivesCodec export");

  const value = {
    b: false,
    u8: 0,
    u16: 0,
    u32: 0,
    u64: 0n,
    i8: 0,
    i16: 0,
    i32: 0,
    i64: 0n,
    f32: 0,
    f64: 0,
    txt: "",
  };

  const decoded = codec.decode(codec.encode(value)) as Record<string, unknown>;
  assertEquals(decoded.b, false);
  assertEquals(decoded.u8, 0);
  assertEquals(decoded.u16, 0);
  assertEquals(decoded.u32, 0);
  assertEquals(decoded.u64, 0n);
  assertEquals(decoded.i8, 0);
  assertEquals(decoded.i16, 0);
  assertEquals(decoded.i32, 0);
  assertEquals(decoded.i64, 0n);
  assertEquals(decoded.f32, 0);
  assertEquals(decoded.f64, 0);
  assertEquals(decoded.txt, "");
});

// ---------------------------------------------------------------------------
// Tests: re-encode decoded output (double roundtrip)
// ---------------------------------------------------------------------------

Deno.test("roundtrip: double encode/decode cycle for Person", async () => {
  const bytes = decodeBase64(PERSON_REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "person_codegen_capnp.ts").contents,
  );
  const codec = mod.PersonCodec as Codec | undefined;
  assert(codec !== undefined, "expected PersonCodec export");

  const original = {
    id: 42n,
    name: "Roundtrip",
    age: 25,
    favorite: "green",
    tags: ["a", "b", "c"],
  };

  // First roundtrip
  const decoded1 = codec.decode(codec.encode(original)) as Record<
    string,
    unknown
  >;

  // Second roundtrip: re-encode the decoded output
  const decoded2 = codec.decode(codec.encode(decoded1)) as Record<
    string,
    unknown
  >;

  assertEquals(decoded2.id, original.id);
  assertEquals(decoded2.name, original.name);
  assertEquals(decoded2.age, original.age);
  assertEquals(decoded2.favorite, original.favorite);
  assertEquals(
    (decoded2.tags as string[]).join(","),
    original.tags.join(","),
  );
});

Deno.test("roundtrip: double encode/decode cycle for Example union", async () => {
  const bytes = decodeBase64(UNION_GROUP_REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "union_group_codegen_capnp.ts").contents,
  );
  const codec = mod.ExampleCodec as Codec | undefined;
  assert(codec !== undefined, "expected ExampleCodec export");

  const original = {
    id: 10n,
    mode: {
      which: "cfg",
      cfg: { enabled: true, label: "test" },
    },
  };

  const decoded1 = codec.decode(codec.encode(original)) as Record<
    string,
    unknown
  >;
  const decoded2 = codec.decode(codec.encode(decoded1)) as Record<
    string,
    unknown
  >;

  assertEquals(decoded2.id, original.id);
  const mode = decoded2.mode as Record<string, unknown>;
  assertEquals(mode.which, "cfg");
  const cfg = mode.cfg as Record<string, unknown>;
  assertEquals(cfg.enabled, true);
  assertEquals(cfg.label, "test");
});

Deno.test("roundtrip: double encode/decode cycle for nested struct", async () => {
  const request = makeNestedStructRequest();
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "nested_capnp.ts").contents,
  );
  const codec = mod.OuterCodec as Codec | undefined;
  assert(codec !== undefined, "expected OuterCodec export");

  const original = {
    label: "outer",
    inner: { x: 777, y: 888 },
    scores: [1, 2, 3],
  };

  const decoded1 = codec.decode(codec.encode(original)) as Record<
    string,
    unknown
  >;
  const decoded2 = codec.decode(codec.encode(decoded1)) as Record<
    string,
    unknown
  >;

  assertEquals(decoded2.label, "outer");
  const inner = decoded2.inner as Record<string, unknown>;
  assertEquals(inner.x, 777);
  assertEquals(inner.y, 888);
  const scores = decoded2.scores as number[];
  assertEquals(scores.length, 3);
  assertEquals(scores[0], 1);
  assertEquals(scores[1], 2);
  assertEquals(scores[2], 3);
});

// ---------------------------------------------------------------------------
// Tests: Text with special characters
// ---------------------------------------------------------------------------

Deno.test("roundtrip: Text with unicode and special characters", async () => {
  const bytes = decodeBase64(PERSON_REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "person_codegen_capnp.ts").contents,
  );
  const codec = mod.PersonCodec as Codec | undefined;
  assert(codec !== undefined, "expected PersonCodec export");

  const value = {
    id: 1n,
    name: "Hello \u00e9\u00e8\u00ea \u00fc\u00f6\u00e4 \u2603 \u2764",
    age: 1,
    favorite: "red",
    tags: ["\u00e9", "\u2603", "normal", ""],
  };

  const decoded = codec.decode(codec.encode(value)) as Record<string, unknown>;
  assertEquals(decoded.name, value.name);
  const tags = decoded.tags as string[];
  assertEquals(tags.length, 4);
  assertEquals(tags[0], "\u00e9");
  assertEquals(tags[1], "\u2603");
  assertEquals(tags[2], "normal");
  assertEquals(tags[3], "");
});

// ---------------------------------------------------------------------------
// Tests: List of structs via nested schema
// ---------------------------------------------------------------------------

Deno.test("roundtrip: nested Inner codec independently", async () => {
  const request = makeNestedStructRequest();
  const generated = generateTypescriptFiles(request);
  const mod = await importGeneratedModule(
    fileByPath(generated, "nested_capnp.ts").contents,
  );
  const codec = mod.InnerCodec as Codec | undefined;
  assert(codec !== undefined, "expected InnerCodec export");

  const value = { x: 42, y: 99 };
  const decoded = codec.decode(codec.encode(value)) as Record<string, unknown>;
  assertEquals(decoded.x, 42);
  assertEquals(decoded.y, 99);
});
