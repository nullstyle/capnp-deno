import { finalizeGeneratedFiles } from "../tools/capnpc-deno/cli.ts";
import { generateTypescriptFiles } from "../tools/capnpc-deno/emitter.ts";
import type { CodeGeneratorRequestModel } from "../tools/capnpc-deno/model.ts";
import { parseCodeGeneratorRequest } from "../tools/capnpc-deno/request_parser.ts";
import { assert, assertEquals } from "./test_utils.ts";

const REQUEST_FIXTURE =
  "tests/fixtures/codegen_requests/multi_schema_request.b64";

const EXPECTED_HASH_BY_PATH: Record<string, string> = {
  "person_codegen_capnp.ts":
    "fb20efaabc722e86dc9cda71502147c8ee051104e0d48bb223604aafd2479311",
  "person_codegen_meta.ts":
    "ff17ccca414fa180ebdb6ac9c2b9fdeb2a7a11ba57f0755acad3d376f0bc73a8",
  "person_codegen_rpc.ts":
    "e8e7d6befebbe78acfed0da1f96e0693b8fd22fcc563aa0d2658231d83f8ebd0",
  "union_group_codegen_capnp.ts":
    "0b906d76e6c16a7adda5e4b6dd93ebe53da11664edc34d963d8a70bf87b9db3a",
  "union_group_codegen_meta.ts":
    "55f346ad1d1dd9c4c7bffe0ac1f9d4180d2df09a101d294dbfba2d30ae8eb9fb",
  "union_group_codegen_rpc.ts":
    "e8e7d6befebbe78acfed0da1f96e0693b8fd22fcc563aa0d2658231d83f8ebd0",
  "mod.ts": "224a195f1dba7189df0b7d2c6c1f14a47d93595240c92005b23feb6b4de5efa2",
};

async function decodeFixture(path: string): Promise<Uint8Array> {
  const base64 = (await Deno.readTextFile(path)).trim();
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

Deno.test("capnpc-deno multi-schema output contract is deterministic", async () => {
  const request = parseCodeGeneratorRequest(
    await decodeFixture(REQUEST_FIXTURE),
  );
  const generated = generateTypescriptFiles(request);
  assertEquals(generated.length, 6);

  const finalized = finalizeGeneratedFiles(generated, {
    layout: "schema",
    srcDirs: ["tests/fixtures/schemas"],
    emitBarrel: true,
  });
  const finalizedReversed = finalizeGeneratedFiles([...generated].reverse(), {
    layout: "schema",
    srcDirs: ["tests/fixtures/schemas"],
    emitBarrel: true,
  });

  assertEquals(
    finalized.map((file) => file.path).join(","),
    "person_codegen_capnp.ts,person_codegen_meta.ts,person_codegen_rpc.ts,union_group_codegen_capnp.ts,union_group_codegen_meta.ts,union_group_codegen_rpc.ts,mod.ts",
  );
  assertEquals(
    finalizedReversed.map((file) => file.path).join(","),
    finalized.map((file) => file.path).join(","),
  );

  for (const file of finalized) {
    const expectedHash = EXPECTED_HASH_BY_PATH[file.path];
    assert(
      expectedHash !== undefined,
      `unexpected generated path: ${file.path}`,
    );
    assertEquals(await sha256Hex(file.contents), expectedHash);
  }
  for (const file of finalizedReversed) {
    const expectedHash = EXPECTED_HASH_BY_PATH[file.path];
    assert(
      expectedHash !== undefined,
      `unexpected generated path: ${file.path}`,
    );
    assertEquals(await sha256Hex(file.contents), expectedHash);
  }
});

// ---------------------------------------------------------------------------
// Repeated generation produces identical output
// ---------------------------------------------------------------------------

Deno.test("capnpc-deno repeated generation produces byte-identical output", async () => {
  const fixture = await decodeFixture(REQUEST_FIXTURE);
  const request = parseCodeGeneratorRequest(fixture);

  const run1 = generateTypescriptFiles(request);
  const run2 = generateTypescriptFiles(request);

  assertEquals(run1.length, run2.length);
  for (let i = 0; i < run1.length; i += 1) {
    assertEquals(run1[i].path, run2[i].path);
    assertEquals(
      await sha256Hex(run1[i].contents),
      await sha256Hex(run2[i].contents),
    );
  }

  const finalized1 = finalizeGeneratedFiles(run1, {
    layout: "schema",
    srcDirs: ["tests/fixtures/schemas"],
    emitBarrel: true,
  });
  const finalized2 = finalizeGeneratedFiles(run2, {
    layout: "schema",
    srcDirs: ["tests/fixtures/schemas"],
    emitBarrel: true,
  });

  assertEquals(finalized1.length, finalized2.length);
  for (let i = 0; i < finalized1.length; i += 1) {
    assertEquals(finalized1[i].path, finalized2[i].path);
    assertEquals(
      await sha256Hex(finalized1[i].contents),
      await sha256Hex(finalized2[i].contents),
    );
  }
});

// ---------------------------------------------------------------------------
// Field definition order does not affect output (Cap'n Proto uses codeOrder)
// ---------------------------------------------------------------------------

Deno.test("capnpc-deno field definition order does not affect output", async () => {
  const fileId = 0x500n;
  const structId = 0x501n;
  const prefix = "schema/field_order.capnp:";

  const fieldsForward = [
    {
      name: "alpha",
      codeOrder: 0,
      discriminantValue: 0xffff,
      slot: { offset: 0, type: { kind: "uint32" as const } },
    },
    {
      name: "beta",
      codeOrder: 1,
      discriminantValue: 0xffff,
      slot: { offset: 1, type: { kind: "uint32" as const } },
    },
    {
      name: "gamma",
      codeOrder: 2,
      discriminantValue: 0xffff,
      slot: { offset: 0, type: { kind: "text" as const } },
    },
  ];

  const fieldsReversed = [...fieldsForward].reverse();

  function makeRequest(
    fields: typeof fieldsForward,
  ): CodeGeneratorRequestModel {
    return {
      nodes: [
        {
          id: fileId,
          displayName: "schema/field_order.capnp",
          displayNamePrefixLength: 0,
          scopeId: 0n,
          nestedNodes: [{ name: "Record", id: structId }],
          kind: "file",
        },
        {
          id: structId,
          displayName: `${prefix}Record`,
          displayNamePrefixLength: prefix.length,
          scopeId: fileId,
          nestedNodes: [],
          kind: "struct",
          structNode: {
            dataWordCount: 2,
            pointerCount: 1,
            isGroup: false,
            discriminantCount: 0,
            discriminantOffset: 0,
            fields,
          },
        },
      ],
      requestedFiles: [
        { id: fileId, filename: "schema/field_order.capnp", imports: [] },
      ],
    };
  }

  const genForward = generateTypescriptFiles(makeRequest(fieldsForward));
  const genReversed = generateTypescriptFiles(makeRequest(fieldsReversed));

  assertEquals(genForward.length, genReversed.length);
  for (let i = 0; i < genForward.length; i += 1) {
    assertEquals(genForward[i].path, genReversed[i].path);
    assertEquals(
      await sha256Hex(genForward[i].contents),
      await sha256Hex(genReversed[i].contents),
    );
  }
});

// ---------------------------------------------------------------------------
// Interface method ordering is deterministic (sorted by codeOrder)
// ---------------------------------------------------------------------------

Deno.test("capnpc-deno interface method ordering is deterministic", async () => {
  const fileId = 0x600n;
  const interfaceId = 0x601n;
  const paramId1 = 0x610n;
  const resultId1 = 0x611n;
  const paramId2 = 0x612n;
  const resultId2 = 0x613n;
  const paramId3 = 0x614n;
  const resultId3 = 0x615n;
  const prefix = "schema/method_order.capnp:";

  const methodsForward = [
    {
      name: "alpha",
      codeOrder: 0,
      paramStructTypeId: paramId1,
      resultStructTypeId: resultId1,
    },
    {
      name: "beta",
      codeOrder: 1,
      paramStructTypeId: paramId2,
      resultStructTypeId: resultId2,
    },
    {
      name: "gamma",
      codeOrder: 2,
      paramStructTypeId: paramId3,
      resultStructTypeId: resultId3,
    },
  ];

  const methodsReversed = [...methodsForward].reverse();
  const methodsShuffled = [
    methodsForward[1],
    methodsForward[2],
    methodsForward[0],
  ];

  function makeParamResultNodes(
    idBase: bigint,
    methodName: string,
  ): CodeGeneratorRequestModel["nodes"] {
    return [
      {
        id: idBase,
        displayName: `${prefix}Svc.${methodName}$Params`,
        displayNamePrefixLength: prefix.length,
        scopeId: interfaceId,
        nestedNodes: [],
        kind: "struct" as const,
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
        id: idBase + 1n,
        displayName: `${prefix}Svc.${methodName}$Results`,
        displayNamePrefixLength: prefix.length,
        scopeId: interfaceId,
        nestedNodes: [],
        kind: "struct" as const,
        structNode: {
          dataWordCount: 0,
          pointerCount: 0,
          isGroup: false,
          discriminantCount: 0,
          discriminantOffset: 0,
          fields: [],
        },
      },
    ];
  }

  function makeRequest(
    methods: typeof methodsForward,
  ): CodeGeneratorRequestModel {
    return {
      nodes: [
        {
          id: fileId,
          displayName: "schema/method_order.capnp",
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
          interfaceNode: { methods },
        },
        ...makeParamResultNodes(paramId1, "alpha"),
        ...makeParamResultNodes(paramId2, "beta"),
        ...makeParamResultNodes(paramId3, "gamma"),
      ],
      requestedFiles: [
        { id: fileId, filename: "schema/method_order.capnp", imports: [] },
      ],
    };
  }

  const genForward = generateTypescriptFiles(makeRequest(methodsForward));
  const genReversed = generateTypescriptFiles(makeRequest(methodsReversed));
  const genShuffled = generateTypescriptFiles(makeRequest(methodsShuffled));

  assertEquals(genForward.length, genReversed.length);
  assertEquals(genForward.length, genShuffled.length);
  for (let i = 0; i < genForward.length; i += 1) {
    assertEquals(genForward[i].path, genReversed[i].path);
    assertEquals(genForward[i].path, genShuffled[i].path);

    const hashForward = await sha256Hex(genForward[i].contents);
    const hashReversed = await sha256Hex(genReversed[i].contents);
    const hashShuffled = await sha256Hex(genShuffled[i].contents);
    assertEquals(hashForward, hashReversed);
    assertEquals(hashForward, hashShuffled);
  }

  // Verify method ordinals appear in ascending codeOrder in the rpc output
  const rpcFile = genForward.find((file) => file.path.endsWith("_rpc.ts"));
  assert(rpcFile !== undefined, "expected rpc file in generated output");
  const alphaIdx = rpcFile.contents.indexOf("alpha: 0,");
  const betaIdx = rpcFile.contents.indexOf("beta: 1,");
  const gammaIdx = rpcFile.contents.indexOf("gamma: 2,");
  assert(alphaIdx >= 0, "expected alpha method ordinal");
  assert(betaIdx >= 0, "expected beta method ordinal");
  assert(gammaIdx >= 0, "expected gamma method ordinal");
  assert(alphaIdx < betaIdx, "alpha must appear before beta");
  assert(betaIdx < gammaIdx, "beta must appear before gamma");
});

// ---------------------------------------------------------------------------
// Multi-schema generation order is stable regardless of requestedFiles order
// ---------------------------------------------------------------------------

Deno.test("capnpc-deno multi-schema generation order is stable", async () => {
  const fileIdA = 0x700n;
  const fileIdB = 0x701n;
  const fileIdC = 0x702n;
  const structIdA = 0x710n;
  const structIdB = 0x711n;
  const structIdC = 0x712n;

  function makeFileNode(
    fileId: bigint,
    structId: bigint,
    name: string,
  ): CodeGeneratorRequestModel["nodes"] {
    const prefix = `schema/${name}.capnp:`;
    return [
      {
        id: fileId,
        displayName: `schema/${name}.capnp`,
        displayNamePrefixLength: 0,
        scopeId: 0n,
        nestedNodes: [{ name: "Item", id: structId }],
        kind: "file" as const,
      },
      {
        id: structId,
        displayName: `${prefix}Item`,
        displayNamePrefixLength: prefix.length,
        scopeId: fileId,
        nestedNodes: [],
        kind: "struct" as const,
        structNode: {
          dataWordCount: 1,
          pointerCount: 0,
          isGroup: false,
          discriminantCount: 0,
          discriminantOffset: 0,
          fields: [
            {
              name: "value",
              codeOrder: 0,
              discriminantValue: 0xffff,
              slot: { offset: 0, type: { kind: "uint64" as const } },
            },
          ],
        },
      },
    ];
  }

  const nodesAll = [
    ...makeFileNode(fileIdA, structIdA, "aaa"),
    ...makeFileNode(fileIdB, structIdB, "bbb"),
    ...makeFileNode(fileIdC, structIdC, "ccc"),
  ];

  const requestedFilesForward = [
    { id: fileIdA, filename: "schema/aaa.capnp", imports: [] },
    { id: fileIdB, filename: "schema/bbb.capnp", imports: [] },
    { id: fileIdC, filename: "schema/ccc.capnp", imports: [] },
  ];

  const requestedFilesReversed = [...requestedFilesForward].reverse();
  const requestedFilesShuffled = [
    requestedFilesForward[2],
    requestedFilesForward[0],
    requestedFilesForward[1],
  ];

  function makeRequest(
    requestedFiles: typeof requestedFilesForward,
  ): CodeGeneratorRequestModel {
    return { nodes: nodesAll, requestedFiles };
  }

  const genForward = generateTypescriptFiles(
    makeRequest(requestedFilesForward),
  );
  const genReversed = generateTypescriptFiles(
    makeRequest(requestedFilesReversed),
  );
  const genShuffled = generateTypescriptFiles(
    makeRequest(requestedFilesShuffled),
  );

  // All three runs produce the same number of files
  assertEquals(genForward.length, genReversed.length);
  assertEquals(genForward.length, genShuffled.length);
  assert(genForward.length > 0, "expected generated files");

  // After finalization, file ordering and content hashes must be identical
  const opts = {
    layout: "schema" as const,
    srcDirs: ["schema"],
    emitBarrel: true,
  };
  const finForward = finalizeGeneratedFiles(genForward, opts);
  const finReversed = finalizeGeneratedFiles(genReversed, opts);
  const finShuffled = finalizeGeneratedFiles(genShuffled, opts);

  assertEquals(finForward.length, finReversed.length);
  assertEquals(finForward.length, finShuffled.length);

  for (let i = 0; i < finForward.length; i += 1) {
    assertEquals(finForward[i].path, finReversed[i].path);
    assertEquals(finForward[i].path, finShuffled[i].path);

    const hashForward = await sha256Hex(finForward[i].contents);
    const hashReversed = await sha256Hex(finReversed[i].contents);
    const hashShuffled = await sha256Hex(finShuffled[i].contents);
    assertEquals(hashForward, hashReversed);
    assertEquals(hashForward, hashShuffled);
  }

  // Barrel module must re-export all schema files in sorted order
  const barrel = finForward.find((file) => file.path === "mod.ts");
  assert(barrel !== undefined, "expected barrel module");
  const reExports = barrel.contents
    .split("\n")
    .filter((line) => line.startsWith("export * from"))
    .map((line) => {
      const match = line.match(/"([^"]+)"/);
      return match ? match[1] : "";
    });
  for (let i = 1; i < reExports.length; i += 1) {
    assert(
      reExports[i - 1].localeCompare(reExports[i]) <= 0,
      `barrel re-exports must be sorted: ${
        reExports[i - 1]
      } should come before ${reExports[i]}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Cross-file dependency ordering: node iteration order does not affect output
// ---------------------------------------------------------------------------

Deno.test("capnpc-deno node iteration order does not affect output", async () => {
  const fileId = 0x800n;
  const enumId = 0x810n;
  const structId1 = 0x811n;
  const structId2 = 0x812n;
  const prefix = "schema/node_order.capnp:";

  const fileNode = {
    id: fileId,
    displayName: "schema/node_order.capnp",
    displayNamePrefixLength: 0,
    scopeId: 0n,
    nestedNodes: [
      { name: "Status", id: enumId },
      { name: "Alpha", id: structId1 },
      { name: "Beta", id: structId2 },
    ],
    kind: "file" as const,
  };

  const enumNode = {
    id: enumId,
    displayName: `${prefix}Status`,
    displayNamePrefixLength: prefix.length,
    scopeId: fileId,
    nestedNodes: [],
    kind: "enum" as const,
    enumNode: {
      enumerants: [
        { name: "active", codeOrder: 0 },
        { name: "inactive", codeOrder: 1 },
      ],
    },
  };

  const structNode1 = {
    id: structId1,
    displayName: `${prefix}Alpha`,
    displayNamePrefixLength: prefix.length,
    scopeId: fileId,
    nestedNodes: [],
    kind: "struct" as const,
    structNode: {
      dataWordCount: 1,
      pointerCount: 0,
      isGroup: false,
      discriminantCount: 0,
      discriminantOffset: 0,
      fields: [
        {
          name: "status",
          codeOrder: 0,
          discriminantValue: 0xffff,
          slot: { offset: 0, type: { kind: "enum" as const, typeId: enumId } },
        },
      ],
    },
  };

  const structNode2 = {
    id: structId2,
    displayName: `${prefix}Beta`,
    displayNamePrefixLength: prefix.length,
    scopeId: fileId,
    nestedNodes: [],
    kind: "struct" as const,
    structNode: {
      dataWordCount: 1,
      pointerCount: 1,
      isGroup: false,
      discriminantCount: 0,
      discriminantOffset: 0,
      fields: [
        {
          name: "count",
          codeOrder: 0,
          discriminantValue: 0xffff,
          slot: { offset: 0, type: { kind: "uint32" as const } },
        },
        {
          name: "label",
          codeOrder: 1,
          discriminantValue: 0xffff,
          slot: { offset: 0, type: { kind: "text" as const } },
        },
      ],
    },
  };

  // Nodes listed in forward order
  const nodesForward = [fileNode, enumNode, structNode1, structNode2];
  // Nodes listed in reverse order
  const nodesReversed = [structNode2, structNode1, enumNode, fileNode];
  // Nodes in an arbitrary shuffled order
  const nodesShuffled = [structNode1, fileNode, structNode2, enumNode];

  const requestedFiles = [
    { id: fileId, filename: "schema/node_order.capnp", imports: [] },
  ];

  const genForward = generateTypescriptFiles({
    nodes: nodesForward,
    requestedFiles,
  });
  const genReversed = generateTypescriptFiles({
    nodes: nodesReversed,
    requestedFiles,
  });
  const genShuffled = generateTypescriptFiles({
    nodes: nodesShuffled,
    requestedFiles,
  });

  assertEquals(genForward.length, genReversed.length);
  assertEquals(genForward.length, genShuffled.length);

  for (let i = 0; i < genForward.length; i += 1) {
    assertEquals(genForward[i].path, genReversed[i].path);
    assertEquals(genForward[i].path, genShuffled[i].path);

    const hashForward = await sha256Hex(genForward[i].contents);
    const hashReversed = await sha256Hex(genReversed[i].contents);
    const hashShuffled = await sha256Hex(genShuffled[i].contents);
    assertEquals(hashForward, hashReversed);
    assertEquals(hashForward, hashShuffled);
  }
});

// ---------------------------------------------------------------------------
// Multiple interfaces in one file are emitted in deterministic order
// ---------------------------------------------------------------------------

Deno.test("capnpc-deno multiple interfaces in one file are deterministic", async () => {
  const fileId = 0x900n;
  const ifaceIdA = 0x901n;
  const ifaceIdB = 0x902n;
  const ifaceIdC = 0x903n;
  const prefix = "schema/multi_iface.capnp:";

  function makeInterfaceNode(
    id: bigint,
    name: string,
    methodNames: string[],
    methodIdBase: bigint,
  ): {
    iface: CodeGeneratorRequestModel["nodes"][0];
    methodStructs: CodeGeneratorRequestModel["nodes"];
  } {
    const methods = methodNames.map((mName, idx) => ({
      name: mName,
      codeOrder: idx,
      paramStructTypeId: methodIdBase + BigInt(idx * 2),
      resultStructTypeId: methodIdBase + BigInt(idx * 2 + 1),
    }));
    const methodStructs: CodeGeneratorRequestModel["nodes"] = [];
    for (const method of methods) {
      methodStructs.push({
        id: method.paramStructTypeId,
        displayName: `${prefix}${name}.${method.name}$Params`,
        displayNamePrefixLength: prefix.length,
        scopeId: id,
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
      });
      methodStructs.push({
        id: method.resultStructTypeId,
        displayName: `${prefix}${name}.${method.name}$Results`,
        displayNamePrefixLength: prefix.length,
        scopeId: id,
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
      });
    }

    return {
      iface: {
        id,
        displayName: `${prefix}${name}`,
        displayNamePrefixLength: prefix.length,
        scopeId: fileId,
        nestedNodes: [],
        kind: "interface",
        interfaceNode: {
          methods,
        },
      },
      methodStructs,
    };
  }

  const fileNode = {
    id: fileId,
    displayName: "schema/multi_iface.capnp",
    displayNamePrefixLength: 0,
    scopeId: 0n,
    nestedNodes: [
      { name: "Zebra", id: ifaceIdC },
      { name: "Alpha", id: ifaceIdA },
      { name: "Middle", id: ifaceIdB },
    ],
    kind: "file" as const,
  };

  const ifaceA = makeInterfaceNode(ifaceIdA, "Alpha", ["run", "stop"], 0xf00n);
  const ifaceB = makeInterfaceNode(ifaceIdB, "Middle", ["pause"], 0xf20n);
  const ifaceC = makeInterfaceNode(ifaceIdC, "Zebra", ["execute"], 0xf40n);

  // Forward node order
  const nodesForward = [
    fileNode,
    ifaceA.iface,
    ...ifaceA.methodStructs,
    ifaceB.iface,
    ...ifaceB.methodStructs,
    ifaceC.iface,
    ...ifaceC.methodStructs,
  ];
  // Reversed node order
  const nodesReversed = [
    fileNode,
    ifaceC.iface,
    ...[...ifaceC.methodStructs].reverse(),
    ifaceB.iface,
    ...[...ifaceB.methodStructs].reverse(),
    ifaceA.iface,
    ...[...ifaceA.methodStructs].reverse(),
  ];

  const requestedFiles = [
    { id: fileId, filename: "schema/multi_iface.capnp", imports: [] },
  ];

  const genForward = generateTypescriptFiles({
    nodes: nodesForward,
    requestedFiles,
  });
  const genReversed = generateTypescriptFiles({
    nodes: nodesReversed,
    requestedFiles,
  });

  assertEquals(genForward.length, genReversed.length);
  for (let i = 0; i < genForward.length; i += 1) {
    assertEquals(genForward[i].path, genReversed[i].path);
    assertEquals(
      await sha256Hex(genForward[i].contents),
      await sha256Hex(genReversed[i].contents),
    );
  }

  // Verify interfaces appear in displayName-sorted order in the rpc file
  const rpcFile = genForward.find((file) => file.path.endsWith("_rpc.ts"));
  assert(rpcFile !== undefined, "expected rpc file");
  const alphaIdx = rpcFile.contents.indexOf("AlphaInterfaceId");
  const middleIdx = rpcFile.contents.indexOf("MiddleInterfaceId");
  const zebraIdx = rpcFile.contents.indexOf("ZebraInterfaceId");
  assert(alphaIdx >= 0, "expected Alpha interface id constant");
  assert(middleIdx >= 0, "expected Middle interface id constant");
  assert(zebraIdx >= 0, "expected Zebra interface id constant");
  assert(alphaIdx < middleIdx, "Alpha must appear before Middle in rpc output");
  assert(middleIdx < zebraIdx, "Middle must appear before Zebra in rpc output");
});
