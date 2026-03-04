# Ping Example

`schema.capnp` defines a bidirectional ping/pong RPC pair:

- `Pinger.ping(p :Ponger)`
- `Ponger.pong(n :UInt32)`

## TCP Variant

- Server: `server.ts`
- Client: `client.ts`

## WebSocket Variant

- Server: `server_ws.ts`
- Client: `client_ws.ts`

Run from the repository root:

```sh
just --justfile examples/Justfile run-ping-ws-server
just --justfile examples/Justfile run-ping-ws-client
```

Optional server args:

```sh
deno run --allow-net examples/ping/server_ws.ts <host> <port> <ws-path> <sibling-api-path> <protocol>
```

Optional client args:

```sh
deno run --allow-net examples/ping/client_ws.ts <ws-url> <protocol> <ping-count>
```

Default WebSocket endpoint: `ws://127.0.0.1:4001/rpc` with protocol `capnp-rpc`.
The server also exposes a sibling HTTP route (default: `/api`) to demonstrate
side-by-side routing with another handler.
