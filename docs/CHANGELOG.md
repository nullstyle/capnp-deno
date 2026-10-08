# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added (Experimental)

- Level-3 three-party capability handoff wrappers over the runtime's L3 exports
  (feature bit 10), behind `@nullstyle/capnp/advanced`: `mintHandoffTokens` (the
  default host-side introducer), `provideCapability` (originate a handoff across
  two peers of one module), `acceptProvision` (send an Accept and resolve the
  accepted capability's import index from the L3 event channel when its Return
  arrives), `registerThirdPartyAwait`, `sendThirdPartyAnswer`, and
  `handoffCompletionFromContact` (the recipient-side half of the default
  introducer: rebuilds the byte-identical ThirdPartyCompletion from decoded
  contact bytes). The `WasmAbi` layer gains typed bindings and export discovery
  for the five wasm exports, `WasmPeer.pushFrame` drains L3 events in pump order
  and dispatches them to `addL3EventListener` listeners, and the error metadata
  union gains `l3_*` phases.
- The TypeScript wire codec now emits and parses `thirdPartyHosted` capability
  descriptors: `RpcCapDescriptor` gains optional `vineId`/`contact` fields,
  `CAP_DESCRIPTOR_TAG_THIRD_PARTY_HOSTED` is exported, the encoder writes the
  nested `ThirdPartyCapDescriptor` (vine id plus the contact bytes as a root
  any-pointer) and rejects descriptors without contact bytes, and the decoder
  surfaces both fields. A real-wasm test drives the full recipient pipeline: the
  vine is delivered through the actual host-call bridge relay as a
  `thirdPartyHosted` descriptor, decoded on the recipient side, resolved to a
  byte-identical completion, and accepted on a third connection, resolving the
  capability placement from the Return event.
- **The VatC gap is closed: feature bit 11 (L3 vat hosting).** The vendored
  capnp-zig moves to `72d6d7f…` (main after v0.22.0), which exposes the vat-wide
  `ProvisionIndex` over the wasm ABI (`capnp_provision_index_new/free`,
  `capnp_peer_attach_provision_index/detach`). A vat represented by several
  module-local peers attaches them to one index; an inbound Provide then
  registers its provision and an inbound Accept on a sibling connection is
  served by the runtime itself — no host-forged Returns. The rebuilt artifact
  advertises feature bits 0–11 (4095; 47 exports), the reviewed ABI gates
  widened accordingly, and `WasmAbi` gains
  `createProvisionIndex`/`freeProvisionIndex`/`attachProvisionIndex`/
  `detachProvisionIndex` plus `setBootstrapStubWithId`. The autonomous
  three-party test proves the full loop: originate the Provide, register it into
  a shared index on VatC's first peer, accept on VatC's second peer, and resolve
  the capability placement from VatC's own answer. Nothing here is a Stable API.

### Added

- The runtime artifact now advertises feature bit 10: the vendored capnp-zig
  moved to tag `v0.22.0` (`9de73ba…`), whose WASM host ABI exposes the
  experimental Level-3 three-party handoff origination exports
  (`capnp_peer_send_provide`, `capnp_peer_send_accept`,
  `capnp_peer_send_third_party_answer`,
  `capnp_peer_register_pending_third_party_await`, `capnp_peer_pop_l3_event`).
  The ABI stays version 1 with no removals — the reviewed feature gate widened
  from bits 0–9 to bits 0–10 — and nothing in `@nullstyle/capnp` binds the L3
  exports yet; the Deno-side experimental wrappers remain planned (see
  [the L3 proposal](rpc_l3_wasm_abi_proposal.md)).

- Cross-file references to nested types (`:Lib.Outer.Inner`) now generate
  working output: a request-wide pre-pass marks exactly the nested declarations
  that another schema file references as exported in the owning module (under
  their flattened, disambiguated names), so importing modules lower the type
  name and descriptor through ordinary cross-file imports and enum mirrors.
  Nested declarations nobody references across files stay module-private, so
  untouched schemas generate byte-identical output. Previously such references
  failed loudly with a hoist suggestion.

### Changed

- The pinned compiler host moved from `capnp-wasm-compiler-host 0.1.0-rc.3` to
  the full `capnpc-wasm 0.1.0-rc.5` SDK package (same Cap'n Proto 2.0-dev
  frontend revision; identical standard includes; verified generated output is
  unchanged). Source schema compilation no longer requires exactly Deno 2.6.8:
  host rc.5 instruments guests with in-guest interruption checks, so timeouts
  and aborts stop the guest at its deadline on every admitted engine (verified
  on Deno 2.6.8 and 2.9.7). The pin's `denoVersion` now records only the engine
  that builds the standalone `capnpc-deno` CLI for reproducible release
  binaries. The standalone CLI embeds the full SDK package (66 files, including
  the other language generator modules, embedded as opaque bytes). The obsolete
  engine-termination-grace regression was removed with the contract it codified;
  engine `terminate()` behavior is tracked by capnp-wasm's upstream canary.

## [0.6.0] - 2026-10-07

### Added

- Schema compilation runs through the verified public capnp-wasm compiler host
  (`0.1.0-rc.3`, Cap'n Proto 2.0-dev frontend) in a bounded worker: no PATH
  `capnp`, Python, Wasmtime, or network access during ordinary generation, only
  read/write permission. Ordered import roots and source-prefix semantics are
  preserved, and output staging keeps existing files on compiler or emitter
  failure. Saved `--request-bin`, binary-stdin plugin, config, and layout modes
  remain supported; compiler acquisition is the separate `compiler:fetch` step.
- Streaming parameters are admitted by exact encoded bytes: each item is
  serialized once and its parameter-message length reserved before a transport
  assigns a question, with at most one waiting preparation candidate and a
  separate retained Call-frame byte budget on the server. Clients bound
  per-question callback records after abort, timeout, or an uncertain write via
  the new `maxOutstandingParamCapQuestions` option (default 4,096). See
  [Streaming RPC](streaming.md).
- The runtime WASM artifact now ships with a provenance receipt
  (`generated/capnp_deno.provenance.json`) recording source revision, Zig and
  Binaryen versions, optimization, hash, ABI, exports, and features;
  `deno task check:wasm` verifies it and `check:wasm-rebuild` proves an isolated
  clean rebuild reproduces the checked-in bytes.
- A standing native interop runner (`deno task test:native-interop`) builds
  source-matched Zig and C++ reference peers from the pinned vendor tree and
  checks a four-way matrix (Deno↔Zig over framed pipes, Deno↔C++ over TCP):
  unary calls, callbacks, returned capabilities, pending-call cancellation with
  Finish/Release cleanup, error recovery, streaming barriers, and
  same-capability recovery.

### Changed

- Vendored capnp-zig moved to the family's coordinated set: tag `v0.21.0`
  (commit `3490a77e1296dfd5adce6b15f60d12a37abce4d9`, up from the 0.18.0-era
  commit `295ff5e`), and the Zig pin moved from the retired
  `0.17.0-dev.1683+5ceec001b` snapshot to tagged `0.17.0` in `mise.toml` and
  [the runtime pin](../tools/runtime-toolchain.json). The rebuilt
  `generated/capnp_deno.wasm` keeps ABI version 1 with feature bits 0–9; RPC
  wire fixtures are byte-identical. `test:native-interop` passes the capnp-zig
  module to `zig build-exe` by hand, so it now supplies the
  `capnp_build_options` module that capnp-zig v0.21.0 requires on Linux/macOS;
  the local `tools/gen_rpc_fixtures` build graph creates the same options
  module.
- Source schema compilation and compiler builds require exactly Deno 2.6.8
  (worker termination was verified on that engine); the published runtime needs
  Deno 2.6+. See [Toolchains](toolchains.md) for the engine contract and the
  Windows WebTransport IPv6 endpoint requirement.
- CI and releases share one reusable validation workflow: compiler, runtime, and
  package checks on Linux x86_64/arm64, macOS x86_64/arm64, and Windows x86_64,
  native compiler binaries executed on each host, a clean Linux runtime rebuild,
  native interop, mandatory browser WebTransport, and benchmark budgets. Release
  tags must equal `v` plus the `deno.json` version.

### Fixed

- Canceled pending calls now retire with exactly one terminal Return and settle
  their callback grants once; a subsequent call succeeds on the same connection.
  Valid native `Return(canceled)` messages are accepted, bootstrap answers
  already produced by WASM are mirrored before host dispatch, and answer-table
  overflow closes instead of publishing unroutable grants.
- An ordinary failed call no longer poisons later streaming work through the
  generated server path (adopted from the reviewed native Zig generator fix).
- Wire handling now covers the observed double-far, empty-struct, and malformed
  pointer gaps: nonzero-offset double-far struct tags are rejected like WASM's
  untyped clone, UTF-8/NUL text is validated, and cyclic/amplified copies are
  rejected without settling the call or prematurely releasing parameter grants.
- WASM ownership defects: borrowed error text is no longer freed, zero-length
  output buffers no longer convert a legitimate free into `InvalidFree`, wrapper
  and serde scratch allocations have explicit disposal paths, and closing one
  wrapper preserves other users of the shared module (2,000-cycle soak tests).
- Generic transports that provide `subscribeClose` are now supervised for
  service disposal instead of only the concrete TCP/WebSocket/WebTransport
  classes; service handles detach their close subscription exactly once.

## [0.5.0] - 2026-08-15

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

### Changed

- Vendored capnp-zig bumped from v0.4.0 to v0.11.0 (upstream cut v0.4.0 on a
  red-CI commit and considers it superseded by v0.5.0). The WASM host ABI is
  unchanged (ABI version 1, feature bits 0–9); the rebuilt
  `generated/capnp_deno.wasm` carries upstream's interop and memory-safety
  fixes, including the spec-violating double release of parameter capabilities,
  a `HostPeer` teardown use-after-free, pipelined calls on failed answers
  hanging forever, and validation-CPU amplification.
- The Zig toolchain is pinned in `mise.toml` to `0.17.0-dev.1683+5ceec001b` (the
  snapshot capnp-zig v0.11.0 builds and verifies against), replacing the rolling
  `zig = "master"` pin, so WASM builds are reproducible.

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
- The session client now honors `Return.releaseParamCaps = true`: it retires the
  sender-hosted param-cap exports the call granted locally instead of waiting
  for explicit `Release` frames that, per rpc.capnp, the callee must not send.
  Against the previous runtime module the redundant `Release` is ignored;
  against the new one client-hosted callback exports no longer leak after a
  non-retaining call.

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
