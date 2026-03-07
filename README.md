# capnp-deno (scaffold)

**WARNING: This repo is extensively vibe-coded; it's just for me. **

`capnp-deno` is a Deno-first Cap'n Proto runtime + codegen scaffold.

It combines:

- a WASM-backed RPC session runtime (`RpcSession`, `RpcServerRuntime`),
- client/server RPC helpers (`SessionRpcClientTransport`, `RpcServerBridge`),
- schema-first TypeScript codegen (`tools/capnpc-deno`),
- real transports (TCP, WebSocket, WebTransport, MessagePort),
- resilience/ops helpers (reconnect, connection pool, circuit breaker,
  middleware, streaming, observability).

Primary public entrypoint is `mod.ts`. Split entrypoints are available at
`rpc.ts` (`@nullstyle/capnp/rpc`) and `encoding.ts`
(`@nullstyle/capnp/encoding`). Advanced low-level WASM APIs are in
`advanced.ts`.

## Core Contract

Runtime invariant:

1. push one inbound frame into the peer,
2. drain all outbound frames in order before processing the next inbound frame.

`RpcSession` enforces this ordering and is the foundation for higher-level APIs.

## Quick Start

### Prerequisites

- Deno (repo pins `2.6.8` in `mise.toml`)
- Just (`1.46.0`) for convenience commands
- Zig (`0.15.2`) only when rebuilding `generated/capnp_deno.wasm`
- `capnp` CLI for schema/codegen workflows

### Validate Your Environment

```sh
just ci-fast
```

This runs format, lint, type-check, and unit tests.

### Build/Rebuild Runtime WASM (when needed)

```sh
just build-wasm
```

If auto-detect cannot find the Zig repo:

```sh
CAPNPC_ZIG_ROOT=/path/to/capnp-zig deno task build:wasm
```

## Primary Usage Paths

### 1) Schema-First Serde (recommended starting point)

Generate from `.capnp`:

```sh
deno task codegen generate --schema schema/person.capnp --out generated
```

Use generated codec:

```ts
import { type Person, PersonCodec } from "./generated/schema/person_types.ts";

const input: Person = {
  id: 123n,
  name: "Alice",
  age: 42,
};

const bytes = PersonCodec.encode(input);
const roundtrip = PersonCodec.decode(bytes);
```

Generated outputs include:

- `*_types.ts` typed codecs + RPC helpers
- `*_meta.ts` reflection metadata
- `generated/mod.ts` barrel (unless disabled)

### 2) RPC Runtime + Typed Client/Server Stubs

At runtime, high-level factories load `generated/capnp_deno.wasm` via static
WASM imports.

```ts
import {
  InMemoryRpcHarnessTransport,
  RpcServerRuntime,
  SessionRpcClientTransport,
} from "./mod.ts";
import {
  bootstrapPingerClient,
  PingerInterfaceId,
  registerPingerServer,
} from "./generated/schema/pinger_types.ts";

const transport = new InMemoryRpcHarnessTransport();
const runtime = await RpcServerRuntime.createWithRoot(
  transport,
  registerPingerServer,
  {
    async ping(_params) {
      return {};
    },
  },
  { autoStart: true },
);

const clientTransport = new SessionRpcClientTransport(
  runtime.session,
  transport,
  { interfaceId: PingerInterfaceId },
);

const client = await bootstrapPingerClient(clientTransport);
await client.ping({});

await runtime.close();
```

For network clients, use `connectAndBootstrap(...)` with generated
`bootstrap*Client(...)` helpers to create a typed client in one step.

## Transports, Resilience, and Ops

Built-in transports:

- `TcpTransport` + `TcpServerListener`
- `TcpRpcClientTransport` (raw RPC client adapter over a started transport)
- `WebSocketTransport`
- `WebTransportTransport`
- `MessagePortTransport`

Resilience and runtime helpers:

- `createExponentialBackoffReconnectPolicy(...)`
- `connectTcpTransportWithReconnect(...)`
- `connectWebSocketTransportWithReconnect(...)`
- `connectWebTransportTransportWithReconnect(...)`
- `createRpcSessionWithReconnect(...)`
- `ReconnectingRpcClientTransport`
- `RpcConnectionPool` + `withConnection(...)`
- `CircuitBreaker`
- `createStreamSender(...)`

Middleware and observability:

- `MiddlewareTransport`
- `createLoggingMiddleware(...)`
- `createFrameSizeLimitMiddleware(...)`
- `createRpcIntrospectionMiddleware(...)`
- `createRpcMetricsMiddleware(...)`
- `createDenoOtelObservability(...)`

## Codegen CLI

Run directly:

```sh
deno task codegen generate --src schema --out generated
deno task codegen generate --schema schema/foo.capnp --out generated
deno task codegen generate --request-bin path/to/request.bin --out generated
```

Install as a `capnp compile` plugin:

```sh
deno task codegen:install
capnp compile -I schema -odeno:generated schema/foo.capnp
```

Compile a standalone `capnpc-deno` binary:

```sh
deno task codegen:compile
./dist/capnpc-deno generate --schema schema/foo.capnp --out generated
```

Cross-compile a specific release target:

```sh
deno task codegen:compile x86_64-pc-windows-msvc dist/capnpc-deno-x86_64-pc-windows-msvc.exe
```

Local wrapper-script plugin mode (no install):

```sh
capnp compile -I schema -o ./scripts/capnpc-deno:generated schema/foo.capnp
```

GitHub release assets:

- pushing a tag matching `v*` runs `.github/workflows/release.yml`
- attached binaries include Linux/macOS/Windows targets compiled via
  `deno compile`

Useful options:

- `--layout schema|flat`
- `--no-barrel`
- `--plugin-response`
- `--config path/to/capnpc-deno.toml`
- `--no-config`

## Development Commands

Fast CI gate:

```sh
just ci-fast
```

Integration gate (socket loopback tests included):

```sh
just ci-integration
```

Real-WASM gate:

```sh
just ci-real
```

Deno task equivalents:

```sh
deno task verify
deno task test:integration
deno task verify:real
```

Run GitHub Actions locally:

```sh
# List available CI jobs
just act-list

# Run CI workflow locally (default event: pull_request)
just act-ci

# Run a single CI job
just act-ci-job verify

# Optional: run benchmark gate locally
just act-bench
```

Notes:

- `.actrc` pins `act` to `.github/workflows/ci.yml` and maps `ubuntu-latest` to
  a local Linux container image.
- `just act-ci` excludes benchmark regression checks by default; run
  `just act-bench` when you explicitly want that signal.
- Ensure Docker is running before invoking `act`.

Benchmarks:

```sh
just ci-bench
```

## Repository Map

- `mod.ts`: umbrella public API surface
- `rpc.ts`: RPC/runtime-focused entrypoint
- `encoding.ts`: encoding-focused entrypoint
- `advanced.ts`: low-level WASM/serde APIs (`WasmAbi`, `WasmPeer`, `WasmSerde`)
- `src/rpc/session.ts`: session lifecycle + ordered inbound/outbound pumping
- `src/rpc/server_runtime.ts`: session + bridge + host-call pump integration
- `src/rpc/client.ts`: bootstrap/call/finish/release + pipelining transport
- `src/rpc/server.ts`: server dispatch bridge + answer table/pipelining
- `src/rpc/transports/*`: TCP, WebSocket, WebTransport, MessagePort adapters
- `src/encoding/*`: frame limits, stream framing, RPC wire encode/decode
- `tools/capnpc-deno/*`: TypeScript codegen CLI/plugin
- `tests/*`: fake-wasm unit, integration, and real-wasm tests
- `vendor/capnp-zig/`: canonical Zig implementation submodule

## Docs and Examples

- Docs index: `docs/README.md`
- Serde guide: `docs/getting_started_serde.md`
- RPC guide: `docs/getting_started_rpc.md`
- Examples index: `examples/README.md`
- End-to-end walkthrough example:
  `examples/getting-started/getting-started.ts` +
  `examples/getting-started/getting-started.capnp`
- Real-wasm smoke example: `examples/smoke_real_wasm/smoke_real_wasm.ts` +
  `examples/smoke_real_wasm/smoke_real_wasm.capnp`
- Interactive WebTransport peer node example:
  `examples/webtransport_p2p/peer.ts` + `examples/webtransport_p2p/schema.capnp`

## Important Notes

- `SessionRpcClientTransport.callRawPipelined(...)` never auto-finishes. Call
  `finish(questionId)` yourself when done.
- `RpcServerRuntime` host-call pumping requires optional WASM host-call bridge
  exports; if unavailable, pumping is disabled (or throws if explicitly forced).
- Generated files import `@nullstyle/capnp/encoding` and `@nullstyle/capnp/rpc`.
  Ensure these imports resolve in your environment.
