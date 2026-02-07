import { type CapnpWasmExports, WasmSerde } from "../mod.ts";
import { FakeCapnpWasm } from "./fake_wasm.ts";
import { assertBytes, assertEquals, assertThrows } from "./test_utils.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
