# capnp-deno Progress Report (2026-02-07)

## Snapshot

- Fast gate is green: `just verify` (`115 passed, 0 failed`).
- Codegen now emits three modules per schema:
  - `*_capnp.ts` (binary codecs),
  - `*_rpc.ts` (client + server-dispatch scaffolding),
  - `*_meta.ts` (schema/interface metadata).
- Far-pointer decode support is implemented and tested.
- A minimal session-backed RPC client transport path is implemented for
  fixture-compatible bootstrap/call flows.

## Overall Project List

1. API and package stability (`production_plan.md` workstream 1): `in_progress`
2. Runtime correctness and safety (workstream 2): `in_progress`
3. Transport reliability/backpressure/timeouts (workstream 3): `in_progress`
4. RPC ergonomics (workstream 4): `in_progress`
5. Serde and codegen integration (workstream 5): `in_progress`
6. Security and limits (workstream 6): `in_progress`
7. Observability (workstream 7):
   `deferred (low priority until feature complete)`
8. CI/interop/release automation (workstream 8):
   `in_progress (Justfile gates ready)`

## Completed Since Last Checkpoint

- `capnpc-deno` parser model extended for interface methods (`name`,
  `codeOrder`, param/result struct IDs).
- RPC/meta emit phase landed in generator:
  - `_rpc.ts` now emits:
    - method ordinals,
    - typed client interface + `create*Client(...)`,
    - typed server interface + `create*Server(...)` dispatch adapter.
  - `_meta.ts` now emits file/schema IDs, imports, node list, interface methods.
- Schema-layout output mapping updated to preserve `_capnp/_rpc/_meta` suffixes.
- Far-pointer support landed in request reader + generated runtime decode path.
- Added runtime wire tooling:
  - `src/rpc_wire.ts`: bootstrap/call/finish/release encoders, return
    encode/decode, and payload content extraction.
  - `src/rpc_client.ts`: payload-capable `SessionRpcClientTransport` with
    `finish`/`release` lifecycle support and `InMemoryRpcHarnessTransport`.
- Added host callback bridge runtime:
  - `src/rpc_server.ts`: capability export registry, call dispatch bridge, and
    lifecycle handling (`release`, `finish`).
- Generated RPC client flow now supports lifecycle hooks:
  - `tools/capnpc-deno/emitter.ts`: optional `finish`/`release` transport hooks
    and auto-finish wiring via `onQuestionId`.
- Added tests:
  - fixture parity for wire encode/decode,
  - fixture-backed session client flow with lifecycle frames,
  - generated server dispatch behavior,
  - generated client lifecycle hook behavior,
  - server bridge dispatch/lifecycle coverage.
- Added transport hardening increment for TCP:
  - bounded outbound queue limits (`maxQueuedOutboundFrames`,
    `maxQueuedOutboundBytes`),
  - send timeout (`sendTimeoutMs`),
  - read-idle timeout handling (`readIdleTimeoutMs`),
  - close timeout (`closeTimeoutMs`) and connect timeout (`connectTimeoutMs`).
  - regression tests in `tests/tcp_transport_test.ts`.
- Added transport hardening parity for WebSocket and MessagePort:
  - WebSocket: queue/backpressure controls (`maxQueuedOutboundFrames`,
    `maxQueuedOutboundBytes`, `maxSocketBufferedAmountBytes`) and timeout
    controls (`sendTimeoutMs`, `connectTimeoutMs`, `closeTimeoutMs`).
  - MessagePort: bounded outbound queue controls and queue-wait timeout
    (`maxQueuedOutboundFrames`, `maxQueuedOutboundBytes`, `sendTimeoutMs`).
  - regression tests in `tests/websocket_transport_test.ts` and updated
    `tests/message_port_transport_test.ts`.
- Added shared host-side Cap'n Proto frame limits module:
  - `src/frame_limits.ts` with `validateCapnpFrame(...)` and
    `CapnpFrameLimitsOptions` (`maxSegmentCount`, `maxFrameBytes`,
    `maxTraversalWords`, `maxNestingDepth`).
  - nested pointer traversal validates struct/list pointer graphs and resolves
    single-far + double-far pointers with bounded hop count.
- Wired host frame-limit enforcement across inbound transport paths:
  - TCP (`CapnpFrameFramer` path via `frameLimits`),
  - WebSocket (`frameLimits` option),
  - MessagePort (`frameLimits` option).
- Added resource-limit and stress/fuzz tests:
  - `tests/frame_limits_test.ts` for traversal/nesting checks including
    far/double-far cases.
  - `tests/frame_fuzz_test.ts` for deterministic random frame/parser stress.
  - transport-level inbound limit enforcement coverage in
    `tests/tcp_transport_test.ts`, `tests/websocket_transport_test.ts`, and
    `tests/message_port_transport_test.ts`.
- Expanded RPC payload cap-table semantics coverage:
  - `src/rpc_wire.ts` now encodes and decodes `Call` payload cap tables
    (`paramsCapTable`) in addition to `Return` payload cap tables.
  - `src/rpc_client.ts` now supports call payload cap-table injection via
    `RpcClientCallOptions.paramsCapTable` and exposes full result payload
    metadata via `SessionRpcClientTransport.callRaw(...)`.
  - `src/rpc_server.ts` now passes inbound payload cap tables through
    `RpcCallContext.paramsCapTable`, and dispatch handlers can return either raw
    bytes or a structured `RpcCallResponse` including result cap table and
    return flags.
  - regression coverage added in `tests/rpc_wire_test.ts`,
    `tests/rpc_client_transport_test.ts`, and `tests/rpc_server_bridge_test.ts`.
- Added API/export-surface hardening:
  - runtime public export snapshot test in `tests/public_api_surface_test.ts` to
    lock `mod.ts` runtime surface.
  - compile-time public type contract snapshot test in
    `tests/public_api_types_test.ts` to lock key exported type signatures and
    options.
  - typed error behavior checks in `tests/error_typing_test.ts` for
    `ProtocolError`, `SessionError`, `TransportError`, and `InstantiationError`.
- Added ABI capability shim for forward-compatible wasm negotiation:
  - `src/abi.ts` now snapshots optional ABI capabilities once on construction
    (`WasmAbi.capabilities`) including version-range and feature-flag exports.
  - version checks now support either exact `capnp_wasm_abi_version` or
    negotiated `capnp_wasm_abi_min_version`/`capnp_wasm_abi_max_version` range
    while preserving v1 fallback behavior.
  - added `supportsFeature(bit)` helper for feature-flag probing and exported
    `WasmAbiCapabilities` via `mod.ts`.
  - compatibility coverage added in `tests/abi_compat_test.ts` for:
    - v1-only export fallback behavior,
    - version-range + feature-flag detection,
    - negotiated version mismatch handling,
    - partial export-pair validation.
- Unified serde/runtime ABI capability handling:
  - `WasmAbi` now exposes shared helpers for output-buffer free and error
    extraction (`freeOutBuffer`, `takeLastError`, `throwLastError`) and uses
    `capnp_error_take` when available.
  - `WasmSerde` now routes buffer-free and error handling through shared
    `WasmAbi` helpers instead of duplicating capability checks.
- Added opt-in reconnect policy helpers (no implicit reconnect):
  - `src/reconnect.ts` with `createExponentialBackoffReconnectPolicy(...)` and
    `connectWithReconnect(...)`.
  - exported via `mod.ts`.
  - deterministic retry/abort coverage in `tests/reconnect_test.ts`.
- Added reconnect wrappers for transport/session startup wiring:
  - `src/reconnect_wrappers.ts` adds:
    - `connectTransportWithReconnect(...)`,
    - `connectTcpTransportWithReconnect(...)`,
    - `connectWebSocketTransportWithReconnect(...)`,
    - `createRpcSessionWithReconnect(...)`.
  - wrappers are exported via `mod.ts`.
  - deterministic wrapper coverage added in `tests/reconnect_wrappers_test.ts`.
- Added established-session reconnect loop strategy at client call layer:
  - `src/reconnecting_client.ts` adds `ReconnectingRpcClientTransport`.
  - reconnect flow includes:
    - reconnect-on-call-failure for reconnectable transport/session errors,
    - optional in-flight call retry (`retryInFlightCalls`, default `true`),
    - bootstrap capability remap via re-bootstrap on reconnect
      (`rebootstrapOnReconnect`, default `true`),
    - optional non-bootstrap capability remap callback
      (`remapCapabilityOnReconnect`) with per-call reconnect context,
    - explicit non-retriable semantics for `finish`/`release` across reconnect
      boundaries (question/capability IDs are treated as connection-scoped).
  - exported via `mod.ts` and documented in `README.md`.
  - deterministic behavior coverage added in
    `tests/reconnecting_client_test.ts`.

## Current Gaps

1. Transport hardening:
   - startup and established-session reconnect strategies are now available as
     explicit wrappers/client transport; deeper transport-native drop detection
     hooks can still be expanded.
2. API hardening:
   - runtime export and baseline type-signature compatibility snapshots are now
     in place; broader type-contract depth can still be expanded.
3. Upstream dependencies (`capnp-zig`):
   - feature flags/negotiation, instance-scoped errors, queue introspection,
     server callback ABI.

## Recommended Next Execution Order

1. Continue upstream `capnp-zig` ABI additions for feature negotiation and
   server callback bridge.
2. Then raise observability depth after feature completion.
