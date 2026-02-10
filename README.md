# capnp-deno (scaffold)

**WARNING: This repo is extensively vibe-coded; it's just for me. **

`capnp-deno` is a Deno-first Cap'n Proto runtime + codegen scaffold.

It combines:

- a WASM-backed RPC session runtime (`RpcSession`, `RpcServerRuntime`),
- client/server RPC helpers (`SessionRpcClientTransport`, `RpcServerBridge`),
- schema-first TypeScript codegen (`tools/capnpc-deno`),
- real transports (TCP, WebSocket, MessagePort),
- resilience/ops helpers (reconnect, connection pool, circuit breaker,
  middleware, streaming, observability).

The public entrypoint is `mod.ts`. Advanced low-level WASM APIs are in
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
import { type Person, PersonCodec } from "./generated/schema/person_capnp.ts";

const input: Person = {
  id: 123n,
  name: "Alice",
  age: 42,
};

const bytes = PersonCodec.encode(input);
const roundtrip = PersonCodec.decode(bytes);
```

Generated outputs include:

- `*_capnp.ts` typed binary codecs
- `*_rpc.ts` typed RPC helpers
- `*_meta.ts` reflection metadata
- `generated/mod.ts` barrel (unless disabled)

### 2) RPC Runtime + Typed Client/Server Stubs

At runtime, high-level factories load `generated/capnp_deno.wasm` via static
WASM imports.

```ts
import {
  InMemoryRpcHarnessTransport,
  RpcServerBridge,
  RpcServerRuntime,
  SessionRpcClientTransport,
} from "./mod.ts";
import {
  createPingerClient,
  PingerInterfaceId,
  registerPingerServer,
} from "./generated/schema/pinger_rpc.ts";

const transport = new InMemoryRpcHarnessTransport();
const bridge = new RpcServerBridge();

const runtime = await RpcServerRuntime.create(transport, bridge, {
  autoStart: true,
});

const clientTransport = new SessionRpcClientTransport(
  runtime.session,
  transport,
  { interfaceId: PingerInterfaceId },
);

const bootstrap = await clientTransport.bootstrap();

registerPingerServer(
  bridge,
  {
    async ping(_params) {
      return {};
    },
  },
  { capabilityIndex: bootstrap.capabilityIndex, referenceCount: 2 },
);

const client = createPingerClient(clientTransport, bootstrap);
await client.ping({});

await runtime.close();
```

## Transports, Resilience, and Ops

Built-in transports:

- `TcpTransport` + `TcpServerListener`
- `WebSocketTransport`
- `MessagePortTransport`

Resilience and runtime helpers:

- `createExponentialBackoffReconnectPolicy(...)`
- `connectTcpTransportWithReconnect(...)`
- `connectWebSocketTransportWithReconnect(...)`
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

Local wrapper-script plugin mode (no install):

```sh
capnp compile -I schema -o ./scripts/capnpc-deno:generated schema/foo.capnp
```

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

Benchmarks:

```sh
just ci-bench
```

## Repository Map

- `mod.ts`: public API surface
- `advanced.ts`: low-level WASM/serde APIs (`WasmAbi`, `WasmPeer`, `WasmSerde`)
- `src/session.ts`: session lifecycle + ordered inbound/outbound pumping
- `src/server_runtime.ts`: session + bridge + host-call pump integration
- `src/rpc_client.ts`: bootstrap/call/finish/release + pipelining transport
- `src/rpc_server.ts`: server dispatch bridge + answer table/pipelining
- `src/transports/*`: TCP, WebSocket, MessagePort adapters
- `src/framer.ts`: Cap'n Proto stream framing
- `tools/capnpc-deno/*`: TypeScript codegen CLI/plugin
- `tests/*`: fake-wasm unit, integration, and real-wasm tests
- `vendor/capnp-zig/`: canonical Zig implementation submodule

## Docs and Examples

- Docs index: `docs/README.md`
- Serde guide: `docs/getting_started_serde.md`
- RPC guide: `docs/getting_started_rpc.md`
- End-to-end walkthrough example: `examples/getting-started.ts`
- Real-wasm smoke example: `examples/smoke_real_wasm.ts`

## Important Notes

- `SessionRpcClientTransport.callRawPipelined(...)` never auto-finishes. Call
  `finish(questionId)` yourself when done.
- `RpcServerRuntime` host-call pumping requires optional WASM host-call bridge
  exports; if unavailable, pumping is disabled (or throws if explicitly forced).
- Generated files import `@nullstyle/capnp/codegen_runtime`. Ensure this import
  resolves in your environment.
