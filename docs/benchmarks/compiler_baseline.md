# Compiler cold and warm baseline

Measured on 2026-09-15 UTC with Deno 2.6.8, an Apple M5 Max, 128 GiB RAM, and
macOS/aarch64. The compiler adapter baseline is commit
`f0846aee61a55ed70edd780505aaec04f9a0f2c7` plus the new
[`compiler_bench.ts`](../../bench/compiler_bench.ts) measurement command. The
public compiler-host package is rc.3, producer source `a5ccaae`. The
[raw result](compiler_aarch64_darwin_2026-09-15.json) records the complete
compiler pin, schema/request digests, runtime versions, and every sample.

| Schema            | Request bytes | Cold median |  Cold p95 | Warm median | Warm p95 |
| ----------------- | ------------: | ----------: | --------: | ----------: | -------: |
| Ping example      |         2,032 |   33.536 ms | 37.312 ms |    0.801 ms | 1.955 ms |
| Full RPC protocol |        82,840 |   32.273 ms | 39.699 ms |    2.362 ms | 3.643 ms |

## Repeat the measurement

Acquire the pinned package once with `mise exec -- deno task compiler:fetch`,
then run from the repository root:

```sh
mise exec -- deno run --no-prompt --allow-read bench/compiler_bench.ts > compiler_benchmark.json
```

The command takes five cold and 25 warm samples for each schema, with a
120-second overall compilation deadline. It needs neither network nor process
permission. Each request must have the same SHA-256 digest in both modes;
compilation errors and digest differences fail the command. It does not run when
discovered by `deno bench`, keeping the ordinary calibrated benchmark suite
independent of compiler assets.

**Cold** starts the clock before creating a fresh compiler client and worker. It
includes full package inventory/digest verification, reading compiler and
include assets, worker initialization, workspace acquisition, and the first
compile-to-request operation. The result separates initialization from that
first compile as well as recording their combined duration.

**Warm** reuses one client and worker after one untimed compile. Every timed
compile still acquires a fresh workspace snapshot and compiles the schema; the
request is not served from a result cache.

Both modes exclude Deno process/module startup, artifact download, request
digest verification, disposal, TypeScript emission, formatting, and writes. OS
file caches and V8 process caches are retained, so this measures a fresh
compiler worker rather than a cold machine or full CLI startup. The RPC case
includes the standard `/capnp/c++.capnp` import.

These observations establish the requested local baseline, not a cross-host
performance budget. Five cold samples are deliberately bounded; their
nearest-rank p95 is simply the slowest sample. Compare raw samples on the same
host and toolchain when evaluating future adapter changes.
