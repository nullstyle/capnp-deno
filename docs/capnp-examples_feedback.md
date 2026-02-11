# capnp-deno: Troubles Encountered and Improvement Requests

## Context

- Date: 2026-02-10
- Project: `capnp-examples/basic`
- Goal: build a minimal generated-schema client/server example on TCP with Deno.
- Schema uses both plain methods and capability parameters
  (`startSession(client :Client)`).

## High-Impact Issues

### 1) Generated files do not type-check under current runtime typings

- Symptom: `deno check` reports a large number of errors (100+), mostly around
  `T extends Record<string, unknown>` constraints in runtime APIs versus
  generated interfaces without index signatures.
- Where it showed up:
  - `gen/schema_capnp.ts`
  - `gen/schema_rpc.ts`
- Impact:
  - Generated output appears "broken" in strict type-check workflows.
  - It becomes hard to separate user-code errors from codegen/runtime type
    incompatibilities.
- Requested improvement:
  - Make generated output pass `deno check` out of the box.
  - Align runtime generic constraints with generated types (for example, accept
    `object`/struct interfaces rather than requiring index signatures).
  - Add a CI gate in `capnp-deno` that runs strict type-check on freshly
    generated fixtures.

### 2) Server bootstrap flow is not obvious and not encapsulated

- Symptom:
  - `RpcServerBridge.handleFrame()` handles call/finish/release but not
    bootstrap.
  - Implementers must detect bootstrap frames manually and craft return frames
    manually.
- Impact:
  - Easy to implement incorrectly.
  - Adds low-level wire coupling in what should be a high-level server setup.
- Requested improvement:
  - Provide first-class bootstrap handling in server-side APIs (bridge/runtime).
  - Offer a helper like `createBootstrapResultsFrame(capabilityIndex)` or
    equivalent.
  - Document the expected bootstrap lifecycle explicitly in server setup docs.

### 3) Transport/runtime composition is difficult to reason about

- Symptom:
  - Trying to use
    `TcpTransport + NetworkRpcHarnessTransport + SessionRpcClientTransport` and
    `RpcServerRuntime` led to confusing behavior while wiring an end-to-end
    example.
  - During debugging, server logs showed unexpected frame tags (for example
    `RETURN` arriving where request-like behavior was expected).
- Impact:
  - Hard to tell whether behavior is misuse, missing bootstrap setup, or runtime
    bug.
  - High time cost to build a “known good” minimal path.
- Requested improvement:
  - Add one canonical, minimal TCP client/server example using generated stubs
    as the primary docs path.
  - Add architecture diagrams for these layers:
    - `TcpTransport`
    - `NetworkRpcHarnessTransport`
    - `SessionRpcClientTransport`
    - `RpcServerBridge`
    - `RpcServerRuntime`
  - Include a "which stack should I use?" decision guide.

### 4) Capability-passing/bidirectional RPC path needs better guidance and diagnostics

- Symptom:
  - With `startSession(client :Client)` and server callback attempts, runtime
    errors like `InvalidInlineCompositePointer` and `UnknownQuestion` were
    encountered while iterating on setup.
- Impact:
  - This is a core Cap'n Proto feature; if docs/examples for it are unclear,
    adoption is blocked.
- Requested improvement:
  - Publish a dedicated bidirectional/capability-passing example with generated
    code.
  - Improve error messages by attaching structured metadata (question id,
    interface id, method id, tag, phase).
  - Provide troubleshooting docs mapping common ABI/protocol errors to likely
    misconfigurations.

## API/Packaging Gaps

### 5) Useful wire constants/helpers are not consistently exposed at top-level

- Symptom:
  - Some constants needed for low-level bootstrap handling were not available
    from `@nullstyle/capnp` top-level imports in this environment.
- Impact:
  - Forces magic numbers or deeper internal coupling.
- Requested improvement:
  - Export all stable wire constants/helpers required for external protocol
    handling from the top-level public API.
  - Mark them as stable/public in docs.

## Operational/Ergonomic Notes

### 6) Environment variable usage needs explicit permission/documentation reminders

- Symptom:
  - Example scripts that read env vars require `--allow-env` in addition to
    `--allow-net`.
- Impact:
  - Easy to miss; runtime failures look unrelated to RPC setup.
- Requested improvement:
  - Ensure official examples and quickstart commands include exact permissions.

## What Would Unblock Fast Adoption

- A single “golden path” TCP example with generated stubs that covers:
  - bootstrap
  - plain method call
  - capability parameter passing
  - server callback to client capability
- A guarantee (and CI proof) that generated files type-check cleanly.
- Higher-level bootstrap handling API to avoid manual wire-level frame
  construction.
- A short troubleshooting matrix for common ABI/protocol errors.

## Suggested Priority

- P0:
  - Fix generated type-check compatibility.
  - Ship canonical end-to-end TCP generated-code example.
- P1:
  - Add bootstrap helper/server API support.
  - Improve diagnostics for protocol/ABI failures.
- P2:
  - Expand docs with architecture diagrams and transport-selection guidance.
