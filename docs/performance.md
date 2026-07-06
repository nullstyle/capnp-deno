# Performance Guide

capnp-deno keeps performance checks split between exploratory benchmarks and
blocking regression tests. This keeps normal development fast while still
guarding the hot paths that are easy to accidentally make quadratic.

## Commands

```sh
# Fast Deno benchmarks, excluding real-WASM-only benches.
deno task bench:fast

# Real WASM benchmarks after building generated/capnp_deno.wasm.
deno task bench:real

# Fast benchmark run plus blocking regression budgets.
just perf-check

# CI benchmark bundle used by the Justfile.
just ci-bench
```

`just perf-check` is the sprint-level gate for local performance work. It runs
the fast benchmark suite and then `bench/regression_test.ts`, which enforces
loose but blocking elapsed-time budgets.

## Benchmark Coverage

Current benchmark groups cover:

- frame parsing and Cap'n Proto message validation;
- RPC wire encode/decode paths;
- session and server-runtime host-call pumping;
- generated callback-capability export and call/finish overhead;
- typed generated stream sender backpressure overhead;
- reconnecting transport wrappers;
- real-WASM serde when `generated/capnp_deno.wasm` is available.

Benchmarks are useful for comparing local changes, but they are not pass/fail
contracts. The blocking contracts live in `bench/regression_test.ts`.

## Regression Budgets

`bench/regression_test.ts` records each result with:

- test name;
- iteration count;
- elapsed milliseconds;
- budget milliseconds;
- percent of budget;
- operations per second.

When `CI=true`, the test also writes `bench/results.json` so workflow artifacts
can track cross-commit trends. The budgets are intentionally generous; a failure
usually means a structural regression, excessive allocation, or an event-loop
stall rather than normal benchmark noise.

## Adding New Performance Coverage

Add a benchmark when you want comparative timing. Add a regression test when a
specific operation must stay within an upper bound.

Good regression candidates:

- parser or decoder loops over attacker-controlled input;
- frame or cap-table handling where an O(n) path could become O(n^2);
- generated callback or streaming plumbing that runs per RPC call;
- transport pump code that runs once per frame or stream chunk.

Keep benchmark fixtures deterministic and avoid opening network listeners unless
the benchmark is explicitly transport-facing.
