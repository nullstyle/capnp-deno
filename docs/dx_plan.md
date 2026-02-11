# DX Plan And Progress

Updated: 2026-02-10

This document tracks the developer-experience plan for schema-first RPC usage,
especially the server bootstrap/registration path and generated-stub ergonomics.

## Problem Summary

Current user pain points:

- "Golden path" examples contain too much transport/wire ceremony.
- Server setup leaks capability lifecycle details (`capabilityIndex`,
  `referenceCount`) into app code even when callers just want a root service.
- Generated RPC modules re-emit shared transport/context types per schema, which
  limits cross-schema composability and makes typing feel fragmented.
- Helpful generics exist in runtime internals, but app-facing helpers are still
  not generic enough for common workflows.

## DX Goals

- Make the default server path look like: register implementation, run runtime.
- Keep capability lifecycle controls available, but move them to advanced paths.
- Ensure examples are concise, representative, and schema-backed.
- Improve type composability across generated modules.
- Preserve protocol correctness and low-level escape hatches.

## Principles

- Default simple path, explicit advanced path.
- No loss of protocol safety for convenience.
- Backward-compatible additive API changes first.
- Typed generated stubs should compose cleanly with runtime helpers.

## Plan

### Phase 1: Root Server Convenience API

Status: Done

- Add `RpcServerRuntime.createWithRoot<TServer>(...)`.
- Accept generated `register*Server`-style registrar + typed server impl.
- Internally:
  - create bridge
  - set `onBootstrap` to root capability index
  - register root capability
  - enforce registrar root-index correctness
  - delegate to `RpcServerRuntime.create(...)`

Why this matters:

- Removes manual bootstrap + root registration from default server setup.
- Keeps `capabilityIndex`/`referenceCount` available via optional settings and
  advanced bridge APIs.

### Phase 2: Primary Example Simplification

Status: Done

- Refactor primary examples to use `createWithRoot(...)` instead of manual root
  capability registration.
- Keep generated stubs front-and-center in examples.

### Phase 3: Built-In TCP Client Adapter

Status: Done

- Add a first-class client transport adapter for TCP so examples do not carry
  custom frame collector/client glue.
- Delivered API: `TcpRpcClientTransport`, compatible with generated client
  stubs.

### Phase 4: Shared RPC Type Surface For Generated Code

Status: Done

- Move generated `RpcCallOptions`, `RpcClientTransport`, `RpcServerRegistry`,
  and related shared contracts to one runtime module.
- Update codegen to import these shared types instead of re-emitting per file.

Expected outcome:

- Better cross-schema interoperability.
- Cleaner barrels and less duplicated type noise.

### Phase 5: Generic High-Level Client Helpers

Status: Done

- Add app-facing generic helpers for bootstrap/connect flows.
- Example direction: `connectAndBootstrap<TClient>(...)` helper that returns a
  typed generated client.

## Current Progress

### Implemented In This Branch

- Added server convenience API in runtime:
  - `RpcServerRuntime.createWithRoot<TServer>(...)`
  - `RpcServerRuntimeRootRegistrar<TServer>`
  - `RpcServerRuntimeRootRegistrationOptions`
  - `RpcServerRuntimeCreateWithRootOptions`
- Exported new types from public API.
- Added runtime tests for:
  - default root bootstrap wiring
  - custom root index and refcount
  - registrar mismatch validation
- Updated public API type tests to include new exported types.
- Refactored primary examples to use `createWithRoot(...)`.
- Added built-in `TcpRpcClientTransport` with `connect(...)` factory.
- Added adapter unit tests for bootstrap, calls, validation, and pending-close
  behavior.
- Migrated `examples/tcp_golden_path/tcp_golden_path.ts` from custom ad hoc TCP
  client glue to `TcpRpcClientTransport`.
- Added shared generated-RPC contracts in `codegen_runtime`:
  - `RpcCallOptions`, `RpcClientTransport`, `RpcServerRegistry`, and related
    shared types.
- Updated RPC codegen to re-export shared RPC contracts instead of duplicating
  per-file interface declarations.
- Added generic helper: `connectAndBootstrap<TClient, TTransport>(...)`.
- Migrated `tcp_golden_path` client flow to `connectAndBootstrap(...)`.
- Added cross-schema integration coverage for helper ergonomics in
  `tests/connect_and_bootstrap_cross_schema_test.ts`.

### Validation Completed

- Type-check passed for runtime/codegen/tests/examples touched by this work.
- Lint passed for touched runtime/codegen/tests/examples.
- Focused tests passed for:
  - `tests/codegen_runtime_rpc_helpers_test.ts`
  - `tests/connect_and_bootstrap_cross_schema_test.ts`
  - `tests/capnpc_deno_interface_codegen_test.ts`
  - `tests/capnpc_deno_codegen_test.ts`
  - `tests/public_api_surface_test.ts`
  - `tests/public_api_types_test.ts`
  - `tests/tcp_rpc_client_transport_test.ts`
- Runtime smoke checks passed for:
  - `examples/getting-started/getting-started.ts`
  - `examples/tcp_golden_path/tcp_golden_path.ts`

## What This Solves Right Now

- Default server setup no longer requires users to manually wire bootstrap root
  capability registration in primary examples.
- `capabilityIndex` and `referenceCount` are no longer front-and-center in the
  main example server flows.
- API surface now has a clear "simple path" without removing advanced control.

## Remaining Gaps

- Continue collecting feedback on helper naming/options before locking a stable
  long-term DX API.

## Next Steps (Execution Order)

1. Continue collecting usage feedback on naming/options for
   `connectAndBootstrap(...)`.
2. Consider introducing a reconnect-aware variant if user demand emerges.

## Acceptance Criteria

- Primary examples have no manual root-capability bookkeeping.
- Primary examples avoid custom ad hoc transport adapter code.
- Generated modules no longer redefine common RPC contracts per schema.
- New generic helper path produces fully typed clients with minimal setup.
