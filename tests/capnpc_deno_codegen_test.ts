import {
  generateTypescriptFiles,
  renderedFieldNamesForTest,
  renderSingleFileForTest,
} from "../tools/capnpc-deno/emitter.ts";
import type { CodeGeneratorRequestModel } from "../tools/capnpc-deno/model.ts";
import { parseCodeGeneratorRequest } from "../tools/capnpc-deno/request_parser.ts";
import { assert, assertEquals, assertThrows } from "./test_utils.ts";

const REQUEST_BASE64 =
  "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";
const WORD_BYTES = 8;
const MASK_30 = 0x3fff_ffffn;

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function fileByPath(
  files: Array<{ path: string; contents: string }>,
  path: string,
): { path: string; contents: string } {
  const file = files.find((candidate) => candidate.path === path);
  assert(file !== undefined, `expected generated file: ${path}`);
  return file;
}

function splitSegments(message: Uint8Array): Uint8Array[] {
  const view = new DataView(
    message.buffer,
    message.byteOffset,
    message.byteLength,
  );
  const segmentCount = view.getUint32(0, true) + 1;
  const headerWords = 1 + segmentCount + (segmentCount % 2 === 0 ? 1 : 0);
  const headerBytes = headerWords * 4;
  const segments: Uint8Array[] = [];
  let cursor = headerBytes;
  for (let i = 0; i < segmentCount; i += 1) {
    const sizeWords = view.getUint32(4 + i * 4, true);
    const sizeBytes = sizeWords * WORD_BYTES;
    segments.push(message.subarray(cursor, cursor + sizeBytes));
    cursor += sizeBytes;
  }
  return segments;
}

function buildMessage(segments: Uint8Array[]): Uint8Array {
  const segmentCount = segments.length;
  const headerWords = 1 + segmentCount + (segmentCount % 2 === 0 ? 1 : 0);
  const headerBytes = headerWords * 4;
  const bodyBytes = segments.reduce(
    (sum, segment) => sum + segment.byteLength,
    0,
  );
  const out = new Uint8Array(headerBytes + bodyBytes);
  const view = new DataView(out.buffer);
  view.setUint32(0, segmentCount - 1, true);
  for (let i = 0; i < segmentCount; i += 1) {
    view.setUint32(4 + i * 4, segments[i].byteLength / WORD_BYTES, true);
  }
  let cursor = headerBytes;
  for (const segment of segments) {
    out.set(segment, cursor);
    cursor += segment.byteLength;
  }
  return out;
}

function getWord(segment: Uint8Array, wordIndex: number): bigint {
  return new DataView(segment.buffer, segment.byteOffset, segment.byteLength)
    .getBigUint64(
      wordIndex * WORD_BYTES,
      true,
    );
}

function setWord(segment: Uint8Array, wordIndex: number, value: bigint): void {
  new DataView(segment.buffer, segment.byteOffset, segment.byteLength)
    .setBigUint64(
      wordIndex * WORD_BYTES,
      value,
      true,
    );
}

function signed30(raw: bigint): number {
  const value = Number(raw & MASK_30);
  return (value & (1 << 29)) !== 0 ? value - (1 << 30) : value;
}

function farPointerWord(
  targetSegmentId: number,
  landingPadWord: number,
): bigint {
  return 0x2n |
    (BigInt(landingPadWord & 0x1fff_ffff) << 3n) |
    (BigInt(targetSegmentId >>> 0) << 32n);
}

function listPointerWord(elementSize: number, elementCount: number): bigint {
  return 0x1n |
    (BigInt(elementSize & 0x7) << 32n) |
    (BigInt(elementCount & 0x1fff_ffff) << 35n);
}

function flatListWords(elementSize: number, elementCount: number): number {
  switch (elementSize) {
    case 0:
      return 0;
    case 1:
      return Math.ceil(elementCount / 64);
    case 2:
      return Math.ceil(elementCount / 8);
    case 3:
      return Math.ceil(elementCount / 4);
    case 4:
      return Math.ceil(elementCount / 2);
    case 5:
      return elementCount;
    case 6:
      return elementCount;
    default:
      throw new Error(`unsupported flat list element size: ${elementSize}`);
  }
}

function toSingleFarRoot(message: Uint8Array): Uint8Array {
  const segments = splitSegments(message);
  assertEquals(segments.length, 1);
  const segment0 = new Uint8Array(WORD_BYTES);
  const segment1 = new Uint8Array(segments[0]);
  setWord(segment0, 0, farPointerWord(1, 0));
  return buildMessage([segment0, segment1]);
}

function rootStructPointerWord(
  message: Uint8Array,
  pointerOffset: number,
): number {
  const segments = splitSegments(message);
  assertEquals(segments.length, 1);
  const segment = segments[0];
  const root = getWord(segment, 0);
  assertEquals(Number(root & 0x3n), 0);

  const offsetWords = signed30((root >> 2n) & MASK_30);
  const dataWordCount = Number((root >> 32n) & 0xffffn);
  const pointerCount = Number((root >> 48n) & 0xffffn);
  assert(
    pointerOffset >= 0 && pointerOffset < pointerCount,
    `pointer offset out of bounds: ${pointerOffset}`,
  );

  const rootStart = 1 + offsetWords;
  return rootStart + dataWordCount + pointerOffset;
}

function toSingleFarListPointer(
  message: Uint8Array,
  pointerWordIndex: number,
): Uint8Array {
  const segments = splitSegments(message);
  assertEquals(segments.length, 1);
  const segment0 = new Uint8Array(segments[0]);
  const pointer = getWord(segment0, pointerWordIndex);
  const kind = Number(pointer & 0x3n);
  assertEquals(kind, 1);

  const offsetWords = signed30((pointer >> 2n) & MASK_30);
  const elementSize = Number((pointer >> 32n) & 0x7n);
  const elementCount = Number((pointer >> 35n) & 0x1fff_ffffn);
  assert(elementSize !== 7, "inline composite list pointers are not supported");

  const targetWord = pointerWordIndex + 1 + offsetWords;
  const payloadWords = flatListWords(elementSize, elementCount);
  const segment1 = new Uint8Array((1 + payloadWords) * WORD_BYTES);
  setWord(segment1, 0, listPointerWord(elementSize, elementCount));
  segment1.set(
    segment0.subarray(
      targetWord * WORD_BYTES,
      (targetWord + payloadWords) * WORD_BYTES,
    ),
    WORD_BYTES,
  );

  setWord(segment0, pointerWordIndex, farPointerWord(1, 0));
  return buildMessage([segment0, segment1]);
}

Deno.test("capnpc-deno scaffolding parses CodeGeneratorRequest basics", () => {
  const bytes = decodeBase64(REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);

  assertEquals(request.requestedFiles.length, 1);
  assertEquals(
    request.requestedFiles[0].filename,
    "tests/fixtures/schemas/person_codegen.capnp",
  );

  assert(request.nodes.length > 0, "expected non-empty node list");
  const fileNode = request.nodes.find((node) =>
    node.id === request.requestedFiles[0].id
  );
  assert(fileNode !== undefined, "expected file node to exist");
  assertEquals(fileNode.kind, "file");

  const personNested = fileNode.nestedNodes.find((nested) =>
    nested.name === "Person"
  );
  const colorNested = fileNode.nestedNodes.find((nested) =>
    nested.name === "Color"
  );
  assert(personNested !== undefined, "expected Person nested node");
  assert(colorNested !== undefined, "expected Color nested node");

  const personNode = request.nodes.find((node) => node.id === personNested.id);
  assert(personNode !== undefined, "expected Person node");
  assertEquals(personNode.kind, "struct");
  assert(
    personNode.structNode !== undefined,
    "expected Person struct metadata",
  );
  assertEquals(personNode.structNode.dataWordCount, 2);
  assertEquals(personNode.structNode.pointerCount, 2);
  assertEquals(
    renderedFieldNamesForTest(personNode.structNode.fields).join(","),
    "id,name,age,favorite,tags",
  );
});

Deno.test("capnpc-deno emits binary codec runtime and schema types", () => {
  const bytes = decodeBase64(REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);
  const generated = generateTypescriptFiles(request);

  assertEquals(generated.length, 3);
  const capnp = fileByPath(generated, "person_codegen_capnp.ts");
  const rpc = fileByPath(generated, "person_codegen_rpc.ts");
  const meta = fileByPath(generated, "person_codegen_meta.ts");
  assert(
    capnp.contents.includes("export interface StructCodec<T>"),
    "expected StructCodec interface in generated output",
  );
  assert(
    capnp.contents.includes("function encodeStructMessage"),
    "expected binary encode runtime in generated output",
  );
  assert(
    capnp.contents.includes("function decodeStructMessage"),
    "expected binary decode runtime in generated output",
  );
  assert(
    capnp.contents.includes(
      "export const PersonCodec: StructCodec<Person>",
    ),
    "expected Person codec export",
  );
  assert(
    rpc.contents.includes("export {};"),
    "expected empty rpc module when schema has no interfaces",
  );
  assert(
    meta.contents.includes("export const schemaFileId ="),
    "expected meta module file id constant",
  );
});

async function importGeneratedModule(
  source: string,
): Promise<Record<string, unknown>> {
  const url = `data:application/typescript;base64,${btoa(source)}`;
  return await import(url);
}

Deno.test("capnpc-deno generated binary codec roundtrips Person", async () => {
  const bytes = decodeBase64(REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);
  const generated = generateTypescriptFiles(request);
  assertEquals(generated.length, 3);

  const mod = await importGeneratedModule(
    fileByPath(generated, "person_codegen_capnp.ts").contents,
  );
  const codec = mod.PersonCodec as
    | { encode(value: unknown): Uint8Array; decode(bytes: Uint8Array): unknown }
    | undefined;
  assert(codec !== undefined, "expected PersonCodec to be exported");

  const value = {
    id: 42n,
    name: "Alice",
    age: 33,
    favorite: "green",
    tags: ["ops", "capnp"],
  };

  const encoded = codec.encode(value);
  assert(encoded.byteLength > 0, "expected non-empty encoded message");

  const decoded = codec.decode(encoded) as Record<string, unknown>;
  assertEquals(decoded.id, value.id);
  assertEquals(decoded.name, value.name);
  assertEquals(decoded.age, value.age);
  assertEquals(decoded.favorite, value.favorite);
  const decodedTags = decoded.tags as string[];
  assertEquals(decodedTags.join(","), value.tags.join(","));
});

Deno.test("capnpc-deno generated runtime decodes single-far root pointer", async () => {
  const bytes = decodeBase64(REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);
  const generated = generateTypescriptFiles(request);
  assertEquals(generated.length, 3);

  const mod = await importGeneratedModule(
    fileByPath(generated, "person_codegen_capnp.ts").contents,
  );
  const codec = mod.PersonCodec as
    | { encode(value: unknown): Uint8Array; decode(bytes: Uint8Array): unknown }
    | undefined;
  assert(codec !== undefined, "expected PersonCodec to be exported");

  const value = {
    id: 77n,
    name: "FarRoot",
    age: 12,
    favorite: "red",
    tags: ["one", "two"],
  };
  const transformed = toSingleFarRoot(codec.encode(value));
  const decoded = codec.decode(transformed) as Record<string, unknown>;
  assertEquals(decoded.id, value.id);
  assertEquals(decoded.name, value.name);
  assertEquals(decoded.age, value.age);
  assertEquals(decoded.favorite, value.favorite);
  assertEquals((decoded.tags as string[]).join(","), value.tags.join(","));
});

Deno.test("capnpc-deno generated runtime decodes far pointer text fields", async () => {
  const bytes = decodeBase64(REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);
  const generated = generateTypescriptFiles(request);
  assertEquals(generated.length, 3);

  const mod = await importGeneratedModule(
    fileByPath(generated, "person_codegen_capnp.ts").contents,
  );
  const codec = mod.PersonCodec as
    | { encode(value: unknown): Uint8Array; decode(bytes: Uint8Array): unknown }
    | undefined;
  assert(codec !== undefined, "expected PersonCodec to be exported");

  const value = {
    id: 88n,
    name: "FarName",
    age: 41,
    favorite: "blue",
    tags: ["pointer", "list"],
  };
  const encoded = codec.encode(value);
  const namePointerWord = rootStructPointerWord(encoded, 0);
  const transformed = toSingleFarListPointer(encoded, namePointerWord);
  const decoded = codec.decode(transformed) as Record<string, unknown>;
  assertEquals(decoded.id, value.id);
  assertEquals(decoded.name, value.name);
  assertEquals(decoded.age, value.age);
  assertEquals(decoded.favorite, value.favorite);
  assertEquals((decoded.tags as string[]).join(","), value.tags.join(","));
});

function makeRpcMethodCollisionRequest(): CodeGeneratorRequestModel {
  const fileId = 0x100n;
  const interfaceId = 0x101n;
  const prefix = "schema/fallback.capnp:";
  return {
    nodes: [
      {
        id: fileId,
        displayName: "schema/fallback.capnp",
        displayNamePrefixLength: 0,
        scopeId: 0n,
        nestedNodes: [{ name: "Svc", id: interfaceId }],
        kind: "file",
      },
      {
        id: interfaceId,
        displayName: `${prefix}Svc`,
        displayNamePrefixLength: prefix.length,
        scopeId: fileId,
        nestedNodes: [],
        kind: "interface",
        interfaceNode: {
          methods: [
            {
              name: "do thing",
              codeOrder: 0,
              paramStructTypeId: 0x200n,
              resultStructTypeId: 0x201n,
            },
            {
              name: "do-thing",
              codeOrder: 1,
              paramStructTypeId: 0x202n,
              resultStructTypeId: 0x203n,
            },
            {
              name: "123start",
              codeOrder: 2,
              paramStructTypeId: 0x204n,
              resultStructTypeId: 0x205n,
            },
          ],
        },
      },
      {
        id: 0x200n,
        displayName: `${prefix}Svc.DoThing$Params`,
        displayNamePrefixLength: prefix.length,
        scopeId: interfaceId,
        nestedNodes: [],
        kind: "struct",
        structNode: {
          dataWordCount: 0,
          pointerCount: 0,
          isGroup: false,
          discriminantCount: 0,
          discriminantOffset: 0,
          fields: [],
        },
      },
      {
        id: 0x201n,
        displayName: `${prefix}Svc.DoThing$Results`,
        displayNamePrefixLength: prefix.length,
        scopeId: interfaceId,
        nestedNodes: [],
        kind: "struct",
        structNode: {
          dataWordCount: 0,
          pointerCount: 0,
          isGroup: false,
          discriminantCount: 0,
          discriminantOffset: 0,
          fields: [],
        },
      },
      {
        id: 0x202n,
        displayName: `${prefix}Svc.DoThing2$Params`,
        displayNamePrefixLength: prefix.length,
        scopeId: interfaceId,
        nestedNodes: [],
        kind: "struct",
        structNode: {
          dataWordCount: 0,
          pointerCount: 0,
          isGroup: false,
          discriminantCount: 0,
          discriminantOffset: 0,
          fields: [],
        },
      },
      {
        id: 0x203n,
        displayName: `${prefix}Svc.DoThing2$Results`,
        displayNamePrefixLength: prefix.length,
        scopeId: interfaceId,
        nestedNodes: [],
        kind: "struct",
        structNode: {
          dataWordCount: 0,
          pointerCount: 0,
          isGroup: false,
          discriminantCount: 0,
          discriminantOffset: 0,
          fields: [],
        },
      },
      {
        id: 0x204n,
        displayName: `${prefix}Svc.123start$Params`,
        displayNamePrefixLength: prefix.length,
        scopeId: interfaceId,
        nestedNodes: [],
        kind: "struct",
        structNode: {
          dataWordCount: 0,
          pointerCount: 0,
          isGroup: false,
          discriminantCount: 0,
          discriminantOffset: 0,
          fields: [],
        },
      },
      {
        id: 0x205n,
        displayName: `${prefix}Svc.123start$Results`,
        displayNamePrefixLength: prefix.length,
        scopeId: interfaceId,
        nestedNodes: [],
        kind: "struct",
        structNode: {
          dataWordCount: 0,
          pointerCount: 0,
          isGroup: false,
          discriminantCount: 0,
          discriminantOffset: 0,
          fields: [],
        },
      },
    ],
    requestedFiles: [
      {
        id: fileId,
        filename: "schema/fallback.capnp",
        imports: [],
      },
    ],
  };
}

function makeMissingRpcStructRequest(): CodeGeneratorRequestModel {
  const fileId = 0x110n;
  const interfaceId = 0x111n;
  const prefix = "schema/fallback_missing.capnp:";
  return {
    nodes: [
      {
        id: fileId,
        displayName: "schema/fallback_missing.capnp",
        displayNamePrefixLength: 0,
        scopeId: 0n,
        nestedNodes: [{ name: "Svc", id: interfaceId }],
        kind: "file",
      },
      {
        id: interfaceId,
        displayName: `${prefix}Svc`,
        displayNamePrefixLength: prefix.length,
        scopeId: fileId,
        nestedNodes: [],
        kind: "interface",
        interfaceNode: {
          methods: [
            {
              name: "ping",
              codeOrder: 0,
              paramStructTypeId: 0x9990n,
              resultStructTypeId: 0x9991n,
            },
          ],
        },
      },
    ],
    requestedFiles: [
      {
        id: fileId,
        filename: "schema/fallback_missing.capnp",
        imports: [],
      },
    ],
  };
}

function makeMultiFileRequest(): CodeGeneratorRequestModel {
  return {
    nodes: [
      {
        id: 0x300n,
        displayName: "schema/a.capnp",
        displayNamePrefixLength: 0,
        scopeId: 0n,
        nestedNodes: [],
        kind: "file",
      },
      {
        id: 0x301n,
        displayName: "schema/b.capnp",
        displayNamePrefixLength: 0,
        scopeId: 0n,
        nestedNodes: [],
        kind: "file",
      },
    ],
    requestedFiles: [
      { id: 0x300n, filename: "schema/a.capnp", imports: [] },
      { id: 0x301n, filename: "schema/b.capnp", imports: [] },
    ],
  };
}

function makeMissingGroupStructRequest(): CodeGeneratorRequestModel {
  const fileId = 0x400n;
  const rootStructId = 0x401n;
  const prefix = "schema/group_missing.capnp:";
  return {
    nodes: [
      {
        id: fileId,
        displayName: "schema/group_missing.capnp",
        displayNamePrefixLength: 0,
        scopeId: 0n,
        nestedNodes: [{ name: "Root", id: rootStructId }],
        kind: "file",
      },
      {
        id: rootStructId,
        displayName: `${prefix}Root`,
        displayNamePrefixLength: prefix.length,
        scopeId: fileId,
        nestedNodes: [],
        kind: "struct",
        structNode: {
          dataWordCount: 0,
          pointerCount: 1,
          isGroup: false,
          discriminantCount: 0,
          discriminantOffset: 0,
          fields: [
            {
              name: "child",
              codeOrder: 0,
              discriminantValue: 0xffff,
              group: { typeId: 0x4ffn },
            },
          ],
        },
      },
    ],
    requestedFiles: [
      {
        id: fileId,
        filename: "schema/group_missing.capnp",
        imports: [],
      },
    ],
  };
}

Deno.test("capnpc-deno emitter handles rpc method name collisions", () => {
  const generated = generateTypescriptFiles(makeRpcMethodCollisionRequest());
  const rpc = fileByPath(generated, "fallback_rpc.ts");

  assert(
    rpc.contents.includes("doThing: 0,"),
    "expected first collided method name",
  );
  assert(
    rpc.contents.includes("doThing2: 1,"),
    "expected deterministic suffix for collided method names",
  );
  assert(
    rpc.contents.includes('"123start": 2,'),
    "expected quoted ordinal key for non-identifier method name",
  );
  assert(
    rpc.contents.includes('"123start"(params:'),
    "expected quoted client method signature for non-identifier method name",
  );
});

Deno.test("capnpc-deno emitter rejects rpc methods that reference unknown param/result structs", () => {
  assertThrows(
    () => generateTypescriptFiles(makeMissingRpcStructRequest()),
    /references unknown param struct id/,
  );
});

Deno.test("capnpc-deno emitter renderSingleFileForTest rejects multi-file requests", () => {
  assertThrows(
    () => renderSingleFileForTest(makeMultiFileRequest()),
    /expected exactly one generated capnp file, got 2/,
  );
});

Deno.test("capnpc-deno emitter rejects group fields that reference unknown local structs", () => {
  assertThrows(
    () => generateTypescriptFiles(makeMissingGroupStructRequest()),
    /references unknown local struct id/,
  );
});
