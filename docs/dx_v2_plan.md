# DX V2 Plan (Ping-Style API)

Updated: 2026-02-11

## Goal

Adopt the developer experience shown in `examples/ping`, centered around:

- generated service interfaces in a single `gen/types.ts`,
- high-level `TCP` connect/serve helpers,
- capability stubs passed as ordinary method arguments,
- minimal transport/runtime ceremony in app code.

## Target API Shape

Reference sample:

- `examples/ping/server.ts`
- `examples/ping/client.ts`
- `examples/ping/schema.capnp`

Intended shape:

```ts
import { RpcPeer, RpcStub, TCP } from "@nullstyle/capnp";
import { Pinger, Ponger } from "./gen/types.ts";

class PingServer implements Pinger {
  constructor(private readonly peer: RpcPeer) {}
  async ping(p: RpcStub<Ponger>): Promise<void> {
    await p.pong(1);
  }
}

TCP<Pinger>.serve("127.0.0.1", 4000, PingServer);
```

```ts
import { TCP } from "@nullstyle/capnp";
import { Pinger, Ponger } from "./gen/types.ts";

using pinger = await TCP<Pinger>.connect("127.0.0.1", 4000);

class ClientPonger implements Ponger {
  pong(n: number) {
    console.log(n);
  }
}

await pinger.ping(new ClientPonger());
```

## Current Gap

Current generated/runtime path is centered on:

- `*_capnp.ts` + `*_rpc.ts` + `*_meta.ts`,
- `register*Server(...)`, `create*Client(...)`, `bootstrap*Client(...)`,
- manual transport/runtime wiring (`RpcServerRuntime`,
  `SessionRpcClientTransport`, `TcpRpcClientTransport`),
- params/results struct wrappers for every method call.

This differs from the ping-style API in both generated shape and runtime
entrypoints.

## Critical Design Decision (Must Settle First)

How runtime obtains interface metadata (interface id, ordinals, codecs) for
`TCP<T>`:

1. Explicit token: `TCP.connect(Pinger, host, port)` and
   `TCP.serve(Pinger, ...)`.
2. Generated metadata registration + resolver by implementation/signature.
3. Generated abstract classes with static metadata (instead of plain
   interfaces).

Decision: use explicit generated runtime tokens in V2.

Why:

- Type parameters are erased at runtime, so `TCP<Pinger>.connect(...)` cannot
  safely recover interface IDs/codecs on its own.
- Explicit tokens keep dispatch and marshaling deterministic.
- We can still generate ergonomic wrappers later.

## Execution Plan

### Phase 0: API Contract Lock

Status: Done (contract locked in `docs/dx_v2_contract.md`)

- Freeze V2 call-shape rules from schema:
  - zero-field params -> no argument,
  - one-field params -> scalar argument,
  - multi-field params -> object argument,
  - same rule for results (`Promise<void>`, scalar, or object).
- Define capability mapping:
  - inbound capability param -> `RpcStub<T>`,
  - outbound capability arg accepts `T | RpcStub<T>`,
  - interface-typed results decode to `RpcStub<T>`.
- Define lifecycle contracts:
  - `TCP.connect(...)` returns `AsyncDisposable`,
  - `TCP.serve(...)` returns closeable server handle.

### Phase 1: Runtime V2 Surface

Status: In progress (token types + `TCP.connect`/`TCP.serve` scaffolding landed)

- Add V2 types and exports:
  - `RpcPeer`,
  - `RpcStub<T>`,
  - `TCP` high-level API.
- Build `TCP.connect(...)` on top of `TcpTransport` + `TcpRpcClientTransport`.
- Build `TCP.serve(...)` on top of `TcpServerListener` +
  `RpcServerRuntime.createWithRoot(...)`.
- Add connection-scoped peer context for server constructors and disposal hooks.

### Phase 2: Codegen V2 Emitter

Status: Done (`*_types.ts` is the canonical generated module; `*_capnp.ts` and
`*_rpc.ts` are compatibility re-export shims)

- Add V2 emitter mode (initially side-by-side with legacy):
  - emit `types.ts` service interfaces + hidden metadata,
  - emit adapters needed by V2 runtime (client proxy + server dispatch),
  - keep serde descriptors/codecs available internally for marshaling.
- Keep compatibility import paths by emitting thin `*_capnp.ts` and `*_rpc.ts`
  re-export shims that forward to `*_types.ts`.
- Ensure interface inheritance remains supported.
- Ensure deterministic output and stable naming/collision handling.

### Phase 3: Capability Stub Plumbing

- Implement runtime capability export/import bridge used by V2 method calls.
- Auto-wrap local implementations passed as capability args into exported
  capabilities.
- Decode received capability pointers into typed `RpcStub<T>` proxies.
- Enforce finish/release behavior to avoid capability/question leaks.

### Phase 4: CLI + Output Layout

- Add codegen switch for V2 (`--api v2` or equivalent).
- Define output layout for V2 (`gen/types.ts` single-schema path + deterministic
  multi-schema layout).
- Update plugin mode behavior (`capnp compile -odeno:...`) to support V2 layout.

### Phase 5: Tests, Examples, Docs

- Add V2 golden codegen tests.
- Add V2 type-check fixture tests.
- Add V2 TCP integration test mirroring `examples/ping`.
- Update primary docs and README to make V2 the recommended path once stable.
- Keep legacy-path tests while V2 is rolling out.

### Phase 6: Rollout

- Ship V2 as the default path.
- Keep legacy generated RPC helpers only as compatibility shims during
  transition.
- Remove legacy generated RPC helpers after V2 parity + migration docs land.

## Acceptance Criteria

- `examples/ping` runs end-to-end over TCP with no manual runtime/bridge wiring.
- Generated `gen/types.ts` provides all user-facing API for typical RPC usage.
- Capability callback flow (`pinger.ping(clientImpl)`) works and is covered by
  integration tests.
- `deno task check`, unit, integration, and codegen golden tests pass with V2
  enabled.

## Suggested PR Sequence

1. V2 API contract doc + runtime scaffolding (`RpcPeer`, `RpcStub`, `TCP`
   shell).
2. Codegen V2 emitter as default path + golden/type fixtures + legacy shims.
3. Capability plumbing + ping integration test.
4. Docs/examples migration + default-switch prep.
