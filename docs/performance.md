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

## Generated Stream Buffer Measurements

Run the allocation/retention comparison in its own process:

```sh
mise exec -- deno run --allow-read bench/streaming_memory.ts
# Optionally save the JSON report in an existing directory.
mise exec -- deno run --allow-read --allow-write=docs/measurements \
  bench/streaming_memory.ts docs/measurements/streaming_memory_local.json
```

The script reuses `CounterSink` and `createCounterSinkAddStreamSender` from the
generated streaming example. Each mode sends the same 1,024 UInt32 values,
producing 24-byte parameter messages. Both use a 32-call count window; the
byte-bounded mode additionally admits at most 192 bytes (eight messages). The
transport holds the actual serialized buffers, requests a two-millisecond timer
delay before each acknowledgment, and releases its references on Finish. These
are local timers, not network or native-WASM acknowledgments.

After a 64-call warmup per mode, three paired samples alternate execution order.
Every sample checks decoded values, equal serialization/call/Finish counts and
bytes, count/byte bounds, a waiting encoded candidate in the bounded mode, and
zero remaining calls, retained buffers, timers, or byte charges after flush. A
ten-second deadline bounds each sample.

The measurements have specific scopes:

- **Final serialization allocations:** an isolated-process wrapper counts real
  calls and returned bytes from `MessageBuilder.toMessageBytes`, then restores
  the original method in `finally`. It detects duplicate final serialization
  before transport submission. A separate weak identity set counts distinct,
  exact-size backing ArrayBuffers received at `transport.call` without retaining
  every historical buffer.
- **Encoded lifetime:** bytes between the generated `onEncodedParams` callback
  and the corresponding Finish, including the single encoded candidate waiting
  for byte admission. The transport's separate map counts actual references held
  from `call` through Finish.
- **Sender accounting:** public `inFlight`, `inFlightBytes`, and
  `pendingEncodedBytes` peaks observed at encoding, admission, transport call,
  acknowledgment, Finish, and flush. Count-only generated sends do not reserve
  bytes, so their raw `inFlightBytes` remains zero; their buffers are still
  counted by the independent lifetime and transport measurements.

These counts exclude internal builder growth, codec objects, promises, timer
storage, capability descriptors, RPC envelopes, and transport copies. They do
not measure total V8 allocations, garbage-collection timing, or process heap
high-water marks. The timer, decode validation, and measurement instrumentation
are present in both modes.

### Recorded local result

The [raw report](measurements/streaming_memory_2026-09-15.json) records source
hashes, runtime versions, all six samples, and final zero-retention checks. On
Deno 2.6.8 / macOS arm64:

| Measurement per 1,024-call sample      |     Count only |  Byte bounded |
| -------------------------------------- | -------------: | ------------: |
| Final serialized buffers               |          1,024 |         1,024 |
| Cumulative final serialized bytes      |         24,576 |        24,576 |
| Distinct buffers received by transport |          1,024 |         1,024 |
| Peak encoded buffers through Finish    | 32 / 768 bytes | 9 / 216 bytes |
| Peak buffers retained by transport     | 32 / 768 bytes | 8 / 192 bytes |
| Peak sender pending encoded bytes      |              0 |            24 |
| Median elapsed                         |      109.93 ms |     441.06 ms |
| Median calls/second                    |          9,315 |         2,322 |

Both paths serialize once per call. The smaller byte window reduces peak
transport retention by 75%, with one extra encoded candidate outside that
window. It also reduces active work from 32 calls to eight under delayed
acknowledgment, explaining the lower throughput. This comparison measures the
configured retention/concurrency tradeoff; the existing paired
`generated_rpc:encoded_stream_32_*` benchmarks use immediate acknowledgments to
compare admission bookkeeping cost separately.

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
