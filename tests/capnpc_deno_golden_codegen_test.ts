import { finalizeGeneratedFiles } from "../tools/capnpc-deno/cli.ts";
import { generateTypescriptFiles } from "../tools/capnpc-deno/emitter.ts";
import { parseCodeGeneratorRequest } from "../tools/capnpc-deno/request_parser.ts";
import { assert, assertEquals } from "./test_utils.ts";

const REQUEST_FIXTURE =
  "tests/fixtures/codegen_requests/multi_schema_request.b64";

const EXPECTED_HASH_BY_PATH: Record<string, string> = {
  "person_codegen_capnp.ts":
    "696a1254bdb6fa14cb05854611bc7620755a84709c17f0446c24e4ecf306796b",
  "person_codegen_meta.ts":
    "ff17ccca414fa180ebdb6ac9c2b9fdeb2a7a11ba57f0755acad3d376f0bc73a8",
  "person_codegen_rpc.ts":
    "e8e7d6befebbe78acfed0da1f96e0693b8fd22fcc563aa0d2658231d83f8ebd0",
  "union_group_codegen_capnp.ts":
    "3962cda908853b45e1fc413897f0cc63404a5f42cf8affdd2c174d339bafdae3",
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
