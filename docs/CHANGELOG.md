# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Breaking

- capnpc-deno's generated `mod.ts` barrel now uses namespaced re-exports
  (`export * as <schemaNamespace> from "./<module>.ts";`) instead of flat
  `export * from` lines, so same-named exports across schema files cannot
  collide. Downstream code that imported names directly from a generated barrel
  must switch to the per-schema namespace (or import from the individual
  generated module). The committed `src/rpc/gen/capnp/mod.ts` artifact reflects
  this churn.
- capnpc-deno now fails loudly (`CodegenEmitError`) when a schema references a
  type NESTED inside a struct of another schema file (e.g. `:Lib.Outer.Inner`);
  such references previously emitted silently broken output (bare unimported
  type names and `undefined as unknown as` defaults). Hoist the type to the top
  level of its owning schema.

### Fixed

- capnpc-deno: cross-file imports of two schema files that share a basename in
  different directories (e.g. `a/x.capnp` and `b/x.capnp`) no longer collapse
  onto a single module; the import collector keys modules by the full schema
  path. Under `--layout flat`, same-basename schema files are now disambiguated
  by flattening their schema-relative path into the module name (`a_x_types.ts`,
  `b_x_types.ts`) instead of aborting with an output-path collision.
- capnpc-deno: cross-schema import specifiers are rewritten in a single
  simultaneous pass, so a rewritten specifier can no longer be clobbered when it
  textually equals another import's pre-rewrite specifier.
- capnpc-deno: the generated barrel sanitizes the strict-mode-restricted
  identifiers `eval` and `arguments` (emitted as `eval$` / `arguments$`).

## [0.4.0] - 2026-07-11

### Added

- Server handlers can retain a call's parameter capabilities past dispatch: call
  the new `ctx.retainParamCaps()` (or return an explicit
  `releaseParamCaps: false`) and the Return carries `releaseParamCaps: false`,
  the WASM relay keeps the capability alive instead of releasing it, and the
  handler releases it later via `outboundClient.release(...)` when done. This
  unblocks the "register a client-hosted sink, stream into it after returning"
  pattern. Requires a runtime module with host-call param-cap retention
  (`WasmAbiCapabilities.hasHostCallParamCapRetention`, feature bit
  `WASM_FEATURE_HOST_CALL_PARAM_CAP_RETENTION`); the bridge fails the call
  loudly when a handler requests retention on a module that cannot honor it.

### Fixed

- The WASM relay released a host call's parameter capabilities as soon as the
  call was queued — before the handler even ran — sending the client a premature
  `Release` that destroyed client-hosted callback exports the moment their
  registering call completed (subsequent server-originated calls failed with
  unknown-capability errors). Param caps now stay alive until the host answers;
  non-retaining handlers keep the existing contract (an explicit `Release`
  spends the reference), just at Return time instead of dispatch time.
- `RpcWireClient.finish` no longer defaults to releasing result capabilities for
  questions whose Return carried cap-table entries, matching the
  session-transport fix from 0.3.0: generated stubs auto-finish through this
  path, and the old `releaseResultCaps: true` default destroyed every fresh
  capability a server returned before the caller could use it. An explicit
  `releaseResultCaps` still wins.

## [0.1.0] - 2026-07-11

### Breaking

- Restructured the package for the `src/`-based layout and split entrypoints.
  Published versions `<= 0.0.2` are a different, pre-reorg API generation and
  are not compatible with this release.
- Package exports are now `.`, `./encoding`, `./rpc`, and `./advanced`; the
  legacy `./codegen_runtime` export no longer exists.
- The wire-level `MessageBuilder` exported from the root entrypoint is renamed
  to `RpcWireMessageBuilder`; the `@nullstyle/capnp/encoding` `MessageBuilder`
  used by generated code is unchanged.
- The `./encoding` entrypoint no longer exports internal helpers (bit-mask
  constants such as `MASK_29`, the shared `TEXT_ENCODER`/`TEXT_DECODER`
  singletons, and `as*` coercion utilities such as `asString`).

### Added

- `@nullstyle/capnp/advanced` entrypoint exposing low-level WASM APIs
  (`WasmAbi`, `WasmPeer`, `instantiatePeer`, `getCapnpWasmExports`, `WasmSerde`,
  `createRuntimePeer`, `getRuntimeWasmExports`).
- `LICENSE` file at the repository root, shipped with the published package.
- Stats snapshots across the stack: `transport.stats` for byte transports and
  `MessagePortTransport`, `RpcSession.stats`, client adapter `stats`,
  `RpcServerBridge.stats`, and enriched `RpcConnectionPool.stats`.
- Schema-first getting started guides:
  - `docs/getting_started_serde.md`
  - `docs/getting_started_rpc.md`
- Local ABI pointer document:
  - `docs/wasm_host_abi.md` -> `vendor/capnp-zig/docs/wasm_host_abi.md`
- Docs index:
  - `docs/README.md`
- First-class generated RPC streaming support for Cap'n Proto `-> stream`
  methods, including typed `create<Interface><Method>StreamSender(...)` helpers.
- Generated Ping/Ponger and streaming examples covering TCP and WebSocket golden
  paths.
- MessagePort generated RPC integration coverage for callbacks and streaming.
- Generated RPC diagnostics:
  - `createRpcDebugTracer(...)`
  - `formatRpcDebugEvent(...)`
  - schema-aware frame labels such as `rpc=Pinger.ping`
  - `docs/diagnostics.md`
- Streaming reliability docs:
  - `docs/streaming.md`
  - explicit `StreamSender` backpressure, state, and cancellation guidance
- Browser/WebTransport hardening helpers:
  - `getWebTransportRuntimeSupport()`
  - `createWebTransportCertificateHash(...)`
  - `createWebTransportCertificateHashOptions(...)`
  - opt-in `mise run test:browser-webtransport`
- Runtime dependency surface guard that fails if published `src/**/*.ts` starts
  importing npm/jsr/node/http or bare package specifiers.
- Release checklist:
  - `docs/release_checklist.md`
  - `just release-check`
  - `just publish-dry-run`

### Changed

- Runtime module loading now uses Deno static WASM imports for app-facing
  factories.
- RPC codegen now emits additional typed helpers:
  - `bootstrap<Interface>Client(...)`
  - `register<Interface>Server(...)`
- RPC codegen now emits JSDoc for generated high-level clients, servers,
  callback-capable parameters, and stream sender helpers.
- RPC codegen now emits typed `SessionError` / `ProtocolError` failures with
  structured metadata for generated callback, streaming, and dispatch paths.
- `connect()` and `serve()` now accept an opt-in `debug` tracer option for
  redacted generated RPC frame summaries.
- RPC codegen now fails fast when interface methods reference unknown
  param/result structs (instead of generating late-bound `unknown` fallbacks).
- `RpcServerRuntime` now allows host-call dispatch to complete asynchronously so
  `Finish(requireEarlyCancellation)` can abort `RpcCallContext.signal` while a
  generated streaming handler is still pending.
- `StreamSender` now exposes `waitForCapacity()`, `state`, and `maxInFlight`
  while preserving existing `send()` / `flush()` / `cancel()` behavior.
- `WebTransportTransport` now validates `https:` client URLs, normalizes
  listener paths, reports listener upgrade/path/first-stream failures through
  `onConnectionError` and observability, and rejects queued/in-flight sends when
  sessions close.
- Documentation cleanup:
  - removed historical planning/progress docs from the repository
  - refreshed `docs/capnp_zig_additions.md` to current submodule revision.

### Fixed

- Removed stale top-level doc references to missing ABI docs by adding a stable
  local pointer file.
- Fixed local `just ci-integration` so it runs the existing socket integration
  gate.
- `RpcWireClient` now sends best-effort early-cancel `Finish` frames when a
  pending call aborts or times out.
- `StreamSender.cancel()` now keeps draining accepted calls after cancellation
  so in-flight counters are cleared before cancellation completes.
