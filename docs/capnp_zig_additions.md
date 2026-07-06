# capnp-zig Additions For capnp-deno

Updated: 2026-07-05 Evaluated submodule commit:
`vendor/capnp-zig@dd41e5bc4268c1b66a6c593d3e487e79c1b0ba69`

## Status summary

The current capnp-zig integration includes the runtime features capnp-deno needs
for Deno-facing callback and pipelining coverage:

1. QUIC dependency update to `quic_zig` 0.7.0.
2. Level-3 RPC forwarded parked-call support for cap-bearing params/results.
3. Cross-peer proxy teardown regression coverage and hardening.
4. QUIC loop-drive changes where `Connection.advance()` is driven every loop
   turn.
5. Explicit self-signed/loopback client verification opt-out in upstream QUIC
   tests; capnp-deno WebTransport loopback continues to use certificate hashes.

The host-call bridge path remains production-capable for advanced `Return`
responses, including cap tables and non-default return flags via raw return
frame passthrough.

## Integration verification in capnp-deno

Validated against this submodule revision:

- Real-WASM service flow covers host-call return-frame bridging and cap-bearing
  results.
- Generated Ping/Ponger flow covers cap-bearing params and local callback
  exports while the original call remains pending.
- High-level `connect()`/`serve()` socket integration covers generated callbacks
  over TCP, WebSocket, and WebTransport when the Deno runtime exposes
  WebTransport/QUIC APIs.

## Remaining upstream asks

No P0/P1 blockers remain for capnp-deno integration on the current roadmap.

Optional future ergonomics:

1. A typed helper like `capnp_peer_respond_host_call_results_ex(...)` could
   simplify hosts that do not want to construct raw return frames directly.
2. A canonical machine-readable ABI manifest (symbol + feature-bit map) would
   reduce host/runtime drift risk across language bindings.
