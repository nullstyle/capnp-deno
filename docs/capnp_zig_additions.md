# capnp-zig Additions For capnp-deno (Post-b930f51)

Updated: 2026-02-07 Evaluated submodule commit: `vendor/capnp-zig@b930f51`

## Status summary

The latest capnp-zig revision closed the prior P0 blockers for capnp-deno:

1. RPC fixture generator parity with wasm-host defaults: landed.
2. Host-call frame ownership release export:
   `capnp_peer_free_host_call_frame(peer, frame_ptr, frame_len)`: landed.
3. Bootstrap stub identity helper:
   `capnp_peer_set_bootstrap_stub_with_id(peer, out_export_id_ptr)`: landed.

capnp-deno can now integrate host-call pumping without the previous
ownership-gap workaround posture.

## Remaining upstream asks

## P1: Host-call results API still cannot express return cap tables/flags

Observed in `src/rpc/host_peer.zig`:

- `respondHostCallResults(...)` clones payload content and always calls
  `ret.setEmptyCapTable()`.
- Return flags are not host-configurable (`release_param_caps` and
  `no_finish_needed` stay default).

Impact in capnp-deno:

- Server bridge currently rejects `RpcCallResponse.capTable` and non-default
  return flags for wasm host-call responses.

Recommended upstream addition:

1. Add an extended ABI export, for example:
   `capnp_peer_respond_host_call_results_ex(...)`, that accepts payload content,
   cap-table descriptors, and return flags.
2. Add a corresponding feature flag bit to advertise support.
3. Add wasm ABI tests that assert cap-table and flag roundtrip behavior.

## P2: Optional “raw return frame” host response path

For maximum host flexibility, consider a raw escape hatch:

- `capnp_peer_respond_host_call_return_frame(peer, frame_ptr, frame_len)`.

This would let advanced hosts build full `Return` frames directly while keeping
the simpler typed helper exports.
