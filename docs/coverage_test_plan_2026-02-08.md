# Coverage Improvement Plan (2026-02-08)

## Goal

Raise confidence in runtime correctness by covering low-hit error paths and edge
behavior first, then expanding into tooling paths.

## Current Coverage Hotspots

- `src/deno_otel.ts` (4.23%)
- `src/reconnect.ts` (47.16%)
- `src/load.ts` (52.81%)
- `src/observability.ts` (53.85%)
- `src/reconnect_wrappers.ts` (60.00%)
- `src/frame_limits.ts` (60.68%)
- `src/rpc_server.ts` (63.10%)
- `src/server_runtime.ts` (63.44%)

## Execution Plan

### Phase 1 (Immediate ROI)

- [x] Add `tests/deno_otel_test.ts`
  - No-telemetry no-op behavior
  - Attribute conversion (`bigint` -> string)
  - Counter/histogram/error-span behavior with `emitErrorSpans` on/off
  - Missing tracer/meter provider paths
- [x] Add `tests/observability_test.ts`
  - `emitObservabilityEvent` safe-failure swallowing
  - `getErrorType` behavior for `Error` + primitives
- [x] Add `tests/load_test.ts`
  - `ArrayBuffer`, `SharedArrayBuffer`, typed-array view inputs
  - `Response` instantiate streaming fallback
  - URL/file/path loading branches and fetch non-OK handling

### Phase 2 (Reconnect Semantics)

- [x] Extend/add reconnect policy validation tests
  - invalid policy args (`factor`, `jitterRatio`, negative/non-finite)
  - invalid `random()` values
  - `maxElapsedMs` boundaries
- [x] Extend/add reconnect runtime error-path tests
  - missing policy
  - failing `shouldRetry` / `nextDelayMs` / `onRetry` / `sleep`
  - pre-aborted signal
- [x] Extend reconnect wrapper unwind tests
  - peer/session creation failures trigger transport/peer cleanup

### Phase 3 (Protocol/Runtime Guards)

- [x] Add frame-limits negative-path cases
- [x] Add rpc_server/server_runtime edge-path cases

### Phase 4 (Transport + Tooling)

- [ ] Add remaining TCP/WebSocket/MessagePort edge-path tests
- [ ] Add capnpc-deno CLI/errors path tests

## Definition of Done (This Iteration)

- Phase 1 implemented and green
- Phase 2 started with core reconnect policy/error-path coverage
- Targeted tests executed and passing
