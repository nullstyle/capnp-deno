# Interop & Performance Sprint Plan

Two-week, merge-ready sprint focused on proving that capnp-deno interoperates
with real Cap'n Proto implementations and has useful, repeatable performance
signals for the runtime hot paths.

## Summary

- Primary goal: make interop and performance confidence explicit, measured, and
  easy to rerun locally or in CI.
- Scope: tests, fixtures, benchmarks, regression gates, documentation, and
  targeted runtime optimizations backed by measurements.
- Non-goals: no new wire format, no upstream Zig changes, no public API churn,
  and no new runtime dependencies.
- Guardrail: the published runtime remains dependency-clean; optional tooling
  stays in tests, examples, codegen, and benchmark workflows.

## Current Baseline

The repo already has several useful pieces to build on:

- fixture-based RPC wire tests in `tests/fixtures/rpc_frames.ts`;
- fast wire/framer/runtime benchmarks under `bench/`;
- broad hot-path regression checks in `bench/regression_test.ts`;
- real-WASM tests in `tests/wasm/`;
- TCP real-WASM interop coverage in `tests/transports/tcp_rpc_interop_test.ts`;
- generated callback, streaming, TCP, WebSocket, WebTransport, and browser
  WebTransport coverage from recent sprints.

The sprint should strengthen and connect those pieces instead of creating a
parallel test/benchmark universe.

## Workstreams

### 1. Canonical Serialization Interop

Add deterministic fixtures that prove Deno encode/decode compatibility with
canonical Cap'n Proto bytes produced outside the TypeScript runtime.

Coverage targets:

- primitive scalars and default values;
- text/data;
- lists of primitives and structs;
- nested structs;
- unions/groups;
- far pointers and multi-segment messages;
- unknown/extra fields preservation where applicable;
- malformed/truncated fixture rejection.

Implementation notes:

- Prefer existing `capnp` CLI workflows for fixture generation.
- Keep generated fixture bytes checked in and deterministic.
- Put TypeScript tests under `tests/interop/`.
- Add a small fixture regeneration command if the workflow becomes more than a
  one-liner.

### 2. RPC Interop Matrix

Expand real TCP/WASM interop beyond bootstrap + unary call so the RPC lifecycle
is exercised across a real transport and real peer.

Coverage targets:

- bootstrap + unary call;
- cap-bearing params;
- cap-bearing results;
- client callback invocation;
- generated streaming calls;
- finish/release cleanup;
- exception returns and typed error propagation;
- answer/capability table cleanup after release/cancel.

Implementation notes:

- Prefer generated `connect()` / `serve()` for Deno-facing behavior.
- Keep raw frame tests for wire-level compatibility and lifecycle edge cases.
- Extend `tests/transports/tcp_rpc_interop_test.ts` or split a
  `tests/interop/rpc_interop_test.ts` once the matrix grows.

### 3. Performance Baselines

Expand benchmark coverage so common workloads have named, comparable signals.

Benchmark groups:

- `encoding`: generated encode/decode for representative schemas;
- `wire`: RPC frame encode/decode and cap-table-heavy calls;
- `framer`: fragmented/coalesced frames and large frames;
- `generated_rpc`: generated client call and server dispatch overhead;
- `callbacks`: export, call, release, and callback dispatch;
- `streaming`: stream sender throughput, backpressure, cancellation;
- `transport`: TCP/WebSocket/WebTransport frame pump cost;
- `real_wasm`: real peer bootstrap/call/lifecycle paths.

Implementation notes:

- Keep `bench:fast` host-only and deterministic.
- Keep `bench:real` gated on `generated/capnp_deno.wasm`.
- Avoid turning noisy browser/WebTransport numbers into default gates.

### 4. Regression Gate Polish

Make the existing regression gate easier to understand and maintain.

Changes:

- Improve failure messages with elapsed time, budget, and percentage over
  budget.
- Group output by subsystem.
- Continue writing `bench/results.json` only when explicitly requested by the
  CI/local benchmark path.
- Add a `just perf-check` alias for the blocking regression checks plus the fast
  benchmark smoke.
- Keep full benchmark comparisons out of `deno task verify`.

### 5. Targeted Optimization Pass

Only optimize after measuring.

Likely candidates:

- repeated `DataView` construction in wire/frame hot paths;
- cap-table encode/decode loops;
- frame validation traversal allocation patterns;
- generated codec allocation patterns;
- stream sender drain/queue overhead;
- debug/observability branches on hot paths when disabled.

Acceptance rule:

- Every optimization PR includes before/after numbers from the relevant bench or
  regression test.
- No optimization should weaken validation, ordering, cleanup, or dependency
  guarantees.

## Deliverables

- `docs/interop.md` describing supported interop surfaces and fixture
  regeneration.
- `docs/performance.md` describing benchmark groups, commands, and regression
  policy.
- New or expanded `tests/interop/` coverage for serialization and RPC fixtures.
- Expanded `bench/` coverage for generated RPC, callbacks, streaming, and
  transport pumps.
- Improved `bench/regression_test.ts` output.
- `just perf-check` task.
- Measured optimization commits where clear wins are found.

## Test And Gate Plan

Required:

- `deno task verify`
- `deno task test:codegen` if generated fixtures or codegen output change
- `deno task test:integration`
- `just build-wasm`
- `deno task test:real`
- `deno task bench:fast`
- `deno test --no-check --allow-env=CI --allow-write=bench/results.json --allow-run=git bench/regression_test.ts`

Conditional:

- `deno task bench:real` after WASM build changes or real-WASM benchmark work
- `mise run test:browser-webtransport` if browser/WebTransport interop or
  performance paths are touched
- `cd vendor/capnp-zig && just test` only if vendored code changes

## Acceptance Criteria

- Serialization interop fixtures prove compatibility with canonical external
  bytes, not only self-roundtrips.
- RPC interop covers capabilities, callbacks, streaming, lifecycle cleanup, and
  errors over real transport paths.
- Fast and real benchmark groups cover the main runtime hot paths.
- Regression checks fail with actionable subsystem and budget details.
- Any landed optimization has before/after evidence.
- Runtime dependency guard remains green.
- All required gates pass.

## Risks

- Cross-implementation fixture tooling may uncover schema or toolchain
  assumptions; keep fixture generation narrow and deterministic.
- Performance numbers can be noisy on laptops and CI runners; use broad
  regression budgets and trend files instead of fragile micro-thresholds.
- WebTransport/browser performance is useful but noisy; keep it opt-in.
