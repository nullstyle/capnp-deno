# Full-Spectrum Audit Findings (2026-02-12)

## Scope

- Repository first-party code: `src/**`, `tools/**`, `tests/**`, root
  tasks/config.
- Vendor subtree (`vendor/capnp-zig/**`) excluded from deep third-party
  internals audit.

## Severity Summary

- `P1` (high): 2 findings
- `P2` (medium): 2 findings
- `P3` (low): 2 findings

## Findings

### F-001 (`P1`) RpcSession start/close race allows inconsistent terminal state

- Location: `src/rpc/session/session.ts:146`, `src/rpc/session/session.ts:161`,
  `src/rpc/session/session.ts:253`, `src/rpc/session/session.ts:256`
- Problem:
  - `start()` checks `#closed` before awaiting `transport.start(...)`.
  - `close()` can set `#closed = true` while `start()` is in-flight.
  - `start()` then unconditionally sets `#started = true` after await.
- Impact:
  - Session can become `{ started: true, closed: true }`.
  - Startup observability can report success after the session is already
    closed.
- Recommendation:
  - Re-check `#closed` after `transport.start(...)` resolves and before setting
    `#started`.
  - If closed during startup, skip/undo start state and close transport peer
    consistently.
- Regression tests to add:
  - Concurrent `start()` + `close()` race test with delayed transport start.
  - Assert no successful-start state when close wins.

### F-002 (`P1`) RpcServerBridge accepts duplicate live question IDs

- Location: `src/rpc/server/bridge.ts:747`, `src/rpc/server/bridge.ts:757`
- Problem:
  - `#handleCall()` inserts answer-table entry via
    `this.#answerTable.set(call.questionId, entry)` without checking existing
    live entry.
- Impact:
  - Duplicate inbound `Call` frames for the same `questionId` overwrite
    in-flight state.
  - Can corrupt promise-pipelining and finish/eviction behavior.
- Recommendation:
  - Reject duplicate live `questionId` with protocol exception return.
  - Preserve existing entry and avoid overwrite.
- Regression tests to add:
  - Two calls with same `questionId` before finish; second must return
    exception.

### F-003 (`P2`) Reconnect abort responsiveness gap in default sleep path

- Location: `src/rpc/transports/reconnect.ts:104`,
  `src/rpc/transports/reconnect.ts:121`, `src/rpc/transports/reconnect.ts:294`,
  `src/rpc/transports/reconnect.ts:309`
- Problem:
  - `defaultSleep()` does not pre-check `signal.aborted` before adding abort
    listener.
  - `connectWithReconnect()` does not re-check abort between `onRetry` and
    `sleep`.
- Impact:
  - In synchronous-abort timing, reconnect may wait full backoff delay before
    aborting.
- Recommendation:
  - Add immediate `if (signal?.aborted)` fast-fail in `defaultSleep()`.
  - Optionally add `throwIfAborted(signal)` right before `sleep(...)`.
- Regression tests to add:
  - Abort synchronously inside `onRetry`; verify near-immediate rejection.

### F-004 (`P2`) CircuitBreaker half-open allows multiple concurrent probes

- Location: `src/rpc/transports/circuit_breaker.ts:149`,
  `src/rpc/transports/circuit_breaker.ts:159`,
  `src/rpc/transports/circuit_breaker.ts:163`
- Problem:
  - After OPEN cooldown, concurrent callers can all execute `factory()` while in
    `HALF_OPEN`.
  - Current implementation lacks a single-probe gate.
- Impact:
  - Breaker can fan out retries during recovery window.
  - Weakens backpressure and failure-isolation behavior.
- Recommendation:
  - Gate `HALF_OPEN` to a single in-flight probe (others fail fast or await
    probe result by policy).
- Regression tests to add:
  - Concurrent calls immediately after cooldown; assert exactly one probe call.

### F-005 (`P3`) CLI `--` sentinel semantics are non-standard

- Location: `tools/capnpc-deno/cli.ts:206`, `tools/capnpc-deno/cli.ts:207`
- Problem:
  - `case "--": break;` exits only switch branch, not parse loop.
  - Subsequent `--flag` tokens continue being parsed as options.
- Impact:
  - Unexpected CLI behavior for users relying on conventional `--`
    end-of-options semantics.
- Recommendation:
  - On sentinel, treat all remaining args as positional and stop flag parsing.
- Regression tests to add:
  - `parseCliArgs(["generate", "--", "--schema", "foo.capnp"])` should treat
    `--schema` as positional.

### F-006 (`P3`) Connection pool settled-timeout entry retention risk

- Location: `src/rpc/transports/connection_pool.ts:303`,
  `src/rpc/transports/connection_pool.ts:306`,
  `src/rpc/transports/connection_pool.ts:472`,
  `src/rpc/transports/connection_pool.ts:609`
- Problem:
  - Timeout path marks pending entries as settled and increments
    `#pendingSettled`.
  - Compaction occurs in `#takeNextPendingAcquire()` only.
- Impact:
  - Under repeated timeout-only churn with little/no handoff/drain activity,
    settled entries can remain in `#pending` longer than necessary.
- Recommendation:
  - Trigger periodic/lazy compaction from timeout path (bounded cost), or
    compact when settled ratio/threshold is exceeded.
- Regression tests to add:
  - Repeated timeout churn with no successful handoff; assert bounded internal
    pending growth.

## Verification Context

- `deno task verify`: passed
- `deno task verify:integration`: passed
