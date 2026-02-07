# Deno + WASM Integration Feasibility (capnpc-zig)

Updated: 2026-02-07

## Executive Summary

Feasibility is **high** for:

- message serialization/deserialization in WASM,
- frame-level Cap'n Proto RPC processing in WASM,
- Deno-owned async transport/event loop.

Feasibility is **medium** for:

- full typed RPC client/server ergonomics in Deno backed by WASM,
- JSON/"serde" parity with schema-driven behavior.

Feasibility is **low** for:

- directly reusing `libxev` networking inside Deno WASM at runtime.

## What The Current Codebase Already Gives Us

### 1) RPC core is almost transport-agnostic

`Peer` can now run detached from `Connection`.

- detached constructor: `Peer.initDetached(...)`
- host transport hooks: `attachTransport(...)`, `detachTransport(...)`
- optional adapter: `attachConnection(...)` for native `Connection`

There is already an outbound interception hook:

- `Peer.setSendFrameOverride(...)` in `src/rpc/peer.zig`

This is the critical seam for a host-owned transport (Deno TCP/WebSocket/worker
channel).

### 2) `libxev` coupling is concentrated

`libxev` is concretely bound in:

- `src/rpc/runtime.zig`
- `src/rpc/connection.zig`
- `src/rpc/transport_xev.zig`

Core protocol/capability logic is in:

- `src/rpc/peer.zig`
- `src/rpc/protocol.zig`
- `src/rpc/cap_table.zig`
- `src/rpc/framing.zig`

### 3) Existing tests already emulate detached transport

`Peer` tests now include explicit detached-mode behavior (`initDetached`,
missing transport error path), and `HostPeer` tests exercise a host-driven frame
pump (`pushFrame`/`popOutgoingFrame`).

## Empirical Probe Results

### A) Why `zig build check -Dtarget=wasm32-freestanding` failed

This fails because `check` compiles the CLI executable (`src/main.zig`), which
is host/posix/thread dependent; it is not a library-level wasm compatibility
signal.

### B) Core message/RPC modules compile for WASM

`capnpc-zig-core` compiles for `wasm32-freestanding`:

- `zig build-lib -Mroot=src/lib_core.zig -target wasm32-freestanding -fno-emit-bin`

This validates the detached/core module path without relying on the native
`libxev` runtime.

### C) End-to-end Deno WASM PoC succeeded

I built a wasm module that uses `message.MessageBuilder` and `message.Message`
and ran it in Deno.

Observed Deno output:

- exports include `memory` and capnp functions
- message build length: `24`
- parse roundtrip of `0x12345678` returned `305419896`

This demonstrates the core binary wire layer is practical from Deno via WASM.

## Deno Platform Constraints That Affect Design

1. Deno supports standard WebAssembly APIs (`instantiate`,
   `instantiateStreaming`).
2. Deno docs call out that non-numeric Wasm value types require generated JS
   binding shims.
3. Deno `node:wasi` is documented as non-functional stubs (do not base runtime
   design on WASI host support in Deno).
4. `Deno.connect` is currently marked unstable and requires `--unstable-net` and
   `--allow-net`.

Implication: treat Deno as **the async IO owner**, and keep WASM core
synchronous and deterministic.

## Recommended Architecture

### Recommendation: introduce `capnp-deno` package

Keep this repository focused on Zig core/runtime; add a separate package that
depends on this repo and ships:

- a wasm build of core functionality,
- TypeScript transport + ergonomic wrappers,
- optional schema/codegen helpers for TS + serde.

This avoids forcing Deno-specific concerns into the native runtime path.

## Proposed layering

1. `capnpc-zig` (this repo)

- canonical wire format + protocol + peer state machine.
- native `libxev` runtime remains available.

2. `capnp-deno` (new package)

- owns Deno network primitives/event loop.
- instantiates WASM core.
- adapts byte streams to `Peer.handleFrame()` and outgoing frame queue.

## Minimal upstream changes in `capnpc-zig`

Current status (2026-02-06 in this branch):

- implemented: `src/lib_core.zig` + `src/rpc/mod_core.zig` and build module
  `capnpc-zig-core`
- implemented: detached peer construction (`Peer.initDetached`) + transport
  attachment helpers
- implemented: `rpc.peer` decoupled from compile-time `connection.zig`/`xev`
  import via generic connection adapter in `Peer.attachConnection(...)`
- implemented: host-facing frame queue wrapper (`rpc/host_peer.zig`)
- implemented: wasm ABI export entrypoint (`src/wasm/capnp_host_abi.zig`) with
  `zig build wasm-host` (`zig build wasm-deno` remains a compatibility alias)

1. Add a core-only export surface without mandatory xev runtime exposure

- now exports `message`, `schema`, and
  `rpc.{framing,protocol,cap_table,peer,host_peer}`.

2. Add detached peer construction

- e.g. `Peer.initDetached(allocator)` or make `conn` optional.
- behavior: if no connection, require `send_frame_override` for any outbound
  send.

3. Add host-facing frame queue wrapper

- e.g. `rpc/host_peer.zig`:
  - `pushFrame(frame)` (host -> peer)
  - `popOutgoingFrame()` (peer -> host)
- Internally uses `setSendFrameOverride` to enqueue bytes.

4. Add a stable wasm ABI export layer

- `src/wasm/capnp_host_abi.zig` exports allocator/error/peer pump functions.
- build entrypoint: `zig build wasm-host` -> `zig-out/bin/capnp_wasm_host.wasm`
  (`wasm-deno` alias still available).
- canonical ABI spec: `docs/wasm_host_abi.md` (language-neutral; host bindings
  layer on top).

These changes keep native runtime code intact while giving WASM hosts a stable
integration point.

## RPC Transport Model in Deno

Deno should manage all async primitives:

- TCP (`Deno.connect` / `Deno.listen`)
- WebSocket (`Deno.upgradeWebSocket` on server side, `WebSocket` client)
- in-process channels (`MessagePort`, worker messaging)

WASM core responsibilities:

- parse inbound frames,
- mutate capability/question/answer tables,
- emit outbound frames.

Host responsibilities:

- scheduling, retries, backpressure,
- framing boundary handling at stream edges,
- draining all outbound frames after each inbound frame is processed,
- permissions and lifecycle.

## "Serde" Support Plan

For Deno, "serde" should mean schema-aware conversion between JS objects and
Cap'n Proto messages.

### Phase 1 (pragmatic)

- Provide generated TS wrappers with:
  - `encode(obj) -> Uint8Array`
  - `decode(bytes) -> obj`
- Start with structs/enums/lists/text/data.
- Explicitly exclude capabilities/any-pointer JSON mapping initially.

### Phase 2

- Add defaults + unions + nested interface payload mapping.
- Add canonical JSON mode for deterministic snapshots/tests.

### Phase 3

- Add optional schema-driven generic path (reflection) for dynamic tooling.

## Risks

1. RPC callback model is Zig-function-pointer-centric today; JS-side handler
   bridging needs explicit API surface.
2. Capability-heavy RPC server-side integration (exported handlers invoked from
   JS) is more complex than client-only flows.
3. If Deno net APIs remain unstable, package UX must pin versions/flags and
   expose clear transport adapters.

## Suggested Milestones

1. **M1: Core extraction + detached peer**

- status: completed in this branch.
- no behavior changes for native xev path.

2. **M2: capnp-deno PoC package**

- status: prototype extracted into a dedicated `capnp-deno` repository.
- includes typed ABI bindings, `WasmPeer`, `RpcSession`, real
  MessagePort/WebSocket/TCP transports, and framing parser.
- wired to real Zig wasm exports (`src/wasm/capnp_host_abi.zig`) with smoke
  validation.
- includes live loopback integration tests over real sockets (TCP + WebSocket
  transport adapters).
- includes in-process loopback integration tests over `MessageChannel` via
  `MessagePortTransport`.
- includes real-wasm RPC bootstrap/call-flow tests in TypeScript using
  deterministic fixtures (in the `capnp-deno` repo).
- includes both error-path and success-path bootstrap coverage (success path
  enabled via optional wasm export `capnp_peer_set_bootstrap_stub`).

3. **M3: Serde MVP**

- host-side serde bridge implemented in the `capnp-deno` repo:
  - `WasmSerde.decodeToJson(exportName, bytes)`
  - `WasmSerde.encodeFromJson(exportName, json)`
  - `WasmSerde.createJsonCodec(...)` for typed wrappers
- schema-specific wasm exports are now live for generated `Person`:
  - `capnp_example_person_to_json`
  - `capnp_example_person_from_json`
- exports are wired in `src/wasm/capnp_host_abi.zig` using generated schema code
  at `src/wasm/generated/example.zig`, with real-wasm serde tests in the
  `capnp-deno` repo.
- remaining: generalize from single-schema export wiring to capnpc-driven
  multi-schema emit.

4. **M4: Full RPC ergonomics**

- promise-based question tracking and server handler bridging.

## External References

- Deno WebAssembly reference: https://docs.deno.com/runtime/reference/wasm/
- Deno `WebAssembly.instantiate`:
  https://docs.deno.com/api/web/~/WebAssembly.instantiate
- Deno `WebAssembly.instantiateStreaming`:
  https://docs.deno.com/api/web/~/WebAssembly.instantiateStreaming
- Deno `Deno.connect` (unstable + permission flags):
  https://docs.deno.com/api/deno/~/Deno.connect
- Deno Node compatibility `node:wasi` (non-functional stubs):
  https://docs.deno.com/api/node/wasi/
- Deno `Deno.serve`: https://docs.deno.com/api/deno/~/Deno.serve
- Deno `Deno.upgradeWebSocket`:
  https://docs.deno.com/api/deno/~/Deno.upgradeWebSocket
