# Systematic Audit Checklist (2026-02-12)

Legend: `[ ]` not started, `[-]` in progress, `[x]` done

## A. Baseline Signals

- [x] Run `deno task lint`
- [x] Run `deno task check`
- [x] Run unit tests (`deno task test:unit`)
- [x] Capture failures/flakes/perf blockers in devlog

## B. Public API and Entrypoints

- [x] Verify export surface consistency and no accidental leaking/breaking
- [x] Confirm import paths and package `exports` alignment in `deno.json`
- [x] Validate error-type and option-type exposure completeness

## C. Core Safety

- [x] Review `src/errors.ts` for error metadata and propagation quality
- [x] Review `src/validation.ts` invariants and edge-case handling

## D. Wire/Framing Correctness

- [x] Frame limits correctness and denial-of-service boundaries
- [x] Encode/decode symmetry and tag handling
- [x] Segment/pointer arithmetic safety and integer bounds
- [x] Router dispatch fallthrough/default behavior

## E. Session and Client Runtime

- [x] Session lifecycle (start/stop/close/idempotency)
- [x] Inbound->outbound drain invariant preservation
- [x] Promise pipelining and finish/release semantics
- [x] Client middleware and timeout behavior
- [x] Streaming API semantics and backpressure

## F. Server Runtime

- [x] Bridge host-call pump and dispatch ordering
- [x] Runtime root registration and bootstrap path
- [x] Outbound call intercept behavior and cleanup
- [x] Middleware context integrity and error unwinding

## G. Transports and Resilience

- [x] TCP/WebSocket/MessagePort transport state machines
- [x] Reconnect policy boundaries and retry-budget math
- [x] Reconnecting client remap and replay safety
- [x] Connection pool resource lifecycle and stale-entry cleanup
- [x] Circuit-breaker threshold logic and time-window behavior

## H. WASM and Encoding

- [x] ABI memory ownership/allocation/free invariants
- [x] Peer load/instantiate error paths and cleanup
- [x] Serde runtime validation and codec lookup contracts

## I. Observability and DX

- [x] Event schema consistency and attribute typing
- [x] Optional OTEL integration fault isolation
- [x] Docs/task scripts alignment with real behavior

## J. Tooling and Codegen

- [x] CLI argument validation and errors
- [x] Request parsing robustness (malformed input handling)
- [x] Emitter correctness and deterministic output

## K. Tests and Coverage Gaps

- [x] Verify critical invariants are tested (close/start, replay, frame limits)
- [x] Flag missing tests for each high-severity finding
- [x] Suggest focused regression tests
