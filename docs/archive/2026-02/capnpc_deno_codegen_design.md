# capnpc-deno Codegen Design

Updated: 2026-02-07 Status: Phase 1 underway (binary struct codec foundation
landed)

## Goal

Provide first-class Cap'n Proto ergonomics for Deno:

- typed struct/enum/union/list APIs,
- typed RPC client/server stubs,
- binary-first encode/decode,
- no JSON dependency for core application flows.

## Problem With Current JSON-Centric Serde

Current `WasmSerde` APIs are useful for bootstrapping but have long-term limits:

- 64-bit number precision ambiguity in JSON,
- no direct representation for capabilities and pointer-heavy data,
- extra allocation/parse overhead,
- mismatch with Cap'n Proto's binary-native model.

JSON should remain optional tooling (debug, fixtures, snapshots), not core
runtime.

## Design Options

## Option A: Binary-First Generated Code (Recommended)

- `capnpc-deno` generates TypeScript that reads/writes Cap'n Proto wire format
  directly.
- Generated code targets `@capnp/deno` runtime primitives.
- JSON helpers are optional side outputs.

Pros:

- best runtime performance,
- strongest type safety,
- lowest runtime surprises.

Cons:

- larger generator/runtime implementation effort.

## Option B: WASM Handle API

- Host manipulates opaque handles via ABI calls (`new_msg`, `set_field`, etc.).

Pros:

- keeps logic in Zig.

Cons:

- very chatty ABI, hard to optimize, harder DX.

## Option C: Descriptor-Driven Generic Runtime

- Generator emits compact descriptors; runtime interprets descriptors
  dynamically.

Pros:

- smaller generated output.

Cons:

- less static safety, higher runtime overhead.

## Recommendation

Adopt Option A for GA, keep optional JSON helper generation for debugging.

## Proposed Generated Output Layout

Input:

- `foo.capnp`

Output:

- `generated/foo_capnp.ts` (types + binary codecs + constants)
- `generated/foo_rpc.ts` (interfaces, client/server stubs if interfaces exist)
- `generated/foo_meta.ts` (schema IDs, fingerprints, optional serde map)
- `generated/mod.ts` (barrel export)

## Proposed Runtime Surface (Library Side)

- `StructCodec<T>`: `encode(value: T): Uint8Array`, `decode(bytes): T`
- `RpcClientTransport`: request/response integration atop `RpcSession`
- `CapabilityRef<T>` abstractions for interface pointers
- low-level wire helpers exposed for generated code, not hand-authored app code

## Generated API Shape (Examples)

## Struct + Enum + Union

```ts
// generated/addressbook_capnp.ts
export namespace AddressBook {
  export interface Person {
    id: bigint; // UInt64 -> bigint
    name: string; // Text
    email?: string | null; // pointer optionality
    phones: PhoneNumber[]; // list
    employment:
      | { tag: "unemployed" }
      | { tag: "employer"; value: string }
      | { tag: "school"; value: string };
  }

  export type PhoneType = "mobile" | "home" | "work";

  export interface PhoneNumber {
    number: string;
    type: PhoneType;
  }

  export const PersonCodec: StructCodec<Person>;
  export const PhoneNumberCodec: StructCodec<PhoneNumber>;
}
```

## RPC Client + Server Stubs

```ts
// generated/calculator_rpc.ts
export namespace Calculator {
  export interface EvalParams {
    expression: string;
  }
  export interface EvalResults {
    value: number;
  }

  export interface Client {
    eval(params: EvalParams, opts?: CallOptions): Promise<EvalResults>;
  }

  export interface Server {
    eval(params: EvalParams, ctx: CallContext): Promise<EvalResults>;
  }

  export function createClient(cap: CapabilityRef<Client>): Client;
  export function createServer(server: Server): CapabilityRef<Client>;
}
```

## Capability Field Typing

- interface fields generate `CapabilityRef<MyService.Client>` or nullable
  variant.
- lists of interfaces generate `CapabilityRef<MyService.Client>[]`.

## Naming and Mapping Rules

- File base: `<schema>_capnp.ts`, `<schema>_rpc.ts`.
- Struct names: `UpperCamelCase`.
- Field names: `lowerCamelCase` from schema names.
- Union fields: discriminated union `{ tag, value? }`.
- Integers:
  - `UInt64/Int64` -> `bigint`
  - smaller ints -> `number`
- Data -> `Uint8Array`
- Void -> `undefined` (or omitted member for union arms).

## CLI / Plugin Contract

## Plugin Mode

Use Cap'n Proto plugin protocol:

```sh
capnp compile -I . -o capnpc-deno:generated schema/foo.capnp
```

## Direct CLI Mode

```sh
deno task codegen generate \
  --src schema \
  --out generated \
  --layout schema
```

Current CLI ergonomics in this repo:

- `generate` subcommand (also accepts legacy `--schema` mode without the
  subcommand),
- recursive schema discovery via `--src`,
- output layouts via `--layout schema|flat`,
- generated `mod.ts` barrel by default (disable with `--no-barrel`),
- optional `--plugin-response` mode to emit `CodeGeneratorResponse` bytes on
  stdout,
- `capnpc-deno.toml` config support (`src`, `out_dir`, `import_paths`, `layout`,
  `emit_barrel`, `plugin_response`) with precedence `CLI > config > defaults`,
- plugin-compatible stdin mode by passing positional out-dir,
- implicit plugin-mode defaults for `capnp compile -o <plugin>:<out>` invocation
  (no args + stdin request => output to `.` with quiet logs and config
  disabled).

## Integration With capnp-zig

`capnpc-deno` should consume one of:

1. CodeGeneratorRequest directly via plugin protocol, or
2. Metadata emitted by `capnp-zig` for wasm serde/rpc symbol maps.

For this repo's roadmap, prefer direct CodeGeneratorRequest handling so TS
codegen does not depend on Zig runtime symbol naming details.

## Backward Compatibility and Migration

- Keep current `WasmSerde` JSON APIs as `legacy` path.
- Add generated binary codecs first; mark JSON helpers as optional.
- Encourage migration by generating both APIs during transition:
  - `PersonCodec.encode/decode` (primary)
  - optional `PersonJsonCodec` (debug-only).

## Delivery Plan

## Phase 1: Types + Binary Struct Codecs

- structs/enums/unions/lists/constants
- roundtrip tests per schema fixture

Current implementation status in this repo:

- implemented: direct `CodeGeneratorRequest` parsing + TypeScript generation
  with binary `StructCodec.encode/decode` for primitive, enum, text/data, list,
  nested struct, union/group, interface pointer, and anyPointer (null/interface)
  fields, far-pointer decode support (single-far + double-far), optional
  `--plugin-response` stdout output, `_meta.ts` reflection emit, `_rpc.ts`
  client + server-dispatch emit, payload-capable session transport, lifecycle
  hooks (`finish`/`release`), and a host callback bridge runtime contract.
- still in progress: capability-rich payload/cap-table semantics, deeper promise
  pipelining, and full bridge/ABI parity with upstream `capnp-zig`.

## Phase 2: RPC Client Stubs

- typed params/results
- capability call lifecycle with `RpcSession`

## Phase 3: RPC Server Stubs

- handler registration
- capability export/release semantics

## Phase 4: Optional JSON Helper Emit

- debug/snapshot use only

## Test Strategy

- Golden tests for generated TS output.
- Compile-time tests (`deno check`) on generated fixtures.
- Runtime roundtrip tests using deterministic binary fixtures.
- RPC interop tests against real wasm peer and fixture protocol flows.

## Open Questions

- Final `capnp-zig` host callback ABI mapping for inbound capability calls.
- Promise pipelining API shape in generated client stubs.
- How much reflection metadata to emit by default vs opt-in.
