# capnp-zig integration and ABI ownership

Updated: 2026-09-15 UTC. The evaluated runtime source is
`vendor/capnp-zig@295ff5ea766bea3383485847a89b81884c61f969`. The
[runtime pin](../tools/runtime-toolchain.json) is authoritative for the source,
Zig and Binaryen versions, and build flags. The
[artifact receipt](../generated/capnp_deno.provenance.json) records the exact
WASM bytes, ABI, exports, and features; verify it with `deno task check:wasm`.

## Compiler and runtime are separate

capnpc-deno uses the separately pinned capnp-wasm compiler host to turn schemas
into `CodeGeneratorRequest`. The capnp-zig WASM artifact provides the RPC peer
and low-level serde exports used by the published runtime. Loading that runtime
does not acquire or execute a schema compiler. See
[Toolchains and artifact delivery](toolchains.md) for acquisition, clean
rebuild, and standalone compiler commands.

The current runtime advertises ABI version **1**, supported range **1–1**, and
feature words **1023 / 0**. It has 38 export entries and no imports. The host
checks version compatibility before allocating scratch and checks optional
exports and feature bits before using their contracts. Advancing the gitlink
does not itself extend the WASM interface.

## Ownership at the WASM boundary

Follow the pinned upstream
[ABI contract](../vendor/capnp-zig/docs/wasm_host_abi.md). The distinct buffer
lifetimes are:

| Buffer                                 | Ownership                                     | Required release                                                       |
| -------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| `capnp_alloc` input or scratch         | Host-owned                                    | Free the original base with the exact requested length, including zero |
| Schema-manifest and serde outputs      | Host-owned                                    | `capnp_buf_free(ptr, returnedLength)`, preserving zero                 |
| Outbound frame                         | Borrowed from its peer                        | Copy, then commit the pop; never free as an ordinary buffer            |
| Host-call frame                        | Host releases it through its originating peer | `capnp_peer_free_host_call_frame(peer, ptr, len)`                      |
| Last-error and `capnp_error_take` text | Borrowed shared error storage                 | Copy immediately; never free                                           |

Memory operations can clear the shared error slot. Capture a failure before
cleanup, and do not replace it with a cleanup error. A failed exact-length free
leaves the allocation live and reports `InvalidFree`; rounding an owned
zero-length output to one is incorrect. Host input helpers that deliberately
request one byte for an empty input must instead free that one-byte allocation.

WASM input ranges must belong to tracked allocations, not merely fit inside
linear memory. The current ABI tracks at most 1,024 ordinary allocations and 32
MiB of requested allocation sizes per instance. These limits do not cover the
entire heap, peer queues, or host-call frame storage.

### Peer, wrapper, and module disposal

- `WasmPeer.create(abi)` borrows its ABI wrapper. Close the peer, then close the
  caller-owned ABI after its last peer closes.
- `WasmPeer.fromInstance()` and `fromExports()` own their ABI wrapper. Closing
  their peer requests scratch disposal; any existing peers borrowing that same
  wrapper may finish before its scratch is freed. New peers are refused once
  disposal is requested.
- `WasmAbi.close()` releases wrapper scratch and refuses while its peers remain
  live. Other wrappers using the same module remain usable.
- `WasmSerde.close()` releases its scratch and requests disposal of its ABI
  wrapper. Codecs created by that serde become unusable; existing peers
  borrowing its ABI may finish. `using` provides the same cleanup through
  `Symbol.dispose`.
- `WasmAbi.shutdown()` is an explicit module-wide operation. It refuses live
  peers and other tracked ABI wrappers sharing the module. Callers remain
  responsible for resources created directly through raw exports. Ordinary peer
  and serde closure never invokes global shutdown.

Failed constructors unwind acquired scratch and peer state. The maintained
[real ownership tests](../tests/wasm/real_wasm_ownership_test.ts) exercise
zero-length outputs, borrowed errors, failed operations followed by recovery,
shared wrappers, and 2,000-cycle peer/serde soaks beyond the former 512-cycle
failure. These fixes were exercised against both the original bundled artifact
and the refreshed runtime during migration.

## Runtime integration and evidence

The host-call bridge forwards raw Return frames, including capability tables and
return flags. It mirrors bootstrap answers emitted by WASM before dispatching
pipelined host calls, retains answer/capability references through Finish and
Release, and terminates the connection on answer-table overflow. Maintained
[real RPC tests](../tests/wasm/real_wasm_rpc_flow_test.ts) and
[service tests](../tests/wasm/real_wasm_service_flow_test.ts) cover these paths.

The reviewed native Zig generator fix in the pinned revision prevents a failed
ordinary method from poisoning a later stream or ordinary call. Actual streaming
failures retain their sticky failure semantics. The standing
[native interoperability matrix](../tests/interop/native/README.md) builds
source-matched Zig and C++ peers and checks Deno in both caller/server roles,
including callbacks, returned capabilities, cancellation with terminal replies,
errors, streaming barriers, and cleanup. Client grant records outlive canceled
waiters and settle on the first terminal reply, preserving separately held
references; their configurable count bound is documented with streaming limits.

[Wire conformance tests](../tests/wasm/real_wasm_wire_conformance_test.ts)
compare the current WASM and independent TS reader/copy on double-far content,
present empty structs, malformed Text, child bounds, evolved fields, and
rejected cyclic/amplified copies. Real result-frame tests additionally check
capability routing, Finish cleanup, and parameter grants surviving rejected
copies. The [TS evolution/copy tests](../tests/interop/wire_evolution_test.ts)
exercise configurable copy budgets; WASM uses its own default limits and error
taxonomy. Native typed legacy-list decoding is not exposed through the untyped
WASM clone: both untyped paths reject historical Layout A lists instead of
misreading them as structs.

Native reflection, full generics, native QUIC changes, and expanded L3/L4 RPC
features are not automatically Deno features. Deno owns its transport and
streaming admission implementations; their current bounds and platform limits
are documented in [Streaming RPC](streaming.md) and
[Deno WebTransport limitations](toolchains.md#deno-webtransport-limitations).
See the [sprint delivery record](modernization_sprint.md#delivery-status) for
validation scope and hosted results.
