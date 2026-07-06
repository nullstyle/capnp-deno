# Ping Example

This is the canonical generated RPC example for capnp-deno.

`schema.capnp` defines a bidirectional ping/pong pair:

- `Pinger.ping(p :Ponger)`
- `Ponger.pong(n :UInt32)`

The client passes a local `Ponger` implementation as a callback capability. The
server receives that cap-bearing param and calls `ponger.pong(count)` before the
original `ping()` call completes.

## TCP Golden Path

Run from the repository root in two terminals:

```sh
just --justfile examples/Justfile run-ping-server
just --justfile examples/Justfile run-ping-client
```

Equivalent commands:

```sh
deno run --allow-net=127.0.0.1:4000 examples/ping/server.ts
deno run --allow-net=127.0.0.1:4000 examples/ping/client.ts
```

The important shape is:

```ts
using pinger = await connect(
  Pinger,
  await TcpTransport.connect("127.0.0.1", 4000),
);

await pinger.ping({
  pong(count) {
    console.log(`Received pong with count ${count}`);
    return Promise.resolve();
  },
});
```

## WebSocket Variant

Run from the repository root in two terminals:

```sh
just --justfile examples/Justfile run-ping-ws-server
just --justfile examples/Justfile run-ping-ws-client
```

Equivalent commands:

```sh
deno run --allow-net=127.0.0.1:4001 examples/ping/server_ws.ts
deno run --allow-net=127.0.0.1:4001 examples/ping/client_ws.ts
```

Default WebSocket endpoint: `ws://127.0.0.1:4001/rpc` with protocol `capnp-rpc`.
The server also exposes a sibling HTTP route at `/api` to demonstrate
side-by-side routing with another handler.

## Regenerate

Regenerate the committed TypeScript outputs only after changing `schema.capnp`
or the generator:

```sh
just --justfile examples/Justfile gen-ping
```
