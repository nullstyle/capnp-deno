import { MessageReader } from "../../src/encoding.ts";
import type { RpcClientTransport } from "../../src/rpc.ts";
import { generateTypescriptFiles } from "../../tools/capnpc-deno/emitter.ts";
import { parseCodeGeneratorRequest } from "../../tools/capnpc-deno/request_parser.ts";
import {
  assert,
  assertBytes,
  assertEquals,
  assertThrows,
} from "../test_utils.ts";

// Requests and messages were compiled with capnp 1.5.0 from the adjacent
// evolution/default schemas. Native message bytes exercise the wire contract,
// rather than merely roundtripping two copies of this runtime's implementation.
const fixture = JSON.parse(
  await Deno.readTextFile(
    "tests/fixtures/codegen_requests/evolution_defaults.json",
  ),
) as { requests: Record<string, string>; messages: Record<string, string> };

function bytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

type Codec = {
  encode(value: Record<string, unknown>): Uint8Array;
  decode(message: Uint8Array): Record<string, unknown>;
};
type Generated = {
  CurrentCodec: Codec;
  EnvelopeCodec: Codec;
  FloatDefaultsCodec: Codec;
  RecursiveCodec: Codec;
  createEvolutionClient(
    transport: RpcClientTransport,
    capability: { capabilityIndex: number },
  ): {
    fetch(
      params: Record<string, never>,
    ): Promise<{ entry: Record<string, unknown> }>;
  };
};

async function generated(): Promise<Generated> {
  const request = parseCodeGeneratorRequest(
    bytes(fixture.requests.evolution_defaults),
  );
  const source = generateTypescriptFiles(request)
    .find((file) => file.path === "evolution_defaults_types.ts")!.contents
    .replaceAll(
      '"@nullstyle/capnp/encoding"',
      JSON.stringify(new URL("../../src/encoding.ts", import.meta.url).href),
    )
    .replaceAll(
      '"@nullstyle/capnp/rpc"',
      JSON.stringify(new URL("../../src/rpc.ts", import.meta.url).href),
    );
  return await import(
    `data:application/typescript;base64,${btoa(source)}`
  ) as Generated;
}

const defaults = {
  source: "new-client-default",
  enabled: true,
  i8: -12,
  i16: -1200,
  i32: -170000,
  i64: -9000000000000000000n,
  u8: 250,
  u16: 60000,
  u32: 4000000000,
  u64: 18000000000000000000n,
  f32: 1.25,
  f64: -9.5,
  choice: "two",
};

function expectDefaults(value: Record<string, unknown>): void {
  for (const [name, expected] of Object.entries(defaults)) {
    assertEquals(value[name], expected, name);
  }
  assertBytes(value.token as Uint8Array, [0, 17, 255]);
}

Deno.test("evolution: generated codec supplies absent scalar and pointer defaults", async () => {
  const { CurrentCodec } = await generated();
  const decoded = CurrentCodec.decode(bytes(fixture.messages.old));
  assertEquals(decoded.id, 42);
  assertEquals(decoded.name, "old-server");
  expectDefaults(decoded);
});

Deno.test("evolution: null roots and present null pointer slots use schema defaults", async () => {
  const { CurrentCodec } = await generated();
  const nullRoot = new Uint8Array(16);
  new DataView(nullRoot.buffer).setUint32(4, 1, true);
  expectDefaults(CurrentCodec.decode(nullRoot));
  expectDefaults(CurrentCodec.decode(bytes(fixture.messages.current_defaults)));
  const first = CurrentCodec.decode(nullRoot);
  (first.token as Uint8Array)[0] = 99;
  expectDefaults(CurrentCodec.decode(nullRoot));
});

Deno.test("defaults: generated scalar decoding honors native XOR masks and explicit empty pointers", async () => {
  const { CurrentCodec } = await generated();
  const decoded = CurrentCodec.decode(bytes(fixture.messages.current_values));
  const expected = {
    id: 19,
    name: "present",
    source: "",
    enabled: false,
    i8: 12,
    i16: 1200,
    i32: 170000,
    i64: 9000000000000000000n,
    u8: 1,
    u16: 2,
    u32: 3,
    u64: 4n,
    f32: -2.5,
    f64: 123.25,
    choice: "one",
  };
  for (const [name, value] of Object.entries(expected)) {
    assertEquals(decoded[name], value, name);
  }
  assertBytes(decoded.token as Uint8Array, []);
});

Deno.test("defaults: generated encoding matches native scalar wire bytes", async () => {
  const { CurrentCodec } = await generated();
  for (const name of ["current_defaults", "current_values"]) {
    const native = bytes(fixture.messages[name]);
    const expected = new MessageReader(native);
    const expectedRoot = expected.readStructPointer(0, 0)!;
    const decoded = CurrentCodec.decode(native);
    const encoded = new MessageReader(CurrentCodec.encode(decoded));
    const encodedRoot = encoded.readStructPointer(0, 0)!;
    assertBytes(
      encoded.readBytes(
        encodedRoot.segmentId,
        encodedRoot.startWord * 8,
        encodedRoot.dataWordCount * 8,
      ),
      [...expected.readBytes(
        expectedRoot.segmentId,
        expectedRoot.startWord * 8,
        expectedRoot.dataWordCount * 8,
      )],
    );
  }
});

Deno.test("defaults: omitted fields encode zero wire storage without constructing recursive defaults", async () => {
  const { CurrentCodec, RecursiveCodec } = await generated();
  const message = CurrentCodec.encode({});
  const reader = new MessageReader(message);
  const root = reader.readStructPointer(0, 0)!;
  assertBytes(
    reader.readBytes(
      root.segmentId,
      root.startWord * 8,
      (root.dataWordCount + root.pointerCount) * 8,
    ),
    Array((root.dataWordCount + root.pointerCount) * 8).fill(0),
  );
  expectDefaults(CurrentCodec.decode(message));
  const recursive = new MessageReader(RecursiveCodec.encode({}));
  const recursiveRoot = recursive.readStructPointer(0, 0)!;
  assertEquals(
    recursive.readResolvedPointerWord(
      recursiveRoot.segmentId,
      recursive.pointerWordIndex(recursiveRoot, 0),
    ),
    0n,
  );
});

Deno.test("defaults: IEEE special float defaults preserve their native bit masks", async () => {
  const { FloatDefaultsCodec } = await generated();
  const decoded = FloatDefaultsCodec.decode(
    bytes(fixture.messages.float_defaults),
  );
  assertEquals(decoded.positive, Infinity);
  assertEquals(decoded.negative, -Infinity);
  assert(Number.isNaN(decoded.notANumber));
  assert(Object.is(decoded.negativeZero, -0));
  const encoded = new MessageReader(FloatDefaultsCodec.encode(decoded));
  const root = encoded.readStructPointer(0, 0)!;
  assertBytes(
    encoded.readBytes(
      root.segmentId,
      root.startWord * 8,
      root.dataWordCount * 8,
    ),
    Array(root.dataWordCount * 8).fill(0),
  );
  const roundtrip = FloatDefaultsCodec.decode(FloatDefaultsCodec.encode({
    positive: -Infinity,
    negative: Infinity,
    notANumber: 123,
    negativeZero: 0,
  }));
  assertEquals(roundtrip.positive, -Infinity);
  assertEquals(roundtrip.negative, Infinity);
  assertEquals(roundtrip.notANumber, 123);
  assert(Object.is(roundtrip.negativeZero, 0));
});

Deno.test("evolution: incoming inline-composite stride and nested defaults follow the wire layout", async () => {
  const { EnvelopeCodec } = await generated();
  const decoded = EnvelopeCodec.decode(bytes(fixture.messages.old_envelope));
  const records = decoded.records as Record<string, unknown>[];
  assertEquals(records.length, 2);
  for (const [index, label] of ["first", "second"].entries()) {
    assertEquals(records[index].label, label);
    assertEquals(records[index].extra, "nested-default");
  }
  assertEquals((decoded.child as Record<string, unknown>).label, "third");
  assertEquals(
    (decoded.child as Record<string, unknown>).extra,
    "nested-default",
  );
  assertEquals(
    (decoded.unseen as Record<string, unknown>).extra,
    "nested-default",
  );
  assertEquals((decoded.texts as unknown[]).length, 0);
  assertBytes(decoded.bytes as Uint8Array, []);
  assertEquals((decoded.anything as { kind: string }).kind, "null");
});

Deno.test("evolution: generated RPC client decodes an older response", async () => {
  const { createEvolutionClient } = await generated();
  const client = createEvolutionClient({
    call: () => Promise.resolve(bytes(fixture.messages.old_response)),
  }, { capabilityIndex: 1 });
  const response = await client.fetch({});
  expectDefaults(response.entry);
});

Deno.test("evolution: malformed present pointers still fail decoding", async () => {
  const { CurrentCodec } = await generated();
  const message = bytes(fixture.messages.old);
  const reader = new MessageReader(message);
  const root = reader.readStructPointer(0, 0)!;
  const pointer = reader.pointerWordIndex(root, 0);
  new DataView(message.buffer).setBigUint64(
    8 + pointer * 8,
    1n | (0x1fffffn << 2n) | (2n << 32n) | (2n << 35n),
    true,
  );
  assertThrows(() => CurrentCodec.decode(message), /out of range/);
});

Deno.test("defaults: unsupported non-null aggregate defaults fail with field context", () => {
  for (
    const [name, field, kind] of [
      ["unsupported_list_default", "values", "list"],
      ["unsupported_struct_default", "child", "struct"],
    ]
  ) {
    assertThrows(
      () =>
        generateTypescriptFiles(
          parseCodeGeneratorRequest(bytes(fixture.requests[name])),
        ),
      new RegExp(
        `unsupported.*${kind}.*default.*${field}|${field}.*unsupported.*${kind}.*default`,
        "i",
      ),
    );
  }
  assert(fixture.requests.evolution_defaults.length > 0);
});
