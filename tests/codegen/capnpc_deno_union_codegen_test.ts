import { generateTypescriptFiles } from "../../tools/capnpc-deno/emitter.ts";
import { parseCodeGeneratorRequest } from "../../tools/capnpc-deno/request_parser.ts";
import { assert, assertEquals } from "../test_utils.ts";

const REQUEST_BASE64 =
  "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";

const UNNAMED_UNION_REQUEST_BASE64 =
  "AAAAALYAAAAAAAAAAAAEABEAAADHAAAAVQIAACcAAAAEAAAAAQAAAOkBAABHAAAAAQADAAAAAAAIAAAABgAGAMH+Xl35ltiWLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEUAAACaAQAAXQAAABcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFzdy/BhTOXYMwAAAAEAAgDB/l5d+ZbYlgEABwAAAAMABAAAAAAAAAAWAAAAlgAAAEEAAADSAQAAXQAAAAcAAAAAAAAAAAAAAFkAAAAfAQAAAAAAAAAAAAAAAAAAAAAAAHRlc3RzL2ZpeHR1cmVzL3NjaGVtYXMvdW5uYW1lZF91bmlvbl9jb2RlZ2VuLmNhcG5wAAAAAAAABAAAAAEAAQBc3cvwYUzl2AEAAAA6AAAAU2FtcGxlAAB0ZXN0cy9maXh0dXJlcy9zY2hlbWFzL3VubmFtZWRfdW5pb25fY29kZWdlbi5jYXBucDpTYW1wbGUAAAAAAAAAAAAAAAEAAQAUAAAAAwAEAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAH0AAAAaAAAAAAAAAAAAAAB4AAAAAwABAIQAAAACAAEAAQD//wAAAAAAAAEAAQAAAAAAAAAAAAAAgQAAACoAAAAAAAAAAAAAAHwAAAADAAEAiAAAAAIAAQACAP7/AAAAAAAAAQACAAAAAAAAAAAAAACFAAAAKgAAAAAAAAAAAAAAgAAAAAMAAQCMAAAAAgABAAMA/f8DAAAAAAABAAMAAAAAAAAAAAAAAIkAAAAyAAAAAAAAAAAAAACEAAAAAwABAJAAAAACAAEABAAAAFAAAAAAAAEABAAAAAAAAAAAAAAAjQAAADIAAAAAAAAAAAAAAIgAAAADAAEAlAAAAAIAAQBpZAAAAAAAAAkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAbm9uZQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG5hbWUAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABjb3VudAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYWZ0ZXIAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAACAAIAXN3L8GFM5dgWAAAAlgAAAAAAAAAAAAAAEQAAAH8AAADB/l5d+ZbYlgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQAAAABAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAEAAwDB/l5d+ZbYlgkAAACaAQAAIQAAAAcAAAAgAAAAAAABAHRlc3RzL2ZpeHR1cmVzL3NjaGVtYXMvdW5uYW1lZF91bmlvbl9jb2RlZ2VuLmNhcG5wAAAAAAAAAAAAAAEAAQABAAAAfwAAABQAAAADAAAALwAAADUAAAD/AwAAAAAAAAAAAAAAAAAATwAAAFMAAAD2AwAAAAAAAAAAAAAAAAAAYgAAAGYAAAACBAAAAAAAAAAAAAAAAAAAdgAAAHwAAAD+AwAAAAAAAAAAAAAAAAAAjwAAAJMAAAD3AwAAAAAAAAAAAAAAAAAA";

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

const ENCODING_RUNTIME_URL = new URL(
  "../../src/encoding.ts",
  import.meta.url,
).href;
const RPC_RUNTIME_URL = new URL(
  "../../src/rpc.ts",
  import.meta.url,
).href;

async function importGeneratedModule(
  source: string,
): Promise<Record<string, unknown>> {
  const patched = source
    .replaceAll(
      `"@nullstyle/capnp/encoding"`,
      `"${ENCODING_RUNTIME_URL}"`,
    )
    .replaceAll(
      `"@nullstyle/capnp/rpc"`,
      `"${RPC_RUNTIME_URL}"`,
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

Deno.test("capnpc-deno parses union/group struct metadata", () => {
  const bytes = decodeBase64(REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);

  const exampleNode = request.nodes.find((node) =>
    node.displayName.endsWith(":Example")
  );
  assert(exampleNode !== undefined, "expected Example node");
  assert(exampleNode.structNode !== undefined, "expected Example struct");
  assertEquals(exampleNode.structNode.discriminantCount, 0);
  assertEquals(exampleNode.structNode.isGroup, false);

  const modeNode = request.nodes.find((node) =>
    node.displayName.endsWith(":Example.mode")
  );
  assert(modeNode !== undefined, "expected mode group node");
  assert(modeNode.structNode !== undefined, "expected mode struct");
  assertEquals(modeNode.structNode.isGroup, true);
  assertEquals(modeNode.structNode.discriminantCount, 4);
  assertEquals(modeNode.structNode.discriminantOffset, 4);
  assertEquals(
    modeNode.structNode.fields.map((field) => field.discriminantValue).join(
      ",",
    ),
    "0,1,2,3",
  );
});

Deno.test("capnpc-deno generated codec roundtrips union/group variants", async () => {
  const bytes = decodeBase64(REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);
  const generated = generateTypescriptFiles(request);
  assertEquals(generated.length, 2);

  const moduleSource = fileByPath(generated, "union_group_codegen_types.ts")
    .contents;
  assert(
    moduleSource.includes("which?:"),
    "expected generated union tag property",
  );
  assert(
    moduleSource.includes('kind: "group"'),
    "expected generated group field descriptor",
  );

  const mod = await importGeneratedModule(moduleSource);
  const codec = mod.ExampleCodec as
    | { encode(value: unknown): Uint8Array; decode(bytes: Uint8Array): unknown }
    | undefined;
  assert(codec !== undefined, "expected ExampleCodec export");

  const nameVariant = {
    id: 9n,
    mode: {
      which: "name",
      name: "Bob",
    },
  };
  const nameDecoded = codec.decode(codec.encode(nameVariant)) as Record<
    string,
    unknown
  >;
  const decodedMode1 = nameDecoded.mode as Record<string, unknown>;
  assertEquals(nameDecoded.id, 9n);
  assertEquals(decodedMode1.which, "name");
  assertEquals(decodedMode1.name, "Bob");

  const cfgVariant = {
    id: 10n,
    mode: {
      which: "cfg",
      cfg: {
        enabled: true,
        label: "z",
      },
    },
  };
  const cfgDecoded = codec.decode(codec.encode(cfgVariant)) as Record<
    string,
    unknown
  >;
  const decodedMode2 = cfgDecoded.mode as Record<string, unknown>;
  const decodedCfg = decodedMode2.cfg as Record<string, unknown>;
  assertEquals(cfgDecoded.id, 10n);
  assertEquals(decodedMode2.which, "cfg");
  assertEquals(decodedCfg.enabled, true);
  assertEquals(decodedCfg.label, "z");
});

Deno.test("capnpc-deno identifies unnamed union members in mixed-field structs", async () => {
  const bytes = decodeBase64(UNNAMED_UNION_REQUEST_BASE64);
  const request = parseCodeGeneratorRequest(bytes);

  const sampleNode = request.nodes.find((node) =>
    node.displayName.endsWith(":Sample")
  );
  assert(sampleNode !== undefined, "expected Sample node");
  assert(sampleNode.structNode !== undefined, "expected Sample struct node");
  assertEquals(sampleNode.structNode.discriminantCount, 3);
  assertEquals(
    sampleNode.structNode.fields.map((field) =>
      `${field.name}:${field.discriminantValue}`
    ).join(","),
    "id:65535,none:0,name:1,count:2,after:65535",
  );

  const generated = generateTypescriptFiles(request);
  assertEquals(generated.length, 2);
  const source =
    fileByPath(generated, "unnamed_union_codegen_types.ts").contents;
  assert(
    source.includes("which?:"),
    "expected union tag property in Sample interface",
  );

  const mod = await importGeneratedModule(source);
  const codec = mod.SampleCodec as
    | { encode(value: unknown): Uint8Array; decode(bytes: Uint8Array): unknown }
    | undefined;
  assert(codec !== undefined, "expected SampleCodec export");

  const value = {
    id: 22n,
    which: "count",
    count: 123,
    after: true,
  };
  const decoded = codec.decode(codec.encode(value)) as Record<string, unknown>;
  assertEquals(decoded.id, 22n);
  assertEquals(decoded.which, "count");
  assertEquals(decoded.count, 123);
  assertEquals(decoded.after, true);
});
