# capnp-zig Additions Needed For capnp-deno

Updated: 2026-02-07

## Goal

Define the exact upstream `capnp-zig` changes needed so `capnp-deno` can keep
RPC protocol/state-machine authority in Zig/WASM (not duplicated in TypeScript),
while preserving ABI v1 compatibility.

## Patch Set A: ABI Negotiation + Error Handling (P0)

Target files:

- `vendor/capnp-zig/src/wasm/capnp_host_abi.zig`
- `vendor/capnp-zig/docs/wasm_host_abi.md`
- `vendor/capnp-zig/tests/wasm_host_abi_test.zig` (new)

Add exports:

```c
u32 capnp_wasm_abi_min_version();
u32 capnp_wasm_abi_max_version();
u32 capnp_wasm_feature_flags_lo();
u32 capnp_wasm_feature_flags_hi();
u32 capnp_error_take(u32 out_code_ptr, u32 out_msg_ptr_ptr, u32 out_msg_len_ptr);
```

Notes:

- Keep `capnp_wasm_abi_version()` and current `capnp_last_error_*` API for
  compatibility.
- `capnp_error_take` should return `1` when an error exists and clear it
  atomically; message buffer must be host-freed via `capnp_buf_free`.

## Patch Set B: Queue/Backpressure Introspection + Limits (P0)

Target files:

- `vendor/capnp-zig/src/wasm/capnp_host_abi.zig`
- `vendor/capnp-zig/src/rpc/host_peer.zig`
- `vendor/capnp-zig/src/rpc/runtime.zig`
- `vendor/capnp-zig/tests/rpc_host_peer_test.zig`

Add exports:

```c
u32 capnp_peer_outbound_count(u32 peer);
u32 capnp_peer_outbound_bytes(u32 peer);
u32 capnp_peer_has_uncommitted_pop(u32 peer);
u32 capnp_peer_set_limits(u32 peer, u32 max_segments, u32 max_frame_bytes, u32 max_traversal_words, u32 max_nesting_depth);
u32 capnp_peer_get_limits(u32 peer, u32 out_max_segments_ptr, u32 out_max_frame_bytes_ptr, u32 out_max_traversal_words_ptr, u32 out_max_nesting_depth_ptr);
```

Notes:

- `0` in `set_limits` means "use runtime default" for that field.
- `pop/commit` misuse should set a dedicated error code (new constant).

## Patch Set C: Structured Serde/Schema Metadata (P0)

Target files:

- `vendor/capnp-zig/src/wasm/capnp_host_abi.zig`
- `vendor/capnp-zig/src/capnpc-zig/generator.zig`
- `vendor/capnp-zig/docs/wasm_host_abi.md`
- `vendor/capnp-zig/tests/codegen_generated_runtime_test.zig`

Add export:

```c
u32 capnp_schema_manifest_json(u32 out_ptr_ptr, u32 out_len_ptr);
```

Manifest should include:

- schema/file IDs,
- serde codec pairs (`key`, `toJsonExport`, `fromJsonExport`),
- interface IDs + method ordinals.

This removes hard-coded TypeScript export-name wiring in codegen/runtime.

## Patch Set D: Host Server Callback Bridge (P1, Critical For GA)

Target files:

- `vendor/capnp-zig/src/wasm/capnp_host_abi.zig`
- `vendor/capnp-zig/src/rpc/host_peer.zig`
- `vendor/capnp-zig/src/rpc/protocol.zig`
- `vendor/capnp-zig/tests/rpc_host_peer_test.zig`
- `vendor/capnp-zig/tools/gen_rpc_fixtures.zig`

Add exports:

```c
u32 capnp_peer_pop_host_call(
  u32 peer,
  u32 out_call_id_ptr,
  u32 out_interface_id_lo_ptr,
  u32 out_interface_id_hi_ptr,
  u32 out_method_id_ptr,
  u32 out_target_cap_ptr,
  u32 out_params_ptr_ptr,
  u32 out_params_len_ptr,
  u32 out_params_caps_ptr_ptr,
  u32 out_params_caps_len_ptr
);

u32 capnp_peer_respond_host_call_results(
  u32 peer,
  u32 call_id,
  u32 content_ptr,
  u32 content_len,
  u32 cap_table_ptr,
  u32 cap_table_len,
  u32 release_param_caps,
  u32 no_finish_needed
);

u32 capnp_peer_respond_host_call_exception(
  u32 peer,
  u32 call_id,
  u32 reason_ptr,
  u32 reason_len
);
```

Notes:

- This lets host code handle server dispatch without re-implementing protocol
  framing/parsing in TypeScript.
- `cap_table_ptr/len` encodes fixed-width cap descriptors (binary, not JSON).

## Patch Set E: Capability/Question Lifecycle Helpers (P1)

Target files:

- `vendor/capnp-zig/src/wasm/capnp_host_abi.zig`
- `vendor/capnp-zig/src/rpc/peer.zig`
- `vendor/capnp-zig/tests/rpc_peer_test.zig`

Add exports:

```c
u32 capnp_peer_send_finish(u32 peer, u32 question_id, u32 release_result_caps, u32 require_early_cancellation);
u32 capnp_peer_send_release(u32 peer, u32 cap_id, u32 reference_count);
```

These make client lifecycle handling first-class and reduce host-side frame
construction drift.

## Acceptance Criteria (Upstream)

Required tests before submodule bump:

1. ABI negotiation tests for old/new symbol combinations.
2. Error-take tests showing deterministic clear/read behavior.
3. Queue stats + `pop/commit` misuse tests.
4. Limits enforcement tests (segment/frame/traversal/nesting).
5. Host callback bridge roundtrip tests for call/results/exception.
6. Lifecycle helper tests for `finish`/`release`.
7. Fixture regeneration and parity checks (`zig build gen-rpc-fixtures`).

## capnp-deno Integration Plan

After each upstream patch set lands:

1. Add feature-detected shims in `src/abi.ts`.
2. Route runtime logic to new ABI paths (`src/rpc_client.ts`,
   `src/rpc_server.ts`, `src/reconnecting_client.ts`).
3. Refresh fixtures and run local gates:
   - `just ci-fast`
   - `just ci-integration`
   - `just ci-real`
   - `just vendor-test` (when vendor changes)

## Rollout Order

1. Patch Set A
2. Patch Set B
3. Patch Set C
4. Patch Set D
5. Patch Set E

Observability-specific additions remain deferred until feature-complete parity.
