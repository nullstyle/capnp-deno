# Audit Devlog (2026-02-12)

## Entries

- 2026-02-12T09:40 local: Initialized audit plan/checklist/devlog. Scope set to
  first-party code; vendor subtree excluded from deep review.
- 2026-02-12T09:42 local: Baseline gates complete. `deno task lint` passed,
  `deno task check` passed, `deno task test:unit` passed (869 passed, 0 failed,
  ~5s). No baseline flakes observed.
- 2026-02-12T10:04 local: Extended baseline verification complete.
  `deno task verify` passed (fmt/lint/check/check:generated/test:unit), and
  `deno task verify:integration` passed
  (`tests/transports/socket_integration_test.ts`).
- 2026-02-12T10:18 local: Completed API/safety/wire review (`src/mod.ts`,
  `src/rpc.ts`, `src/encoding.ts`, `src/errors.ts`, `src/validation.ts`,
  `src/rpc/wire/**`). No critical correctness regressions found in
  framing/pointer arithmetic paths.
- 2026-02-12T10:29 local: Confirmed finding `P1` in `src/rpc/session/session.ts`
  (`start`/`close` race). Repro (`deno eval`) output:
  `{\"started\":true,\"closed\":true,\"transportStarted\":true,\"transportClosed\":true,\"startErr\":null}`.
  This shows `start()` can resolve and set `started=true` after `close()` wins.
- 2026-02-12T10:35 local: Confirmed finding `P1` in `src/rpc/server/bridge.ts`
  (duplicate `questionId` accepted/overwritten). Repro output:
  `{\"firstKind\":\"results\",\"secondKind\":\"results\",\"secondReason\":null,\"answerTableSize\":1}`.
  Bridge accepts a second `Call` with same `questionId` instead of returning
  exception.
- 2026-02-12T10:41 local: Confirmed finding `P2` in
  `src/rpc/transports/reconnect.ts` (abort responsiveness in default sleep).
  With synchronous abort in `onRetry`, elapsed time still follows backoff delay:
  `{\"elapsedMs\":124,\"message\":\"reconnect aborted\"}` for a 120ms retry
  delay.
- 2026-02-12T10:47 local: Confirmed finding `P2` in
  `src/rpc/transports/circuit_breaker.ts` (half-open probe concurrency). Repro
  output:
  `{\"state\":\"CLOSED\",\"probeCalls\":2,\"a\":\"fulfilled\",\"b\":\"fulfilled\"}`.
  Two concurrent calls execute in `HALF_OPEN` instead of a single probe.
- 2026-02-12T10:52 local: Confirmed finding `P3` in `tools/capnpc-deno/cli.ts`
  (`--` sentinel handling). Repro
  `parseCliArgs([\"generate\",\"--\",\"--schema\",\"foo.capnp\"])` returns
  `schemas=[\"foo.capnp\"]` (flag still parsed) rather than treating `--schema`
  as positional after sentinel.
- 2026-02-12T10:56 local: Noted `P3` maintainability risk in
  `src/rpc/transports/connection_pool.ts`: settled timed-out pending acquires
  are compacted only via `#takeNextPendingAcquire()`; repeated timeout churn
  without handoff/drain can retain settled entries in `#pending` longer than
  necessary.
- 2026-02-12T10:06 local: Implemented `F-001` fix in
  `src/rpc/session/session.ts`: `start()` now throws
  `SessionError(\"RpcSession was closed while start was in progress\")` when
  closure wins after `transport.start(...)` resolves. Added regression test
  `rpc lifecycle: close during start prevents started state` in
  `tests/session/rpc_lifecycle_conformance_test.ts`.
- 2026-02-12T10:06 local: Implemented `F-002` fix in
  `src/rpc/server/bridge.ts`: duplicate live `questionId` now returns
  `Return.exception` with duplicate-id reason before answer-table insertion.
  Added regression test `RpcServerBridge rejects duplicate live question ids` in
  `tests/server/rpc_server_bridge_test.ts`.
- 2026-02-12T10:06 local: Targeted `P1` validation passed:
  `deno test tests/session/rpc_lifecycle_conformance_test.ts tests/server/rpc_server_bridge_test.ts`
  (`41 passed`, `0 failed`).
- 2026-02-12T10:06 local: Implemented `F-003` fix in
  `src/rpc/transports/reconnect.ts`: `defaultSleep()` now fast-fails already
  aborted signals and reconnect loop re-checks abort before sleeping. Added
  regression test `connectWithReconnect default sleep aborts immediately for
  synchronous onRetry abort` in `tests/transports/reconnect_edge_test.ts`.
- 2026-02-12T10:06 local: Implemented `F-004` fix in
  `src/rpc/transports/circuit_breaker.ts`: added single-probe guard for
  `HALF_OPEN` (`circuit breaker half-open probe already in progress` for
  concurrent callers). Added regression test
  `CircuitBreaker HALF_OPEN allows only one concurrent probe` in
  `tests/transports/circuit_breaker_test.ts`.
- 2026-02-12T10:06 local: Targeted `P2` validation passed:
  `deno test tests/transports/reconnect_edge_test.ts tests/transports/reconnect_test.ts tests/transports/circuit_breaker_test.ts`
  (`28 passed`, `0 failed`).
- 2026-02-12T10:06 local: Implemented `F-005` fix in
  `tools/capnpc-deno/cli.ts`: parser now treats all tokens after `--` as
  positional schemas. Added regression test
  `capnpc-deno CLI treats option-like tokens after -- as positional schemas` in
  `tests/codegen/capnpc_deno_cli_test.ts`.
- 2026-02-12T10:06 local: Implemented `F-006` fix in
  `src/rpc/transports/connection_pool.ts`: timeout-settled pending acquires now
  trigger bounded `#compactPending()` compaction on timeout path. Added stress
  regression test
  `RpcConnectionPool remains stable under timeout-only pending churn` in
  `tests/transports/connection_pool_test.ts`.
- 2026-02-12T10:06 local: Targeted `P3` validation passed:
  `deno test tests/codegen/capnpc_deno_cli_test.ts tests/transports/connection_pool_test.ts`
  (`87 passed`, `0 failed`).
- 2026-02-12T10:06 local: Full verification passed after fixes:
  `deno task verify` (`875 passed`, `0 failed`) and
  `deno task verify:integration` (`3 passed`, `0 failed`).
