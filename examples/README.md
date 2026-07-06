# Examples

Each example is nested in its own directory and has a colocated `.capnp` schema
when it uses generated code.

## Golden Path

Start with `examples/ping/`. It is the canonical generated RPC example and
covers:

- generated typed clients and servers,
- TCP `connect(Pinger, TcpTransport.connect(...))`,
- TCP `serve(Pinger, TcpTransport.listen(...))`,
- WebSocket transport variants,
- cap-bearing params where the client passes a local `Ponger` callback and the
  server invokes it.

Run the TCP pair from two terminals:

```sh
just --justfile examples/Justfile run-ping-server
just --justfile examples/Justfile run-ping-client
```

Run the WebSocket pair from two terminals:

```sh
just --justfile examples/Justfile run-ping-ws-server
just --justfile examples/Justfile run-ping-ws-client
```

## Streaming RPC

`examples/streaming/` demonstrates generated Cap'n Proto `-> stream` methods
over TCP. The client uses the generated `createCounterSinkAddStreamSender(...)`
helper with `maxInFlight`, and the server receives each streamed `add(...)` call
with `RpcCallContext.signal` for cancellation.

Run the TCP pair from two terminals:

```sh
just --justfile examples/Justfile run-streaming-server
just --justfile examples/Justfile run-streaming-client
```

## Layout

- `examples/ping/`
  - `client.ts`
  - `server.ts`
  - `client_ws.ts`
  - `server_ws.ts`
  - `schema.capnp`
  - `gen/*`
- `examples/streaming/`
  - `client.ts`
  - `server.ts`
  - `schema.capnp`
  - `gen/*`
- `examples/kvstore_stress_2/`
  - `kvstore_stress_client.ts`
  - `kvstore.capnp`
  - `gen/*`
- `examples/smoke_real_wasm/`
  - `smoke_real_wasm.ts`
  - `smoke_real_wasm.capnp`
- `examples/webtransport_p2p/`
  - `peer.ts`
  - `runtime.ts`
  - `shared.ts`
  - `schema.capnp`
  - `gen/*`

## Task Runner

Use the example-specific Justfile:

```sh
just --justfile examples/Justfile --list
```

Run these commands from the repository root. `gen-*` tasks use the local
`deno task codegen` command and rewrite the matching `gen/` directory.

Common commands:

```sh
just --justfile examples/Justfile gen-rpc
just --justfile examples/Justfile run-ping-server
just --justfile examples/Justfile run-ping-client
just --justfile examples/Justfile run-ping-ws-server
just --justfile examples/Justfile run-ping-ws-client
just --justfile examples/Justfile run-streaming-server
just --justfile examples/Justfile run-streaming-client
just --justfile examples/Justfile run-kvstore-stress-2
just --justfile examples/Justfile run-smoke-real-wasm
just --justfile examples/Justfile run-webtransport-p2p-a
just --justfile examples/Justfile run-webtransport-p2p-b
```

## Which Stack?

- Use `connect()` and `serve()` for generated RPC over TCP, WebSocket, and
  WebTransport. This is the recommended path for application code.
- Use `SessionRpcClientTransport` for WASM-backed in-process or advanced harness
  flows.
- Use `RpcWireClient` only when you need direct Bootstrap/Call/Finish/Release
  control over a started transport.

## Troubleshooting

- `PermissionDenied` from `Deno.listen`, `Deno.connect`, or WebSocket
  construction usually means the command is missing `--allow-net` for the host
  and port.
- WebTransport examples require Deno WebTransport/QUIC APIs and
  `--unstable-net`.
- `transport does not support exporting local capabilities` means a generated
  callback object was passed through a custom transport that does not implement
  `exportCapability(...)`.
- `unknown capability` during callback testing usually means the callback stub
  has already been released or the remote side retained the wrong capability.
- WebSocket handshake failures are commonly caused by using the wrong path or
  subprotocol. The ping WebSocket default is `ws://127.0.0.1:4001/rpc` with
  protocol `capnp-rpc`.
- If generated imports or service tokens fail to type-check, regenerate the
  matching example with `just --justfile examples/Justfile gen-ping`,
  `just --justfile examples/Justfile gen-streaming`, or
  `just --justfile examples/Justfile gen-rpc`.
