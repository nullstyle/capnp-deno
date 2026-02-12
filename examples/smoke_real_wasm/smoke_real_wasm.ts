import { instantiatePeer, WasmSerde } from "../../src/advanced.ts";

const wasmPath = new URL("../../generated/capnp_deno.wasm", import.meta.url);

interface Person {
  name: string;
  age: number;
  email: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const { instance, peer } = await instantiatePeer(wasmPath, {}, {
  expectedVersion: 1,
  requireVersionExport: true,
});

try {
  const serde = WasmSerde.fromInstance(instance, {
    expectedVersion: 1,
    requireVersionExport: true,
  });

  const codec = serde.createJsonCodec<Person>({
    toJsonExport: "capnp_example_person_to_json",
    fromJsonExport: "capnp_example_person_from_json",
  });

  const expected: Person = {
    name: "Smoke Test",
    age: 42,
    email: "smoke@example.com",
  };

  const encoded = codec.encode(expected);
  assert(encoded.byteLength > 0, "expected non-empty encoded message");

  const decoded = codec.decode(encoded);
  assert(decoded.name === expected.name, "name roundtrip mismatch");
  assert(decoded.age === expected.age, "age roundtrip mismatch");
  assert(decoded.email === expected.email, "email roundtrip mismatch");

  console.log("smoke_real_wasm: ok");
} finally {
  peer.close();
}
