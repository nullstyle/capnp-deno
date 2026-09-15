# Release Checklist

Use this checklist before cutting a tag or handing off a release candidate.

## Local Gates

First acquire the pinned compiler with `mise exec -- deno task compiler:fetch`.
The current compiler/runtime contracts and isolated-consumer commands are in
[Toolchains and artifact delivery](toolchains.md). The
[shared validation workflow](../.github/workflows/validation.yml) defines the
required release gates, including native executable/package checks on all five
targets and the clean runtime/native-interop/browser lanes.

Run the local convenience subset:

```sh
just release-check
```

This expands to:

```sh
just verify
just test-codegen
just test-integration
just build-wasm
just smoke-real
just test-real
just publish-dry-run
```

Notes:

- `just build-wasm` runs through `mise` and uses the pinned clean
  `vendor/capnp-zig` source, Zig, and Binaryen toolchain. Run
  `deno task check:wasm-rebuild` to compare an isolated rebuild with the
  checked-in artifact and receipt.
- `just test-integration` and `just test-real` bind loopback `127.0.0.1`;
  restricted sandboxes may need explicit network permission.
- `just build-wasm` may need access to Zig and mise cache directories outside
  the repository.
- `just publish-dry-run` uses `--allow-dirty` so it can validate the local
  release candidate before the final commit. Run `deno publish --dry-run`
  without `--allow-dirty` before publishing from a clean tree.

## Generated Artifacts

Before release, confirm generated files are current:

```sh
deno task check:rpc-schema-sync
deno task test:codegen
```

Regenerate only the artifacts affected by the change:

```sh
just regen-rpc-ts
deno task codegen generate --schema examples/ping/schema.capnp --out examples/ping/gen --layout flat
deno task codegen generate --schema examples/streaming/schema.capnp --out examples/streaming/gen --layout flat
```

Rebuild the WASM artifact after changing `vendor/capnp-zig`, WASM ABI glue, or
the build script:

```sh
just build-wasm
```

Validate the JSR package file set and public exports:

```sh
just publish-dry-run
```

## Version And Tag

1. Update `deno.json` `version`.
2. Update `docs/CHANGELOG.md`.
3. Confirm `vendor/capnp-zig` is at the intended commit:

   ```sh
   git submodule status vendor/capnp-zig
   ```

4. Push a tag matching `v*` to trigger `.github/workflows/release.yml`.

The release workflow validates the exact tagged commit and waits for the shared
required gates before attaching natively built and executed `capnpc-deno`
binaries plus provenance for Linux, macOS, and Windows. Local checks do not
establish unexecuted hosted-platform acceptance. JSR publishing is not currently
automated by this repository.
