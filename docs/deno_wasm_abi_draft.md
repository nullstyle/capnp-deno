# Deno WASM ABI Draft (Compatibility Note)

Updated: 2026-02-07

The canonical ABI specification is now language-neutral:

- `docs/wasm_host_abi.md`

Use that document as the source of truth for exported symbols, memory ownership,
error handling, RPC frame pump behavior, and serde ABI shape.

`capnp-deno` should be treated as one host binding over the same ABI contract.
