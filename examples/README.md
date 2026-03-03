# Examples

Each example is nested in its own directory and has a colocated `.capnp` schema.

## Layout

- `examples/getting-started/`
  - `getting-started.ts`
  - `getting-started_server.ts`
  - `getting-started_client.ts`
  - `getting-started.capnp`
  - `generated/*`
- `examples/tcp_golden_path/`
  - `tcp_golden_path.ts`
  - `tcp_golden_path_server.ts`
  - `tcp_golden_path_client.ts`
  - `tcp_golden_path.capnp`
  - `generated/*`
- `examples/tcp_echo_server/`
  - `tcp_echo_server.ts`
  - `tcp_echo_server_client.ts`
  - `tcp_echo_server.capnp`
  - `generated/*`
- `examples/bidirectional_capability/`
  - `bidirectional_capability.ts`
  - `bidirectional_capability.capnp`
- `examples/warmup_stats_example/`
  - `warmup_stats_example.ts`
  - `warmup_stats_example.capnp`
- `examples/smoke_real_wasm/`
  - `smoke_real_wasm.ts`
  - `smoke_real_wasm.capnp`
- `examples/kvstore_stress_2/`
  - `kvstore_stress_client.ts`
  - `kvstore.capnp`
  - `gen/*`

## Task Runner

Use the example-specific Justfile:

```sh
just --justfile examples/Justfile --list
```

Run these commands from the repository root. `gen-*` tasks use
`capnp compile -odeno:...`, so `capnpc-deno` must be on `PATH` (for example:
`~/.bin/capnpc-deno`).

Common commands:

```sh
just --justfile examples/Justfile gen-rpc
just --justfile examples/Justfile run-getting-started
just --justfile examples/Justfile run-tcp-golden-path
just --justfile examples/Justfile run-tcp-golden-server
just --justfile examples/Justfile run-tcp-golden-client
just --justfile examples/Justfile run-tcp-echo-server
just --justfile examples/Justfile run-tcp-echo-client
just --justfile examples/Justfile run-bidirectional-capability
just --justfile examples/Justfile run-warmup-stats
just --justfile examples/Justfile run-kvstore-stress-2
just --justfile examples/Justfile run-smoke-real-wasm
```
