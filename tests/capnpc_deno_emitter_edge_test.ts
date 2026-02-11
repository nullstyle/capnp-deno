import { generateTypescriptFiles } from "../tools/capnpc-deno/emitter.ts";
import type { CodeGeneratorRequestModel } from "../tools/capnpc-deno/model.ts";
import { assert, assertEquals } from "./test_utils.ts";

const FIELD_NO_DISCRIMINANT = 0xffff;

function fileByPath(
  files: Array<{ path: string; contents: string }>,
  path: string,
): { path: string; contents: string } {
  const file = files.find((candidate) => candidate.path === path);
  assert(file !== undefined, `expected generated file: ${path}`);
  return file;
}

function makeEmitterEdgeRequest(): CodeGeneratorRequestModel {
  const fileId = 0x100n;
  const prefix = "schema/noext:";
  const dupA = 0x101n;
  const dupB = 0x102n;
  const generatedA = 0x103n;
  const generatedB = 0x104n;
  const prefixEq = 0x105n;
  const root = 0x106n;
  const svc = 0x107n;
  const svcBang = 0x108n;

  return {
    nodes: [
      {
        id: fileId,
        displayName: "schema/noext",
        displayNamePrefixLength: 0,
        scopeId: 0n,
        nestedNodes: [
          { name: "dup", id: dupA },
          { name: "dup!", id: dupB },
          { name: "bang", id: generatedA },
          { name: "qmark", id: generatedB },
          { name: "root", id: root },
          { name: "svc", id: svc },
          { name: "svc!", id: svcBang },
          { name: "prefixEq", id: prefixEq },
        ],
        kind: "file",
      },
      {
        id: dupA,
        displayName: `${prefix}dup`,
        displayNamePrefixLength: prefix.length,
        scopeId: fileId,
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
        id: dupB,
        displayName: `${prefix}dup!`,
        displayNamePrefixLength: prefix.length,
        scopeId: fileId,
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
        id: generatedA,
        displayName: `${prefix}!!!`,
        displayNamePrefixLength: prefix.length,
        scopeId: fileId,
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
        id: generatedB,
        displayName: `${prefix}???`,
        displayNamePrefixLength: prefix.length,
        scopeId: fileId,
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
        id: prefixEq,
        displayName: prefix,
        displayNamePrefixLength: prefix.length,
        scopeId: fileId,
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
        id: root,
        displayName: `${prefix}root`,
        displayNamePrefixLength: prefix.length,
        scopeId: fileId,
        nestedNodes: [],
        kind: "struct",
        structNode: {
          dataWordCount: 2,
          pointerCount: 2,
          isGroup: false,
          discriminantCount: 3,
          discriminantOffset: 0,
          fields: [
            {
              name: "first",
              codeOrder: 0,
              discriminantValue: 0,
              slot: { offset: 0, type: { kind: "uint32" } },
            },
            {
              name: "dupA",
              codeOrder: 1,
              discriminantValue: 0,
              slot: { offset: 1, type: { kind: "bool" } },
            },
            {
              name: "unknownEnum",
              codeOrder: 2,
              discriminantValue: FIELD_NO_DISCRIMINANT,
              slot: { offset: 2, type: { kind: "enum", typeId: 0xdeadn } },
            },
            {
              name: "unknownStruct",
              codeOrder: 3,
              discriminantValue: FIELD_NO_DISCRIMINANT,
              slot: { offset: 1, type: { kind: "struct", typeId: 0xbeefn } },
            },
          ],
        },
      },
      {
        id: svc,
        displayName: `${prefix}svc`,
        displayNamePrefixLength: prefix.length,
        scopeId: fileId,
        nestedNodes: [],
        kind: "interface",
        interfaceNode: {
          methods: [
            {
              name: "zeta",
              codeOrder: 7,
              paramStructTypeId: dupA,
              resultStructTypeId: dupB,
            },
            {
              name: "alpha",
              codeOrder: 7,
              paramStructTypeId: dupA,
              resultStructTypeId: dupB,
            },
          ],
        },
      },
      {
        id: svcBang,
        displayName: `${prefix}svc!`,
        displayNamePrefixLength: prefix.length,
        scopeId: fileId,
        nestedNodes: [],
        kind: "interface",
        interfaceNode: {
          methods: [
            {
              name: "pong",
              codeOrder: 0,
              paramStructTypeId: dupA,
              resultStructTypeId: dupB,
            },
          ],
        },
      },
    ],
    requestedFiles: [
      {
        id: fileId,
        filename: "schema/noext",
        imports: [{ id: 0x777n, name: "dep.capnp" }],
      },
      // Unknown requested file id: should be skipped.
      { id: 0x999n, filename: "schema/missing.capnp", imports: [] },
      // Known id but non-file node: should be skipped.
      { id: dupA, filename: "schema/not_file.capnp", imports: [] },
    ],
  };
}

Deno.test("capnpc-deno emitter handles edge naming and fallback paths", () => {
  const generated = generateTypescriptFiles(makeEmitterEdgeRequest());
  assertEquals(generated.length, 2);

  const types = fileByPath(generated, "noext_types.ts");
  const meta = fileByPath(generated, "noext_meta.ts");

  assert(
    types.contents.includes("interface Dup {") &&
      types.contents.includes("interface Dup2 {"),
    "expected deterministic suffixing for local type-name collisions",
  );
  assert(
    types.contents.includes("interface GeneratedType {") &&
      types.contents.includes("interface GeneratedType2 {"),
    "expected GeneratedType fallback with deterministic suffixing",
  );
  assert(
    types.contents.includes("interface SchemaNoext {"),
    "expected simpleNodeName prefix>=length fallback path",
  );
  assert(
    types.contents.includes(
      'which?: "dupA" | "unknownEnum" | "unknownStruct";',
    ),
    "expected union fallback to deterministic field tail selection",
  );
  assert(
    types.contents.includes("type: TYPE_UINT16,"),
    "expected enum descriptor fallback when enum id is unknown",
  );
  assert(
    types.contents.includes("type: TYPE_ANY_POINTER,"),
    "expected struct descriptor fallback when struct id is unknown",
  );
  assert(
    types.contents.includes("undefined as unknown as unknown"),
    "expected unknown reference default expression fallback",
  );

  assert(
    types.contents.includes("export interface SvcClient") &&
      types.contents.includes("export interface Svc2Client"),
    "expected deterministic interface name suffixing",
  );
  const alphaIndex = types.contents.indexOf("alpha: 7,");
  const zetaIndex = types.contents.indexOf("zeta: 7,");
  assert(alphaIndex >= 0 && zetaIndex >= 0 && alphaIndex < zetaIndex);

  assert(
    meta.contents.includes('schemaFilename = "schema/noext"'),
    "expected no-extension filename to flow through metadata module",
  );
  assert(
    meta.contents.includes('name: "dep.capnp"'),
    "expected import metadata in generated meta module",
  );
});
