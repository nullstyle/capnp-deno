# Pinned framing conformance corpus

`framing_fixtures.json` is an unchanged copy from capnp-zig commit
`c30abbbdde561931f3f179884f24d1309c5599ae`. The corpus first shipped in v0.16.0.
`provenance.json` records its source, hash, and 11-case inventory.

Run:

```sh
mise exec -- deno test --allow-read=tests/fixtures/framing tests/wire/framing_conformance_test.ts
```

The runner matches upstream limits explicitly: 512 segments, 8 Mi words, 2,056
header bytes, and 67,110,920 buffered bytes. It compares frame bytes, error
category, and rejection at push versus pop. Deno reports `ProtocolError`; its
diagnostics distinguish invalid framing from a size ceiling. This corpus checks
stream framing, not schema validity of the frame contents.

The Deno framer's ordinary default buffer ceiling is 64 MiB, or its configured
`maxFrameBytes` if that is larger. It rejects oversized undrained chunks before
copying them. An explicit `maxBufferedBytes: Infinity` retains the prior
unbounded batching behavior; per-frame limits still apply. Buffer capacity also
stays within a finite configured ceiling as it grows.

The independent TypeScript wire-copy regressions in
`tests/interop/wire_evolution_test.ts` cover standard near/single-far/double-far
encodings, present empty structs, unknown physical fields, capability indices,
strict Text, malformed list storage, and bounded copy expansion. The real WASM
comparison lives in `tests/wasm/real_wasm_wire_conformance_test.ts` and checks
the current Zig reader against the TypeScript reader. These do not claim native
transport interoperability or generic schema-model parity.

When refreshing the corpus, copy it from a reviewed upstream revision, update
its SHA-256 and inventory, then run the conformance gate. Do not regenerate the
historical Cap'n Proto 1.5 schema/default fixtures as part of this refresh.
