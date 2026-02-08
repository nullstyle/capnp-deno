import { instantiatePeer, WasmSerde } from "../mod.ts";
import { assert, assertEquals, assertThrows } from "./test_utils.ts";

const wasmPath = new URL(
  "../generated/capnp_deno.wasm",
  import.meta.url,
);

Deno.test("real wasm Person serde roundtrip", async () => {
  const { instance, peer } = await instantiatePeer(wasmPath, {}, {
    expectedVersion: 1,
    requireVersionExport: true,
  });

  try {
    const serde = WasmSerde.fromInstance(instance, {
      expectedVersion: 1,
      requireVersionExport: true,
    });
    const codec = serde.createJsonCodec<{
      name: string;
      age: number;
      email: string;
    }>({
      toJsonExport: "capnp_example_person_to_json",
      fromJsonExport: "capnp_example_person_from_json",
    });

    const value = {
      name: "Alice",
      age: 42,
      email: "alice@example.com",
    };
    const bytes = codec.encode(value);
    assert(bytes.byteLength > 0, "expected non-empty encoded frame");

    const decoded = codec.decode(bytes);
    assertEquals(decoded.name, value.name);
    assertEquals(decoded.age, value.age);
    assertEquals(decoded.email, value.email);

    const json = codec.decodeToJson(bytes);
    assert(json.includes('"name":"Alice"'), "expected name in json");
  } finally {
    peer.close();
  }
});

Deno.test("real wasm Person serde surfaces invalid json", async () => {
  const { instance, peer } = await instantiatePeer(wasmPath, {}, {
    expectedVersion: 1,
    requireVersionExport: true,
  });

  try {
    const serde = WasmSerde.fromInstance(instance, {
      expectedVersion: 1,
      requireVersionExport: true,
    });
    assertThrows(
      () =>
        serde.encodeFromJson(
          "capnp_example_person_from_json",
          '{"name":true}',
        ),
      /invalid|Unexpected|Missing|Type/i,
    );
  } finally {
    peer.close();
  }
});
