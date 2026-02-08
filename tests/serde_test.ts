import { type CapnpWasmExports, WasmSerde } from "../advanced.ts";
import { FakeCapnpWasm } from "./fake_wasm.ts";
import { assertBytes, assertEquals, assertThrows } from "./test_utils.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function asInstance(exports: unknown): WebAssembly.Instance {
  return {
    exports: exports as WebAssembly.Exports,
  } as unknown as WebAssembly.Instance;
}

function makeSerdeFixture(): {
  fake: FakeCapnpWasm;
  serde: WasmSerde;
  freed: Array<{ ptr: number; len: number }>;
} {
  const freed: Array<{ ptr: number; len: number }> = [];
  const state: { fake: FakeCapnpWasm | null } = { fake: null };

  const extraExports: Record<string, unknown> = {
    capnp_buf_free: (ptr: number, len: number) => {
      freed.push({ ptr, len });
    },
    capnp_test_echo_to_json: (
      inputPtr: number,
      inputLen: number,
      outPtrPtr: number,
      outLenPtr: number,
    ) => {
      const fake = state.fake;
      if (!fake) throw new Error("fake wasm state is unavailable");
      const input = fake.readBytes(inputPtr, inputLen);
      const text = decoder.decode(input);
      const json = JSON.stringify({ text });
      const encoded = encoder.encode(json);
      const outPtr = fake.allocBytes(encoded);
      fake.writeU32(outPtrPtr, outPtr);
      fake.writeU32(outLenPtr, encoded.byteLength);
      return 1;
    },
    capnp_test_echo_from_json: (
      inputPtr: number,
      inputLen: number,
      outPtrPtr: number,
      outLenPtr: number,
    ) => {
      const fake = state.fake;
      if (!fake) throw new Error("fake wasm state is unavailable");
      const input = fake.readBytes(inputPtr, inputLen);
      const raw = decoder.decode(input);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (_err) {
        fake.failWithError(401, "invalid json");
        return 0;
      }
      if (
        typeof parsed !== "object" || parsed === null ||
        typeof (parsed as { text?: unknown }).text !== "string"
      ) {
        fake.failWithError(402, "missing text field");
        return 0;
      }
      const text = (parsed as { text: string }).text;
      const encoded = encoder.encode(text);
      const outPtr = fake.allocBytes(encoded);
      fake.writeU32(outPtrPtr, outPtr);
      fake.writeU32(outLenPtr, encoded.byteLength);
      return 1;
    },
  };

  state.fake = new FakeCapnpWasm({ extraExports });
  const fake = state.fake;
  const serde = WasmSerde.fromExports(
    fake.exports as CapnpWasmExports & Record<string, unknown>,
  );
  return { fake, serde, freed };
}

Deno.test("WasmSerde bridges binary<->json exports and frees output buffers", () => {
  const { serde, freed } = makeSerdeFixture();

  const json = serde.decodeToJson(
    "capnp_test_echo_to_json",
    encoder.encode("hello"),
  );
  assertEquals(json, '{"text":"hello"}');

  const bytes = serde.encodeFromJson(
    "capnp_test_echo_from_json",
    '{"text":"world"}',
  );
  assertBytes(bytes, Array.from(encoder.encode("world")));

  assertEquals(freed.length, 2, "expected one free per serde output");
});

Deno.test("WasmSerde.createJsonCodec encodes/decodes typed objects", () => {
  const { serde } = makeSerdeFixture();
  const codec = serde.createJsonCodec<{ text: string }>({
    toJsonExport: "capnp_test_echo_to_json",
    fromJsonExport: "capnp_test_echo_from_json",
  });

  const outBytes = codec.encode({ text: "abc" });
  assertBytes(outBytes, Array.from(encoder.encode("abc")));

  const outObj = codec.decode(encoder.encode("xyz"));
  assertEquals(outObj.text, "xyz");
});

Deno.test("WasmSerde discovers serde export pairs and creates codecs by key", () => {
  const { serde } = makeSerdeFixture();

  const bindings = serde.listJsonCodecs();
  assertEquals(bindings.length, 1);
  assertEquals(bindings[0].key, "test_echo");
  assertEquals(bindings[0].toJsonExport, "capnp_test_echo_to_json");
  assertEquals(bindings[0].fromJsonExport, "capnp_test_echo_from_json");

  const codec = serde.createJsonCodecFor<{ text: string }>({
    key: "test_echo",
  });
  const outBytes = codec.encode({ text: "abc" });
  assertBytes(outBytes, Array.from(encoder.encode("abc")));
});

Deno.test("WasmSerde surfaces missing export and wasm-side errors", () => {
  const { serde } = makeSerdeFixture();

  assertThrows(
    () => serde.decodeToJson("capnp_missing_export", new Uint8Array([0x01])),
    /missing wasm serde export/,
  );

  assertThrows(
    () => serde.encodeFromJson("capnp_test_echo_from_json", "{bad json"),
    /invalid json/,
  );

  assertThrows(
    () => serde.createJsonCodecFor<{ text: string }>({ key: "missing" }),
    /missing wasm serde codec exports/,
  );
});

Deno.test("WasmSerde.fromInstance discovers sorted codec bindings and skips incomplete pairs", () => {
  const state: { fake: FakeCapnpWasm | null } = { fake: null };
  state.fake = new FakeCapnpWasm({
    extraExports: {
      capnp_zeta_to_json: () => 1,
      capnp_zeta_from_json: () => 1,
      capnp_alpha_to_json: () => 1,
      capnp_alpha_from_json: () => 1,
      capnp_orphan_to_json: () => 1,
      capnp_non_function_from_json: 1,
    },
  });
  const fake = state.fake;

  const serde = WasmSerde.fromInstance(asInstance(fake.exports));
  const bindings = serde.listJsonCodecs();
  assertEquals(bindings.length, 2);
  assertEquals(bindings[0].key, "alpha");
  assertEquals(bindings[1].key, "zeta");
});

Deno.test("WasmSerde.createJsonCodec exposes json passthrough helpers and stringify guard", () => {
  const { serde } = makeSerdeFixture();
  const codec = serde.createJsonCodec<{ text: string }>({
    toJsonExport: "capnp_test_echo_to_json",
    fromJsonExport: "capnp_test_echo_from_json",
  });

  const encoded = codec.encodeJson('{"text":"via-json"}');
  assertBytes(encoded, Array.from(encoder.encode("via-json")));
  const decoded = codec.decodeToJson(encoder.encode("roundtrip"));
  assertEquals(decoded, '{"text":"roundtrip"}');

  assertThrows(
    () => codec.encode(undefined as unknown as { text: string }),
    /JSON\.stringify returned undefined/i,
  );
});

Deno.test("WasmSerde handles zero-length IO and surfaces alloc/output bounds failures", () => {
  const state: { fake: FakeCapnpWasm | null } = { fake: null };
  state.fake = new FakeCapnpWasm({
    extraExports: {
      capnp_zero_from_json: (
        _inputPtr: number,
        _inputLen: number,
        outPtrPtr: number,
        outLenPtr: number,
      ) => {
        const fake = state.fake!;
        fake.writeU32(outPtrPtr, 0);
        fake.writeU32(outLenPtr, 0);
        return 1;
      },
      capnp_bounds_from_json: (
        _inputPtr: number,
        _inputLen: number,
        outPtrPtr: number,
        outLenPtr: number,
      ) => {
        const fake = state.fake!;
        const memLen = fake.memory.buffer.byteLength;
        fake.writeU32(outPtrPtr, memLen - 1);
        fake.writeU32(outLenPtr, 16);
        return 1;
      },
    },
  });
  const serde = WasmSerde.fromExports(
    state.fake.exports as CapnpWasmExports & Record<string, unknown>,
  );

  const zero = serde.encodeFromJson("capnp_zero_from_json", "");
  assertEquals(zero.byteLength, 0);

  assertThrows(
    () => serde.encodeFromJson("capnp_bounds_from_json", "{}"),
    /invalid wasm serde output bounds/i,
  );

  // With the shared-codec scratch buffer, alloc failure now surfaces
  // during WasmSerde construction (scratch pair alloc), not at call time.
  const allocFail = new FakeCapnpWasm({
    extraExports: {
      capnp_alloc: () => 0,
      capnp_zero_from_json: () => 1,
    },
  });
  assertThrows(
    () =>
      WasmSerde.fromExports(
        allocFail.exports as CapnpWasmExports & Record<string, unknown>,
      ),
    /capnp_alloc failed/i,
  );
});

Deno.test("WasmSerde encodeInto handles multi-byte UTF-8 strings correctly", () => {
  const { serde } = makeSerdeFixture();

  // Multi-byte UTF-8 characters: emoji (4-byte), CJK (3-byte), accented (2-byte)
  const multiByteJson = '{"text":"hello \\u4e16\\u754c \\u00e9"}';
  const bytes = serde.encodeFromJson(
    "capnp_test_echo_from_json",
    multiByteJson,
  );
  // The fake echo export returns the text field as raw bytes
  const decoded = decoder.decode(bytes);
  // Verify the multi-byte characters survived the encodeInto round-trip
  assertEquals(decoded, "hello \u4e16\u754c \u00e9");
});

Deno.test("WasmSerde decodeToJson reads directly from WASM memory for multi-byte output", () => {
  const { serde } = makeSerdeFixture();

  // Input bytes that become multi-byte UTF-8 in the JSON output
  const input = encoder.encode("caf\u00e9");
  const json = serde.decodeToJson("capnp_test_echo_to_json", input);
  assertEquals(json, '{"text":"caf\u00e9"}');
});

Deno.test("WasmSerde scratch pair buffer is reused across multiple calls", () => {
  const { serde, freed } = makeSerdeFixture();

  // Perform multiple encode/decode cycles to exercise scratch reuse
  for (let i = 0; i < 5; i++) {
    const json = serde.decodeToJson(
      "capnp_test_echo_to_json",
      encoder.encode(`iter${i}`),
    );
    assertEquals(json, `{"text":"iter${i}"}`);

    const bytes = serde.encodeFromJson(
      "capnp_test_echo_from_json",
      `{"text":"round${i}"}`,
    );
    assertBytes(bytes, Array.from(encoder.encode(`round${i}`)));
  }

  // Each call should have freed its output buffer
  assertEquals(freed.length, 10, "expected one free per serde call");
});

Deno.test("WasmSerde codec roundtrip with encodeInto and direct decode", () => {
  const { serde } = makeSerdeFixture();
  const codec = serde.createJsonCodec<{ text: string }>({
    toJsonExport: "capnp_test_echo_to_json",
    fromJsonExport: "capnp_test_echo_from_json",
  });

  // Test with various string sizes to exercise encodeInto allocation
  const testCases = [
    "",
    "a",
    "hello world",
    "x".repeat(1000),
    "multi-byte: \u00e9\u4e16\u754c",
    '{"nested":"json"}',
  ];

  for (const text of testCases) {
    const encoded = codec.encode({ text });
    const decoded = codec.decode(encoded);
    assertEquals(decoded.text, text);
  }
});
