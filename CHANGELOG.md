# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Schema-first getting started guides:
  - `docs/getting_started_serde.md`
  - `docs/getting_started_rpc.md`
- Local ABI pointer document:
  - `docs/wasm_host_abi.md` -> `vendor/capnp-zig/docs/wasm_host_abi.md`
- Docs index:
  - `docs/README.md`

### Changed

- Runtime module loading now uses Deno static WASM imports for app-facing
  factories.
- RPC codegen now emits additional typed helpers:
  - `bootstrap<Interface>Client(...)`
  - `register<Interface>Server(...)`
- RPC codegen now fails fast when interface methods reference unknown
  param/result structs (instead of generating late-bound `unknown` fallbacks).
- Documentation cleanup:
  - archived historical planning/progress docs under `docs/archive/2026-02/`
  - refreshed `docs/capnp_zig_additions.md` to current submodule revision.

### Fixed

- Removed stale top-level doc references to missing ABI docs by adding a stable
  local pointer file.
