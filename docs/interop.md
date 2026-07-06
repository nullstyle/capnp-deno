# Interop Guide

This guide tracks the compatibility surface that capnp-deno keeps stable across
generated TypeScript, the TypeScript RPC runtime, and the vendored `capnp-zig`
WASM core.

## Current Baseline

- `capnp-zig`: `dd41e5bc4268c1b66a6c593d3e487e79c1b0ba69`
- Serialization runtime: generated TypeScript codecs in `src/encoding/`
- RPC wire/runtime: generated stubs plus `RpcWireClient`, `RpcServerRuntime`,
  `SessionRpcClientTransport`, and transport adapters
- Canonical fixture guard: `tests/interop/serialization_interop_test.ts`
- Real transport guard: `tests/transports/tcp_rpc_interop_test.ts`

## Serialization Snapshots

The serialization interop test uses the schema in
`tests/fixtures/schemas/interop_matrix.capnp`, checked-in generated codecs under
`tests/fixtures/generated/interop_matrix/`, and hex snapshots produced with the
local Cap'n Proto CLI:

```sh
printf '(<value>)' \
  | capnp encode tests/fixtures/schemas/interop_matrix.capnp InteropPerson \
  | xxd -p -c 999
```

The fixture covers:

- primitive scalars, defaults, floats, text, and data
- primitive lists and text lists
- nested structs, struct lists, and group fields
- named unions and discriminants
- multi-segment far-root decoding
- malformed/truncated fixture rejection
- interface and `AnyPointer` capability pointers
- empty RPC parameter/result structs

These snapshots are deliberately small and deterministic. If a generated codec
change alters one of the byte strings, treat that as a compatibility review
point: either the old encoder was wrong, the new encoder is wrong, or the
fixture needs a documented migration.

One default-value fixture is decode-only: the C++ `capnp encode` output elides
empty pointer sections more aggressively than capnp-deno currently does. The
test still proves that capnp-deno decodes the external canonical bytes and keeps
non-default encodings byte-stable.

## RPC Interop Matrix

The real TCP interop gate covers two layers:

- raw Cap'n Proto RPC frames against a real WASM-backed server peer;
- high-level generated `connect()`/`serve()` paths over real TCP.

The generated TCP coverage proves:

- bootstrap and unary calls still round-trip;
- local callback capabilities can be exported by the client and invoked by the
  server before the original call completes;
- generated `-> stream` helpers keep per-method delivery ordered while allowing
  client-side backpressure;
- server-side failures propagate as typed `CapnpError` values with generated
  service/method metadata.

The broader socket integration suite extends the same generated callback and
streaming flows to TCP, WebSocket, and guarded WebTransport loopback.

## Updating Interop Fixtures

Prefer adding a narrow fixture over changing broad examples. A good fixture:

- isolates one protocol or schema behavior;
- has a stable byte snapshot or explicit wire assertion;
- runs in the smallest relevant gate (`test:unit`, `test:integration`, or
  `test:real`);
- names the external compatibility point in the test title.

When a snapshot changes intentionally, update the expected hex and include the
reason in the PR summary.
