# DX V2 Contract (Phase 0)

Updated: 2026-02-11

This document locks the V2 API contract that implementation phases build
against.

## 1) Metadata Model

V2 generated code must export runtime service tokens.

Per interface:

- `export interface Pinger { ... }` (type contract)
- `export const Pinger: RpcServiceToken<Pinger>` (runtime metadata token)

V2 runtime APIs consume the token, not only a type parameter.

## 2) TCP API Surface

Client:

```ts
using pinger = await TCP.connect(Pinger, "127.0.0.1", 4000);
```

Server:

```ts
TCP.serve(Pinger, "127.0.0.1", 4000, PingServer);
```

`PingServer` may be:

- an object implementing `Pinger`, or
- a class/constructor `(peer: RpcPeer) => Pinger`.

If class/constructor is used, one instance is created per connection.

## 3) Method Shape Lowering

Generated TypeScript method signatures map from Cap'n Proto param/result structs
as follows:

- 0 fields: no argument / `Promise<void>`
- 1 field: scalar argument / `Promise<scalar>`
- 2+ fields: object argument / `Promise<object>`

Capability-typed fields follow capability mapping rules below.

## 4) Capability Mapping

For interface-typed fields:

- inbound params/results decode to `RpcStub<TInterface>`
- outbound args accept `TInterface | RpcStub<TInterface>`

This enables callback patterns:

```ts
await pinger.ping(new ClientPonger());
```

and server-side callback use:

```ts
async ping(p: RpcStub<Ponger>): Promise<void> {
  await p.pong(1);
}
```

## 5) Connection And Disposal

`TCP.connect(...)` returns an async-disposable typed stub.

- supports `using ... = await TCP.connect(...)`
- connection close is idempotent

`TCP.serve(...)` returns a closeable server handle.

If a per-connection server instance implements `Symbol.dispose` or
`Symbol.asyncDispose`, it is invoked on disconnect/close.

## 6) Defaulting And Naming Rules

- Method and field names remain camelCased from schema identifiers.
- Method ordinal collisions keep deterministic suffixing rules from existing
  emitter behavior.
- Existing interface inheritance behavior remains supported.

## 7) Rollout Decision

V2 is the default target path.

Legacy generated `*_rpc.ts` helpers remain temporarily as compatibility shims
and are removed after V2 parity + migration docs are complete.
