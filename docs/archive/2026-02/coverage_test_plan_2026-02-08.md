# Coverage Improvement Plan (2026-02-08)

## Goal

Keep pushing on production-hardening by targeting branch-heavy runtime and
codegen error paths that remain under-covered after the first pass.

## Current Snapshot (Post Phase 18 Full Unit Coverage Refresh)

_Source:
`deno test --allow-read=tests/fixtures/codegen_requests/multi_schema_request.b64 tests --ignore=tests/socket_integration_test.ts,tests/real_wasm_serde_test.ts,tests/real_wasm_rpc_flow_test.ts --coverage=/tmp/capnp-deno-coverage-phase18-full` +
`deno coverage /tmp/capnp-deno-coverage-phase18-full` run on 2026-02-08._

### Full-suite headline

- All files: `91.7%` branch / `95.5%` line.

### Re-prioritized hotspots (production code)

- `tools/capnpc-deno/emitter.ts` (`80.0%` / `90.2%`)
- `tools/capnpc-deno/request_parser.ts` (`86.6%` / `92.9%`)
- `src/reconnect.ts` (`88.9%` / `90.3%`)
- `src/transports/websocket.ts` (`89.6%` / `95.1%`)
- `src/encoding/rpc_wire.ts` (`89.7%` / `94.4%`)
- `src/server_runtime.ts` (`89.7%` / `90.3%`)
- `src/reconnecting_client.ts` (`90.6%` / `97.0%`)
- `src/transports/tcp.ts` (`90.8%` / `94.5%`)

## Completed in Prior Passes

- [x] Phase 1: telemetry/observability/load
- [x] Phase 2: reconnect policy + unwind semantics
- [x] Phase 3: frame limits + server/runtime guards
- [x] Phase 4: transport edges + capnpc-deno CLI/error baseline
- [x] Phase 9: capnp_reader + transport branch hardening
- [x] Phase 10: ABI/frame-limits/rpc-wire edge branch expansion
- [x] Phase 11: serde + message_port branch matrix
- [x] Phase 12: reconnect wrapper/client branch matrix
- [x] Phase 13: rpc-wire + request_parser + emitter edge branches
- [x] Phase 14: transport/server-runtime tails
- [x] Phase 15: capnpc-deno CLI + plugin-response tails
- [x] Phase 16: rpc runtime long-tail branches
- [x] Phase 18: full-suite coverage refresh and hotspot reprioritization

## Phase 13 Outcome

- `src/encoding/rpc_wire.ts` gained decode tag-mismatch coverage, return-pointer
  null guard coverage, and bootstrap capability extraction failure-path
  coverage.
- `tools/capnpc-deno/request_parser.ts` gained parseType matrix coverage for
  scalar/reference variants and null-list fallback coverage for nested nodes,
  fields, enum/interface methods, and imports.
- `tools/capnpc-deno/emitter.ts` gained deterministic collision/fallback
  coverage (no-extension paths, type/interface suffixing, union fallback,
  unknown enum/struct descriptor defaults).

## Phase 14 Outcome

- `src/transports/websocket.ts` advanced from `81.1% / 90.7%` to `89.6% / 95.1%`
  by adding close/wait/connect edge tests, active-drain reuse coverage, and
  buffered-send ready-state transitions.
- `src/transports/tcp.ts` advanced from `82.0% / 89.3%` to `90.8% / 94.5%` by
  adding timeout-mode dial-failure coverage, success-without-timeout coverage,
  zero-byte read continuation coverage, and idempotent close checks.
- `src/rpc_server.ts` advanced from `81.8% / 87.3%` to `98.4% / 98.8%` by adding
  capability pointer lifecycle coverage plus host-call flag/default fallback
  branches.
- Fixed a production bug in timeout-mode TCP connect: `src/transports/tcp.ts`
  now clears connect timers without creating a dangling rejected promise from
  `finally()`.

## Phase 15 Outcome

- `tools/capnpc-deno/cli.ts` advanced from `78.6% / 84.8%` to `98.9% / 98.7%`
  via expanded CLI flag parsing, config-loading path resolution cases, TOML
  parser error/escape branches, schema-path mapping fallbacks, and output path
  normalization guards.
- `tools/capnpc-deno/plugin_response.ts` advanced from `80.0% / 91.0%` to
  `93.3% / 96.6%` via numeric-id normalization coverage and guarded failure-path
  tests for signed-offset and text-range validation.
- Remaining uncovered lines in both files are mostly internal guard branches not
  reachable through public APIs without invasive internal patching.

## Phase 16 Outcome

- `src/rpc_client.ts` advanced from `82.4% / 87.1%` to `98.3% / 99.6%` in the
  targeted runtime pass by adding harness waiter/abort lifecycle tests, explicit
  `finish()` path coverage, numeric `interfaceId` conversion coverage, and
  bootstrap exception propagation tests.
- `src/wasm_peer.ts` advanced from `100.0% / 76.3%` to `100.0% / 100.0%` by
  covering `fromInstance`, `popOutgoingFrame`, and `drainOutgoingFrames`.
- `src/encoding/rpc_wire.ts` advanced from `80.8% / 91.7%` to `89.4% / 94.4%` by
  adding null-root decoder matrix tests, payload null-pointer decode paths,
  non-NUL text decode coverage, finish flag variant checks, receiver-hosted
  bootstrap capability extraction, and non-struct root-pointer rejection.
- Remaining `rpc_wire.ts` misses are largely internal guard branches that are
  difficult to reach through public APIs without white-box hooks.

## Phase 18 Outcome

- Ran the full unit coverage gate after Phase 16 test additions and refreshed
  the global baseline to `91.7%` branch / `95.5%` line.
- Confirmed prior targeted gains hold in the full-suite run: `src/rpc_client.ts`
  at `98.4% / 99.6%`, `src/wasm_peer.ts` at `100.0% / 100.0%`, and
  `src/encoding/rpc_wire.ts` improved to `89.7% / 94.4%`.
- Re-ranked the next targets by branch coverage impact and implementation
  feasibility (codegen internals first, then reconnect/runtime tails).

## Next Plan Pass

### Phase 19: Codegen Internals

- Focus on `tools/capnpc-deno/emitter.ts` and
  `tools/capnpc-deno/request_parser.ts` branch-heavy fallback paths (method-name
  collision fallbacks, enum/struct default fallbacks, optional list/null text
  parse branches).

### Phase 20: Runtime Retry/Transport Tails

- Focus on `src/reconnect.ts`, `src/server_runtime.ts`, and
  `src/transports/websocket.ts` remaining branch tails (sleep/jitter/time budget
  branches, host-call-limit warning pathways, and ws error/queue edge cleanup).

### Phase 21: Optional White-Box Guards

- If needed, add white-box-only tests (or explicit test hooks) for internal
  guard branches in `src/encoding/rpc_wire.ts` and
  `tools/capnpc-deno/plugin_response.ts` that are not reachable from public
  APIs.

## Definition of Done (This Pass)

- [x] Re-run full unit coverage gate with current repository state.
- [x] Refresh hotspot ranking from latest full-suite numbers.
- [x] Keep `just ci-fast` green.
- [x] Update this plan with a new prioritized execution queue.
