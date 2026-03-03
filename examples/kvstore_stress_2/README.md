# KVStore Stress Client (`kvstore_stress_2`)

This example drives the `KvStore.writeBatch` RPC as fast as possible with
configurable concurrency.

It targets a rotating active key window of size `N` inside a total key space of
size `M`:

- Total key space `M`: `--key-space` (or `--m`)
- Active rotating window `N`: `--active-keys` (or `--n`)
- Window shift per batch: `--rotation-step`

Each batch chooses random keys from the current window, then randomly applies
`put` or `delete` operations.

## Start The Zig KVStore Server

From repository root:

```sh
just --justfile vendor/capnp-zig/examples/kvstore/Justfile server
```

## Run The Stress Client

From repository root:

```sh
deno run --allow-net --allow-sys examples/kvstore_stress_2/kvstore_stress_client.ts \
  --host=127.0.0.1 \
  --port=9000 \
  --key-space=16384 \
  --active-keys=1024 \
  --concurrency=32 \
  --min-batch=8 \
  --max-batch=64
```

To run for a fixed amount of time:

```sh
deno run --allow-net --allow-sys examples/kvstore_stress_2/kvstore_stress_client.ts \
  --duration-seconds=30
```

## Key Options

- `--key-space` / `--m`: total key set size `M`
- `--active-keys` / `--n`: rotating active subset size `N`
- `--rotation-step`: keys to advance the active window after each batch
- `--concurrency`: number of parallel write loops
- `--min-batch`, `--max-batch`: random batch size bounds
- `--delete-ratio`: per-op probability of delete instead of put
- `--min-value-bytes`, `--max-value-bytes`: random payload size bounds for put
- `--report-ms`: reporting interval
- `--duration-seconds`: stop automatically after N seconds; `0` runs until
  interrupted
