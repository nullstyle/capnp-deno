# Repository instructions

capnp-deno (`@nullstyle/capnp`) provides TypeScript serialization and RPC backed
by a Zig-built WASM peer. `capnpc-deno` is its schema-to-TypeScript generator;
it runs the separately pinned capnp-wasm compiler host. The compiler is a
build-time dependency and is excluded from the published runtime.

## Toolchains and validation

**Read [docs/toolchains.md](docs/toolchains.md) when changing compiler
integration, WASM builds, artifact acquisition, installed binaries, or release
validation.** It defines the two artifact contracts, permissions, version
requirements, and maintenance-only native tools. Pins live in
`tools/compiler_toolchain.json`, `tools/runtime-toolchain.json`, and
`mise.toml`.

Use `mise exec -- deno` for repository tasks. Source compilation and compiler
builds require exactly Deno 2.6.8 because worker termination was verified on
that engine version. Runtime consumers require Deno 2.6+.

Acquire compiler assets with `deno task compiler:fetch` before generation or
compiler validation. Normal source generation runs with read/write permission;
acquisition is the separate network step. Missing or corrupt artifacts must fail
clearly. Keep compiler assets out of runtime imports and package contents.

Use the task definitions in `deno.json` as the command reference:

- `verify` checks formatting without rewriting, lint, runtime integrity, types,
  generated artifacts, and unit tests.
- `test:unit` includes generated/lifecycle checks using the checked-in WASM.
- `test:real` exercises that artifact; rebuild only when source or toolchain
  inputs change.
- `check:wasm-rebuild` proves the pinned clean source rebuild matches the
  checked-in WASM and provenance.
- Run socket and real-WASM tests when changing framing, session pumping,
  capability ownership, or transport lifecycle. Run browser WebTransport when
  its lifecycle changes.
- `check:package`, `check:compiler-binary`, and `check:compiler-install`
  exercise isolated package, executable, and installation consumers.
  `.github/workflows/validation.yml` is the shared CI/release gate; a local run
  does not establish unexecuted native-platform acceptance.

When changing vendor code, run the relevant tests in its canonical repository.
Keep the reviewed submodule advance separate from TypeScript/runtime behavior
changes. RPC schema generation uses `deno task codegen:rpc`; native wire fixture
regeneration uses `just regen-rpc-fixtures`.

## Architecture and ownership

Public entrypoints are `src/mod.ts`, `src/rpc.ts`, `src/encoding.ts`, and
`src/advanced.ts`. Keep public runtime imports relative and dependency-clean.
Advanced exports expose low-level ABI, peer, and serde controls.

The compiler path is:

```text
schema files → bounded workspace snapshot → verified compiler worker
             → CodeGeneratorRequest → existing TS parser/emitter
             → *_types.ts, *_meta.ts, namespaced barrel
```

`tools/capnpc-deno/workspace.ts` owns permitted files and ordered import roots;
`compiler.ts` owns the verified worker. Preserve saved requests, stdin plugin
mode, layout/config semantics, and failure-safe output staging when changing
this seam.

The RPC path is `RpcSession` → `WasmPeer`, with transport adapters below and
client/server helpers above. `RpcServerRuntime` pumps host calls through
`RpcServerBridge`; the bridge owns dispatch registrations and answer holds.
`service.ts` owns service lifetime and close subscriptions.

**Invariant:** after each inbound frame, drain outbound frames in order before
processing the next. Preserve ownership boundaries: borrowed error text, owned
outputs with exact lengths, wrapper scratch, peer handles, and shared module
state have different lifetimes. Streaming parameter-byte admission and server
retained Call-frame budgets also have different accounting scopes; see
[docs/streaming.md](docs/streaming.md).

## Changes and regression evidence

- Use strict TypeScript, snake_case filenames, `#private` fields, named
  functions where practical, and explicit types on exported surfaces.
- Keep Node-specific types such as `Buffer` out of runtime APIs.
- Use the project's custom error hierarchy for library failures.
- Public APIs need JSDoc with `@param`, `@returns`, and `@example`.
- Format changed files with `deno fmt`; `verify` is the non-mutating gate.
- Use `tests/fake_wasm.ts` for host control flow. ABI ownership, binary
  compatibility, and native interop regressions need the real boundary.
- Generated fixtures come from their schemas or saved requests. Review output
  drift before updating intentional golden hashes.
- Use scoped Conventional Commits, including the behavior and relevant
  verification. Keep vendor changes, host fixes, compiler integration, and
  generated output reviewable. Create intentional commits, never `bd:backup`.
- PR descriptions record permissioned test modes and artifact/fixture updates.
