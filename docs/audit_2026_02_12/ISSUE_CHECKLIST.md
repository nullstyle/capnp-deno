# Issue Remediation Checklist (2026-02-12)

Legend: `[ ]` not started, `[-]` in progress, `[x]` done

## 0. Global Completion Criteria

- [x] All `P1` fixes implemented with regression tests
- [x] All `P2` fixes implemented with regression tests
- [x] All `P3` fixes implemented (tests where appropriate)
- [x] `deno task verify` passes
- [x] `deno task verify:integration` passes
- [x] Audit docs updated with final outcomes (commit hash reference pending user commit)

## 1. F-001 (`P1`) RpcSession start/close race (`src/rpc/session/session.ts`)

- [x] Add post-await closed-state guard in `start()` before `#started = true`
- [x] Ensure transport/peer cleanup semantics remain consistent when close wins race
- [x] Add regression test: concurrent `start()` + `close()` with delayed transport start
- [x] Assert final state is not `started=true` after close wins
- [x] Run targeted tests for session lifecycle suite

## 2. F-002 (`P1`) Duplicate live question IDs in RpcServerBridge (`src/rpc/server/bridge.ts`)

- [x] Add duplicate-live-question check before answer-table insert
- [x] Return/emit protocol exception for duplicate `questionId`
- [x] Add regression test for duplicate call ID while first is still live
- [x] Ensure existing pipelining/finish tests still pass
- [x] Run targeted server bridge tests

## 3. F-003 (`P2`) Reconnect abort responsiveness (`src/rpc/transports/reconnect.ts`)

- [x] Add immediate abort fast-path in `defaultSleep()`
- [x] Add optional pre-sleep `throwIfAborted(signal)` in reconnect loop
- [x] Add regression test for synchronous abort in `onRetry`
- [x] Validate existing reconnect edge tests continue to pass

## 4. F-004 (`P2`) CircuitBreaker half-open probe concurrency (`src/rpc/transports/circuit_breaker.ts`)

- [x] Introduce single-probe gate for `HALF_OPEN` state
- [x] Define behavior for concurrent callers during probe (fail fast) and document
- [x] Add regression test asserting only one probe executes concurrently
- [x] Re-run full `circuit_breaker_test.ts`

## 5. F-005 (`P3`) CLI `--` sentinel semantics (`tools/capnpc-deno/cli.ts`)

- [x] Stop flag parsing after `--` and treat remaining args as positional
- [x] Add regression test with option-like tokens after sentinel
- [x] Validate plugin-mode and legacy-mode parsing remains unchanged
- [x] Re-run `tests/codegen/capnpc_deno_cli_test.ts`

## 6. F-006 (`P3`) Connection pool timeout-settled compaction (`src/rpc/transports/connection_pool.ts`)

- [x] Add bounded compaction trigger for timeout-settled pending entries
- [x] Ensure no performance regression in common acquire/release path
- [x] Add stress/regression test for timeout-only churn scenario
- [x] Re-run connection pool test suites

## 7. Closeout

- [x] Update `docs/audit_2026_02_12/DEVLOG.md` with each fix/test result
- [x] Mark completed items in this checklist
- [x] Produce final issue closure summary with file references and test commands
