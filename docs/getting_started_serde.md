# capnp-deno Serde Getting Started

Updated: 2026-02-08

This guide is schema-first:

1. Write a `.capnp` schema.
2. Generate TypeScript codecs.
3. Use generated `StructCodec` values for binary encode/decode.
4. Optionally use advanced `WasmSerde` for JSON bridging.

## Prerequisites

- Install `capnp` and ensure it is on `PATH`.
- Deno runtime.

## 1. Write A Schema

Create `schema/person.capnp`:

```capnp
@0x9c9e5ec72c9f6a21;

struct Person {
  id @0 :UInt64;
  name @1 :Text;
  age @2 :UInt32;
}
```

## 2. Generate TypeScript Codecs

```sh
deno task codegen generate --schema schema/person.capnp --out generated
```

This generates files like:

- `generated/schema/person_capnp.ts`
- `generated/schema/person_meta.ts`
- `generated/schema/person_rpc.ts`
- `generated/mod.ts`

## 3. Use Generated Binary Serde (Primary Path)

```ts
import { type Person, PersonCodec } from "../generated/schema/person_capnp.ts";

const input: Person = {
  id: 123n,
  name: "Alice",
  age: 42,
};

const bytes = PersonCodec.encode(input);
const decoded = PersonCodec.decode(bytes);

console.log(bytes.byteLength);
console.log(decoded);
```

## 4. Optional: JSON Bridge Via Runtime Serde

Use this when you need JSON interop against runtime serde exports.

Build the runtime module first:

```sh
just build-wasm
```

Then use `WasmSerde` from `advanced.ts`:

```ts
import * as runtimeWasmExports from "../generated/capnp_deno.wasm";
import { WasmSerde } from "../advanced.ts";

const serde = WasmSerde.fromExports(runtimeWasmExports, {
  expectedVersion: 1,
  requireVersionExport: true,
});
const person = serde.createJsonCodecFor<{
  name: string;
  age: number;
  email: string;
}>({
  key: "example_person",
});

const bytes = serde.encodeFromJson(
  "capnp_example_person_from_json",
  '{"name":"Alice","age":42,"email":"alice@example.com"}',
);
const json = serde.decodeToJson("capnp_example_person_to_json", bytes);
const typed = person.decode(bytes);
```

## 5. Error Handling Pattern

- Generated codecs throw on malformed binary payloads.
- `WasmSerde` throws typed ABI/protocol errors when exports are missing or the
  runtime rejects input.

```ts
try {
  serde.encodeFromJson("capnp_example_person_from_json", '{"name":true}');
} catch (error) {
  console.error("serde failed:", error);
}
```

## Notes

- For app development, prefer generated binary codecs first.
- Keep `WasmSerde` for JSON bridge/debug/snapshot use cases.
- For direct WASM instance/export control, use `WasmSerde` from `advanced.ts`.
