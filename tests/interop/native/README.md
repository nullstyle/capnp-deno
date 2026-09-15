# Native RPC interoperability

Run `deno task test:native-interop` after `deno task compiler:fetch`. The script
requires the repository's pinned Zig, CMake, and a C++23 compiler (`CXX` or
`c++`). It supports Linux and macOS. No installed Cap'n Proto compiler or
library is used.

`scripts/native_interop.ts` verifies the clean capnp-zig gitlink against the
runtime pin, then builds the C++ compiler, plugin, schemas, and KJ/Cap'n Proto
libraries from that checkout's pinned `vendor/ext/capnproto` source. The native
C++ oracle has its own source revision; its shared `2.0-dev` version string
alone is not treated as a source match with capnp-wasm.

The verified capnp-wasm compiler produces one request for the Zig and Deno
generators. The script formats fresh TypeScript and checks it against `gen/`
before running the fixture. C++ bindings come from the source-matched native
compiler. Builds and generated temporary files stay in
`.capnp-cache/native-interop`; C++ libraries are cached by source revision,
platform, and compiler version. A successful run writes source pins and
request/schema hashes to `last-success.json`. The final command's diagnostic
output is saved in `last-command.log`.

| Caller                               | Server                               | Transport            |
| ------------------------------------ | ------------------------------------ | -------------------- |
| Deno generated client                | Native Zig generated server and Peer | Framed process pipes |
| Native Zig generated client and Peer | Deno generated server and WASM Peer  | Framed process pipes |
| Deno generated client                | Native C++ generated server and KJ   | Localhost TCP        |
| Native C++ generated client and KJ   | Deno generated server and WASM Peer  | Localhost TCP        |

Each row checks unary parameters/results, an exported callback, a returned
capability used after its parent call finishes, exceptions followed by
successful calls on both the returned capability and the stream-capable root,
two delayed stream items followed by a regular barrier, capability release, and
connection cleanup. C++ deliberately pipelines its first call against the
bootstrap answer. The Zig server defers stream acknowledgements until the
following calls have arrived, asserting that the barrier has not dispatched
early. The Deno and C++ servers delay handler completion to exercise the same
ordering requirement.

The native Zig fixture asserts no allocator leaks at exit and drained streaming
call/byte counters. Deno checks closed service handles and zero active
connections. Native processes have a 30-second alarm, matrix rows have 20-second
deadlines, and the runner bounds each build command and the complete matrix.
This is a focused two-party RPC matrix; it does not claim native Zig socket,
generic-schema, or multi-party RPC coverage. Existing historical 1.5.0
serialization fixtures remain independent.

To refresh checked-in TypeScript after an intentional emitter/schema change, run
`deno task test:native-interop --update-fixtures`. This uses the same verified
request and stable `interop.capnp` source prefix as normal verification, updates
only `gen/`, and then runs the complete matrix. Review those generated changes.

## Pending cancellation

Every matrix row starts `Doubler.hold(cap)` on an already-returned child
capability. `holdStatus(false)` proves the handler is active before the caller
cancels: Deno uses `AbortSignal`, native Zig uses `Peer.cancelQuestion`, and C++
drops the pending RPC promise. A subsequent successful `compute` uses the same
capability and connection.

The transport audit inspects actual frames without modifying them. It requires
one `Finish` before the hold's terminal `Return` and one `Release` for its
callback capability. The pending handler retains that callback explicitly.

Deno's low-level generated server dispatch exposes `ctx.signal`; its ordinary
convenience adapter does not pass call context. C++ enables cancellation on
`hold` using the schema's `allowCancellation` annotation. Both handlers release
their callback when cancellation reaches them.

Native Zig's deferred handler API has no cancellation callback. Its
`holdStatus(true)` verifies that `Finish` retired the pending answer, then
completes it late and releases the callback. That row verifies client
cancellation, late-return absorption, and cleanup; it does not claim that Zig
automatically stops application work.

The Deno bridge sends a terminal exception Return after a canceled handler
settles, so native callers can retire their canceled-question bookkeeping. It
discards late application results, preserves the handler's parameter-capability
ownership decision even when it throws, and emits nothing after closure.

The shared wire decoder also recognizes native `Return(canceled)` as
`kind: "canceled"`. A late canceled Return is absorbed without affecting another
pending call; an unsolicited canceled Return rejects its matching live call.
Code consuming `RpcReturnMessage` should narrow on `kind === "results"` before
reading result content; checking only `kind !== "exception"` is no longer
sufficient.
