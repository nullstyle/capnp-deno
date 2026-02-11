# RPC + Encoding Reorganization Plan

## Goals

- Create a clear two-domain layout under `src/rpc` and `src/encoding`.
- Make `src/rpc/wire.ts` the canonical wire module location.
- Move serde to `src/encoding/serde.ts`.
- Remove legacy root-level RPC/encoding implementation files.
- Keep build/test green after path updates.

## Work Plan

1. Create target directory structure and move files.
2. Update all imports in runtime/source code.
3. Update public entrypoints (`mod.ts`, `rpc.ts`, `encoding.ts`, `advanced.ts`).
4. Split generated runtime contracts into RPC + encoding modules
   (`src/rpc/runtime.ts`, `src/encoding/runtime.ts`), then remove temporary
   `codegen_runtime` compatibility once downstream imports are migrated.
5. Update tooling/tests/docs/task globs to new paths.
6. Run fmt/check/tests and fix regressions.

## Progress Tracker

- [x] Created live plan file.
- [x] Step 1 complete: moved files to `src/rpc/**` and `src/encoding/**`.
- [x] Step 2 complete: imports updated across `src/**`, `tests/**`, `tools/**`,
      `examples/**`, `bench/**`.
- [x] Step 3 complete: entrypoints updated.
- [x] Step 4 complete: generated runtime split finished and `codegen_runtime`
      compatibility removed after migration.
- [x] Step 5 complete: docs/tasks/globs updated and legacy references removed.
- [x] Step 6 complete: validation commands green.

## Execution Log

- 2026-02-11: Initialized plan and progress tracker.
- 2026-02-11: Step 1 complete. Moved RPC runtime/protocol/transports into
  `src/rpc/**`, moved wire modules to `src/rpc/wire/**`, and moved serde to
  `src/encoding/serde.ts`.
- 2026-02-11: Updated `tests/entrypoint_segmentation_test.ts` to assert the new
  boundary: `encoding.ts` exposes serde/schema runtime helpers while `rpc.ts`
  excludes encoding serde exports.
- 2026-02-11: Validation rerun:
  - `deno test tests/entrypoint_segmentation_test.ts` passed.
  - `deno test tests/public_api_surface_test.ts tests/public_api_types_test.ts`
    passed.
- 2026-02-11: Repaired `tests/connect_and_bootstrap_cross_schema_test.ts` to use
  two existing generated schemas (`examples/ping/gen/schema_types.ts` and
  `tests/fixtures/generated/typegate_fixture_rpc.ts`) instead of removed
  `examples/getting-started` outputs.
- 2026-02-11: Final validation:
  - `deno check tests/connect_and_bootstrap_cross_schema_test.ts` passed.
  - `deno task check` passed.
  - `deno test tests/connect_and_bootstrap_cross_schema_test.ts tests/entrypoint_segmentation_test.ts tests/public_api_surface_test.ts tests/public_api_types_test.ts`
    passed.
  - `just ci-fast` passed (`fmt`, `lint`, `check`, `check:generated`,
    `test:unit`).
- 2026-02-11: Targeted cleanup round 2 (generated DX simplification):
  - Stopped emitting shim-only `*_capnp.ts` / `*_rpc.ts` files. Codegen now
    emits `*_types.ts` + `*_meta.ts` per schema.
  - Updated generated `*_types.ts` runtime imports from
    `@nullstyle/capnp/codegen_runtime` to split `@nullstyle/capnp/encoding` +
    `@nullstyle/capnp/rpc`.
  - Removed `src/codegen_runtime.ts` and package export `./codegen_runtime`.
  - Updated codegen tests, golden snapshots, and allow-read test task settings.
  - Removed shim files from `examples/ping/gen/` (`schema_capnp.ts`,
    `schema_rpc.ts`) and updated `examples/ping/gen/mod.ts`.
- 2026-02-11: Targeted cleanup round 2 validation:
  - `deno task test:codegen` passed.
  - `deno task check` passed.
  - `just ci-fast` passed.
