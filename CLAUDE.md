# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Overview

capnp-deno (`@nullstyle/capnp`) is a Deno-first Cap'n Proto runtime providing
binary serialization, RPC, and schema-to-TypeScript code generation. The core
protocol logic runs in a WASM module built from Zig (`vendor/capnp-zig`
submodule); the TypeScript layer handles session management, transports,
middleware, and codegen.

## Directives

- **Use `bd` for task tracking.** Do NOT use markdown TODOs, task lists, or
  other tracking methods. See [Issue Tracking](#issue-tracking-with-bd-beads)
  below.

## Common Commands

```sh
# Fast gate: format, lint, type-check, unit tests
deno task verify

# Unit tests only (fast, no network/WASM needed)
deno task test:unit

# Single test file
deno test tests/session/session_test.ts

# Socket integration tests (needs --allow-net)
deno task test:integration

# Real WASM tests (must build WASM first)
just build-wasm          # or: CAPNPC_ZIG_ROOT=vendor/capnp-zig deno task build:wasm
deno task test:real

# Full real-WASM verification (build + smoke + integration + real tests)
deno task verify:real

# Format / lint / type-check individually
deno task fmt
deno task lint
deno task check

# Codegen from schema
deno task codegen generate --schema path/to/schema.capnp --out generated

# Codegen from directory of schemas
deno task codegen generate --src schema/ --out generated --layout schema

# Codegen via just (shorthand)
just codegen-schema tests/fixtures/schemas/person_codegen.capnp
just codegen-request path/to/request.bin

# Benchmarks
deno task bench:fast     # skip real-WASM benches
deno task bench:real     # real-WASM benches only
```

CI gates: `just ci-fast` (PR minimum), `just ci-integration`, `just ci-real`.

If changing vendor code, also run `cd vendor/capnp-zig && just test`. Regenerate
RPC fixtures with
`cd vendor/capnp-zig && zig build gen-rpc-fixtures > ../../tests/fixtures/rpc_frames.ts`.

## Architecture

### Module Entrypoints

- `src/mod.ts` — public API; all user-facing exports go here
- `src/advanced.ts` — re-exports `mod.ts` plus low-level WASM APIs (`WasmAbi`,
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

| Path                                    | Role                                                   |
| --------------------------------------- | ------------------------------------------------------ |
| `src/wasm/abi.ts`                       | WASM ABI wrapper (memory, alloc/free, peer calls)      |
| `src/wasm/peer.ts`                      | Host-side peer lifecycle                               |
| `src/wasm/load.ts`                      | WASM module loading                                    |
| `src/observability/observability.ts`    | Observability helpers (spans, metrics)                 |
| `src/rpc/session/session.ts`            | RPC session management                                 |
| `src/rpc/session/client.ts`             | Client transport + pipeline                            |
| `src/rpc/session/streaming.ts`          | Streaming RPC support                                  |
| `src/rpc/server/bridge.ts`              | Server bridge + dispatch                               |
| `src/rpc/server/runtime.ts`             | Combines session + bridge into a runtime               |
| `src/rpc/server/outbound.ts`            | Server outbound message handling                       |
| `src/rpc/server/service.ts`             | Service registry + dispatch                            |
| `src/rpc/wire.ts`                       | Canonical RPC wire encode/decode/router barrel         |
| `src/rpc/transports/middleware.ts`      | Frame-level middleware (logging, metrics, size limits) |
| `src/rpc/transports/`                   | TCP, WebSocket, MessagePort adapters                   |
| `src/rpc/transports/reconnect.ts`       | Reconnection + resilience                              |
| `src/rpc/transports/connection_pool.ts` | Multi-connection pool                                  |
| `src/rpc/wire/framer.ts`                | Cap'n Proto segment framing                            |
| `tools/capnpc-deno/`                    | Schema→TypeScript code generator                       |

### Code Generation Pipeline

```
.capnp schema
    → capnp compile -o- (binary CodeGeneratorRequest)
    → capnpc-deno plugin
    → 2 files per schema: *_types.ts (types+codecs+stubs), *_meta.ts (reflection)
```

### Test Organization

- `tests/fake_wasm.ts` — mock WASM for fast unit tests (no build step needed)
- `tests/test_utils.ts` — shared test helpers
- `tests/codegen/` — codegen test suite (`capnpc_deno_*_test.ts`)
- `tests/encoding/` — serialization tests
- `tests/server/` — server bridge, runtime, service, outbound tests
- `tests/session/` — client, session, streaming, lifecycle tests
- `tests/transports/` — TCP, WebSocket, MessagePort, reconnect, pool tests
- `tests/wire/` — framer, frame limits, wire encode/decode tests
- `tests/wasm/` — ABI, peer, and real WASM runtime tests (require `build-wasm`)
- `tests/transports/socket_integration_test.ts` — TCP/WS loopback tests

## Code Style

- TypeScript strict mode. Format with `deno fmt`, lint with `deno lint`.
- snake_case file names. Test files: `{module}_test.ts`.
- Prefer named `function` declarations over arrows. Use `#private` fields.
- Use `import type` for type-only imports (Deno's `verbatim-module-syntax`
  rule).
- Keep transport APIs aligned with `RpcTransport` (`start`, `send`, `close`) and
  preserve byte/frame ordering.
- Prefer explicit types on exported surfaces; avoid Node-specific types
  (`Buffer`) in runtime code.
- Use the custom error hierarchy (`AbiError`, `TransportError`, `ProtocolError`,
  `SessionError`, `InstantiationError`); never throw bare `Error` from library
  code.
- All public APIs need JSDoc with `@param`, `@returns`, and `@example`.
- Conventional Commits (`feat(session): ...`, `fix(transport): ...`).
- Never create `bd:backup` commits. Use intentional, scoped Conventional Commit
  messages for real code/docs/test changes only.
- Keep runtime changes and `vendor/capnp-zig` submodule bumps in separate
  commits.
- PRs should list commands run, permissioned test modes used (`--allow-net`,
  `--allow-read`), and any fixture or artifact updates.

## Testing Guidelines

- Use `tests/fake_wasm.ts` for fast host-logic tests; reserve real-WASM tests
  for ABI compatibility and schema serde behavior.
- Add/adjust integration tests when touching framing, session pumping, or
  transport event handling.
- No fixed coverage threshold is defined, but behavior changes must include
  corresponding tests.

## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT
use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Git-friendly: Dolt-powered version control with native sync
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**

```bash
bd ready --json
```

**Create new issues:**

```bash
bd create "Issue title" --description="Detailed context" -t bug|feature|task -p 0-4 --json
bd create "Issue title" --description="What this issue is about" -p 1 --deps discovered-from:bd-123 --json
```

**Claim and update:**

```bash
bd update <id> --claim --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Completed" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task atomically**: `bd update <id> --claim`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" --description="Details about what was found" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`

### Auto-Sync

bd automatically syncs via Dolt:

- Each write auto-commits to Dolt history
- Use `bd dolt push`/`bd dolt pull` for remote sync
- No manual export/import needed!

### Important Rules

- Use bd for ALL task tracking
- Always use `--json` flag for programmatic use
- Link discovered work with `discovered-from` dependencies
- Check `bd ready` before asking "what should I work on?"
- Do NOT create markdown TODO lists
- Do NOT use external issue trackers
- Do NOT duplicate tracking systems

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT
complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs
   follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**

- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

## Prerequisites

- Deno 2.6+, Just (task runner). Zig 0.15+ only for WASM builds. Versions pinned
  in `mise.toml`.
