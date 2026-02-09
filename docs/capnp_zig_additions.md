# capnp-zig Additions For capnp-deno (Post-364909f)

Updated: 2026-02-09 Evaluated submodule commit: `vendor/capnp-zig@364909f`

## Status summary

The latest capnp-zig revision closed the prior blockers for capnp-deno:

1. RPC fixture generator parity with wasm-host defaults: landed.
2. Host-call frame ownership release export:
   `capnp_peer_free_host_call_frame(peer, frame_ptr, frame_len)`: landed.
3. Bootstrap stub identity helper:
   `capnp_peer_set_bootstrap_stub_with_id(peer, out_export_id_ptr)`: landed.
4. Raw host-call return-frame response export:
   `capnp_peer_respond_host_call_return_frame(peer, return_frame_ptr, return_frame_len)`:
   landed.
5. Feature flag bit `8` (`HOST_CALL_RETURN_FRAME`) and error mapping for invalid
   return-frame responses: landed.

capnp-deno now has a production-capable host-call bridge path for advanced
`Return` responses (cap tables and non-default return flags) via raw return
frame passthrough.

## Integration verification in capnp-deno

Validated against this submodule revision:

- `just verify-real` passes.
- `just ci` passes.
- Real-WASM service flow and RPC lifecycle tests remain green, including
  explicit finish/release and advanced host-call return-frame bridging.

## Remaining upstream asks

No P0/P1 blockers remain for capnp-deno integration on the current roadmap.

Optional future ergonomics (non-blocking):

1. A typed helper like `capnp_peer_respond_host_call_results_ex(...)` could
   simplify hosts that do not want to construct raw return frames directly.
2. A canonical machine-readable ABI manifest (symbol + feature-bit map) would
   reduce host/runtime drift risk across language bindings.
