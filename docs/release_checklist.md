# Release Checklist

Use this checklist before cutting a tag or handing off a release candidate.

## Local Gates

Run the full release check:

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

- `just build-wasm` runs through `mise`, sets
  `CAPNPC_ZIG_ROOT=vendor/capnp-zig`, and makes the pinned Binaryen `wasm-opt`
  available when installed.
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

The release workflow builds and attaches `capnpc-deno` binaries for Linux,
macOS, and Windows targets. JSR publishing is not currently automated by this
repository.
