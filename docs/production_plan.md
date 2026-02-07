# capnp-deno Production Plan

Updated: 2026-02-07

## Goal

Ship a production-ready Deno package that uses `capnp-zig` WebAssembly as the
protocol core, with stable APIs, strong failure behavior, and repeatable interop
coverage.

## Current Baseline

- Typed ABI wrapper exists (`src/abi.ts`) with version check support.
- Peer/session pump is implemented (`src/wasm_peer.ts`, `src/session.ts`).
- Transport adapters exist for `MessagePort`, `WebSocket`, and TCP.
- Real-WASM smoke, serde, and RPC fixture tests exist.
- Root `Justfile` verification gates exist; hosted CI wiring and release
  automation are not defined yet.

## Definition Of Done

- Stable public API with documented semver policy and deprecation rules.
- Deterministic behavior under malformed input, disconnects, and backpressure.
- Cross-language interop is a hard CI gate for every release candidate.
- Performance and resource limits are measured and enforced by regression gates.
- Release artifacts, changelog, and upgrade notes are automated.

## Workstreams

## 1) API and Package Stability

- Freeze `mod.ts` surface into `alpha`, `beta`, and `ga` tracks.
- Add TSDoc for all exported types/classes and explicit error taxonomy.
- Introduce API compatibility tests (snapshot of exported names/types).

## 2) Runtime Correctness and Safety

- Replace generic `Error` throws with typed errors (`AbiError`,
  `TransportError`, `ProtocolError`).
- Add explicit close/cancel semantics for in-flight session work.
- Add hard checks for memory bounds and stale peer handle usage in every ABI
  path.

## 3) Transport Reliability

- Add bounded outbound queues and backpressure policy per transport.
- Add timeouts for connect, read-idle, and graceful close phases.
- Add reconnection strategy helpers (policy object, no implicit reconnect by
  default).

## 4) RPC Ergonomics

- Add client helpers for bootstrap/call flows over `RpcSession`.
- Add capability lifecycle helpers (release/finish hooks) to avoid leaks.
- Define server-side handler bridge design (host callback model) as a tracked
  milestone.

## 5) Serde and Codegen Integration

- Move from hand-wired serde export names to generated mapping metadata.
- Add schema package conventions for generated TS code and runtime lookup.
- Validate deterministic encode/decode behavior across wasm builds.

## 6) Security and Limits

- Enforce configurable message/frame/traversal/nesting limits in Deno host
  layer.
- Add fuzz tests for framing, ABI boundary calls, and serde decode paths.
- Add deny-by-default guidance for required Deno permissions in docs.

## 7) Observability

- Add structured logging hooks (debug/info/warn/error) with no-op default.
- Add metrics hooks (frame counts, queue depth, processing latency, errors by
  code).
- Emit trace context IDs for frame pump lifecycles in test/debug mode.

## 8) CI, Interop, and Release

- Standardize runner entrypoints through `Justfile`:
  - fast gate: `just ci-fast`
  - integration gate: `just ci-integration`
  - real gate: `just ci-real`
- Wire those recipes into your chosen CI runner with Linux/macOS coverage and
  Deno version matrix.
- Add release automation for version bump, tag, changelog, and publish.

## Milestones

## M0 (Hardening Foundation)

- Typed errors, stricter close semantics, baseline CI, API docs.
- Exit: `verify` + `verify:integration` green in CI on Linux/macOS.

## M1 (Beta Runtime)

- Backpressure, limits, transport timeout policy, metrics hooks.
- Exit: fuzz + soak tests added; no known crash/regression under stress suite.

## M2 (Interop and Codegen)

- Generated serde binding map and schema package conventions.
- Cross-language e2e against `capnp-zig` fixtures and reference backends.
- Exit: interop gate required for merges to release branch.

## M3 (GA)

- Semver/API stability declaration, release automation, operational docs.
- Exit: two consecutive release candidates pass full CI + interop + benchmark
  gates.

## Immediate Execution Order

1. Keep `Justfile` as the single gate interface and wire
   `ci-fast`/`ci-integration`/`ci-real` in your CI runner.
2. Introduce typed error hierarchy and retrofit all throw sites.
3. Add host-side resource limit configuration and tests.
4. Land generated serde/codegen path and remove manual export-name wiring.
5. Add RPC client/server ergonomics to reach feature completeness.
6. Add observability hooks and transport queue/backpressure controls.

## Dependency On capnp-zig

This plan depends on upstream ABI/runtime additions documented in:

- `docs/capnp_zig_additions.md`
