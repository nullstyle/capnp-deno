import { CapnpReader } from "../../tools/capnpc-deno/capnp_reader.ts";
import { generateTypescriptFiles } from "../../tools/capnpc-deno/emitter.ts";
import { parseCodeGeneratorRequest } from "../../tools/capnpc-deno/request_parser.ts";
import { assert, assertEquals } from "../test_utils.ts";

Deno.test("compiler 1.3 and 2.0 requests produce identical TypeScript through the same parser", async () => {
  async function read(name: string): Promise<Uint8Array> {
    const text = await Deno.readTextFile(
      new URL(`../fixtures/codegen_requests/${name}.b64`, import.meta.url),
    );
    return Uint8Array.from(
      atob(text.trim()),
      (character) => character.charCodeAt(0),
    );
  }
  const oldBytes = await read("multi_schema_request");
  const newBytes = await read("multi_schema_request_2_0");
  const oldVersion = new CapnpReader(oldBytes).root().readStruct(2);
  const newVersion = new CapnpReader(newBytes).root().readStruct(2);
  assert(oldVersion !== null && newVersion !== null);
  assertEquals(`${oldVersion.readU16(0)}.${oldVersion.readU8(2)}`, "1.3");
  assertEquals(`${newVersion.readU16(0)}.${newVersion.readU8(2)}`, "2.0");
  const oldFiles = generateTypescriptFiles(parseCodeGeneratorRequest(oldBytes));
  const newFiles = generateTypescriptFiles(parseCodeGeneratorRequest(newBytes));
  assertEquals(JSON.stringify(newFiles), JSON.stringify(oldFiles));
});
