# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Overview

capnp-deno (`@nullstyle/capnp`) is a Deno-first Cap'n Proto runtime providing
binary serialization, RPC, and schema-to-TypeScript code generation. The core
protocol logic runs in a WASM module built from Zig (`vendor/capnp-zig`
submodule); the TypeScript layer handles session management, transports,
middleware, and codegen.

## Common Commands

```sh
# Fast gate: format, lint, type-check, unit tests
deno task verify

# Unit tests only (fast, no network/WASM needed)
deno task test:unit

# Single test file
deno test tests/session_test.ts

# Socket integration tests (needs --allow-net)
deno task test:integration

# Real WASM tests (must build WASM first)
just build-wasm          # or: CAPNPC_ZIG_ROOT=vendor/capnp-zig deno task build:wasm
deno task test:real

# Format / lint / type-check individually
deno task fmt
deno task lint
deno task check

# Codegen from schema
deno task codegen generate --schema path/to/schema.capnp --out generated

# Codegen from directory of schemas
deno task codegen generate --src schema/ --out generated --layout schema

# Benchmarks
deno task bench:fast     # skip real-WASM benches
deno task bench:real     # real-WASM benches only
```

CI gates: `just ci-fast` (PR minimum), `just ci-integration`, `just ci-real`.

## Architecture

### Module Entrypoints

- `mod.ts` — public API; all user-facing exports go here
- `advanced.ts` — re-exports `mod.ts` plus low-level WASM APIs (`WasmAbi`,
  `WasmPeer`, `instantiatePeer`, `WasmSerde`)

### Layered RPC Stack

```
Schema (.capnp)  →  capnpc-deno codegen  →  *_types.ts, *_meta.ts

Client side:                          Server side:
  SessionRpcClientTransport             RpcServerBridge
       ↓                                    ↓
  RpcSession ←→ WasmPeer(ABI)          RpcServerRuntime
       ↓                                    ↓
  Transport (TCP/WS/MessagePort)        Transport (same)
```

**Core invariant**: after each inbound frame, drain all outbound frames in order
before processing the next.

### Key Source Files

| Path                                                     | Role                                                   |
| -------------------------------------------------------- | ------------------------------------------------------ |
| `src/abi.ts`                                             | WASM ABI wrapper (memory, alloc/free, peer calls)      |
| `src/wasm_peer.ts`                                       | Host-side peer lifecycle                               |
| `src/rpc/session.ts`                                     | RPC session management                                 |
| `src/rpc/client.ts`                                      | Client transport + pipeline                            |
| `src/rpc/server.ts`                                      | Server bridge + dispatch                               |
| `src/rpc/server_runtime.ts`                              | Combines session + bridge into a runtime               |
| `src/rpc/wire.ts`                                        | Canonical RPC wire encode/decode/router barrel         |
| `src/rpc/middleware.ts`                                  | Frame-level middleware (logging, metrics, size limits) |
| `src/rpc/transports/`                                    | TCP, WebSocket, MessagePort adapters                   |
| `src/rpc/reconnect.ts`, `src/rpc/reconnecting_client.ts` | Reconnection + resilience                              |
| `src/rpc/connection_pool.ts`                             | Multi-connection pool                                  |
| `src/rpc/framer.ts`                                      | Cap'n Proto segment framing                            |
| `tools/capnpc-deno/`                                     | Schema→TypeScript code generator                       |

### Code Generation Pipeline

```
.capnp schema
    → capnp compile -o- (binary CodeGeneratorRequest)
    → capnpc-deno plugin
    → 2 files per schema: *_types.ts (types+codecs+stubs), *_meta.ts (reflection)
```

### Test Organization

- `tests/fake_wasm.ts` — mock WASM for fast unit tests (no build step needed)
- `tests/*_test.ts` — unit tests (run with `deno task test:unit`)
- `tests/socket_integration_test.ts` — TCP/WS loopback tests
- `tests/real_wasm_*_test.ts` — actual WASM runtime tests (require `build-wasm`)
- `tests/test_utils.ts` — shared test helpers

## Code Style

- TypeScript strict mode. Format with `deno fmt`, lint with `deno lint`.
- snake_case file names. Test files: `{module}_test.ts`.
- Prefer named `function` declarations over arrows. Use `#private` fields.
- Use `import type` for type-only imports (Deno's `verbatim-module-syntax`
  rule).
- Use the custom error hierarchy (`AbiError`, `TransportError`, `ProtocolError`,
  `SessionError`, `InstantiationError`); never throw bare `Error` from library
  code.
- All public APIs need JSDoc with `@param`, `@returns`, and `@example`.
- Conventional Commits (`feat(session): ...`, `fix(transport): ...`).
- Keep runtime changes and `vendor/capnp-zig` submodule bumps in separate
  commits.

## Prerequisites

- Deno 2.6+, Just (task runner). Zig 0.15+ only for WASM builds. Versions pinned
  in `mise.toml`.
