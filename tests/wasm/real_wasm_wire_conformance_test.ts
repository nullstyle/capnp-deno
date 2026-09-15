import { MessageReader, WasmSerde } from "../../src/encoding.ts";
import { assert, assertEquals, assertThrows } from "../test_utils.ts";
import { far, frame } from "../fixtures/wire_bytes.ts";

async function serde(): Promise<WasmSerde> {
  const bytes = await Deno.readFile(
    new URL("../../generated/capnp_deno.wasm", import.meta.url),
  );
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return WasmSerde.fromInstance(instance);
}

function nameFromTypeScript(bytes: Uint8Array): string | null {
  const reader = new MessageReader(bytes);
  const root = reader.readRootStruct();
  return root.pointerCount === 0
    ? ""
    : reader.readTextPointer(root.segmentId, reader.pointerWordIndex(root, 0));
}

Deno.test("wire conformance: current Zig WASM and TypeScript agree on double-far content and empty presence", async () => {
  using runtime = await serde();
  const rootTag = 1n << 32n | 2n << 48n;
  const personWords = [37n, 5n | 2n << 32n | 4n << 35n, 0n, 0x616441n];
  const cases = [
    frame([[rootTag, ...personWords]]),
    frame([[far(1, 0)], [rootTag, ...personWords]]),
    frame([[far(1, 0, true)], [far(2, 2), rootTag], [
      0xbadn,
      0xbadn,
      ...personWords,
    ]]),
    frame([[far(1, 0, true)], [far(2, 0), 0n], []]),
  ];
  for (const [index, bytes] of cases.entries()) {
    const actual = JSON.parse(
      runtime.decodeToJson("capnp_example_person_to_json", bytes),
    );
    assertEquals(actual.name, nameFromTypeScript(bytes));
    assertEquals(actual.age, index === 3 ? 0 : 37);
    assert(new MessageReader(bytes).readStructPointer(0, 0) !== null);
  }
});

Deno.test("wire conformance: current Zig WASM and TypeScript reject malformed Text and child bounds", async () => {
  using runtime = await serde();
  const rootTag = 1n << 32n | 2n << 48n;
  const cases = [
    [2, 0x6968n, 1], // No trailing NUL.
    [0, 0n, 1], // Non-null zero-length Text.
    [3, 0xafc0n, 1], // Invalid UTF-8 before the NUL.
    [4, 0x616441n, 100], // Child target outside the segment.
  ] as const;
  for (const [count, content, offset] of cases) {
    const textPointer = 1n | BigInt(offset) << 2n | 2n << 32n |
      BigInt(count) << 35n;
    const bytes = frame([[far(1, 0, true)], [far(2, 0), rootTag], [
      37n,
      textPointer,
      0n,
      content,
    ]]);
    assertThrows(() => nameFromTypeScript(bytes));
    assertThrows(() =>
      runtime.decodeToJson("capnp_example_person_to_json", bytes)
    );
  }
});
