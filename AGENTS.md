# Repository Guidelines

## Project Structure & Module Organization

- `mod.ts` is the umbrella public entrypoint; focused entrypoints are `rpc.ts`
  and `encoding.ts`.
- `src/abi.ts` wraps raw WASM exports (memory, alloc/free, error state, peer
  calls).
- `src/wasm_peer.ts` and `src/rpc/session.ts` implement host runtime flow. Core
  invariant: after each inbound frame, drain all outbound frames in order.
- `src/encoding/framer.ts` plus `src/rpc/transports/*.ts` provide stream/message
  adapters (`TcpTransport`, `WebSocketTransport`, `MessagePortTransport`).
- `tests/` is split by scope: fake-WASM unit tests, socket/message-port
  integration tests, and real-WASM ABI/serde/RPC tests.
- `vendor/capnp-zig/` is a git submodule containing the canonical WASM ABI
  implementation and fixture tooling.

## Build, Test, and Development Commands

- `just ci-fast`: run the default fast gate (`fmt`, `lint`, `check`, unit
  tests).
- `just ci-integration`: run fast gate plus socket loopback integration tests.
- `just ci-real`: run real-wasm verification gate.
- `just codegen-schema tests/fixtures/schemas/person_codegen.capnp`: generate
  scaffold TS output from schema input.
- `just codegen-request path/to/request.bin`: generate scaffold TS output from a
  prebuilt binary `CodeGeneratorRequest`.
- `just build-wasm`: build `generated/capnp_deno.wasm` via
  `scripts/build_wasm.sh`.
- `CAPNPC_ZIG_ROOT=/path/to/capnp-zig deno task build:wasm`: required when
  auto-detection cannot find the Zig repo.
- `deno task verify:real`: wasm build + smoke + integration + real-WASM tests
  (same path used by `just ci-real`).
- `deno task codegen --schema tests/fixtures/schemas/person_codegen.capnp --out generated`:
  direct `capnpc-deno` scaffold entrypoint.
- If changing vendor code, also run `cd vendor/capnp-zig && just test`.
- Regenerate RPC fixtures with
  `cd vendor/capnp-zig && zig build gen-rpc-fixtures > ../../tests/fixtures/rpc_frames.ts`.

## Coding Style & Naming Conventions

- Strict TypeScript is enabled; keep code `deno fmt`/`deno lint` clean.
- Use snake_case file names and `*_test.ts` test files.
- Keep transport APIs aligned with `RpcTransport` (`start`, `send`, `close`) and
  preserve byte/frame ordering.
- Prefer explicit types on exported surfaces; avoid Node-specific types
  (`Buffer`) in runtime code.

## Testing Guidelines

- Use `tests/fake_wasm.ts` for fast host-logic tests; reserve real-WASM tests
  for ABI compatibility and schema serde behavior.
- Add/adjust integration tests when touching framing, session pumping, or
  transport event handling.
- No fixed coverage threshold is defined, but behavior changes must include
  corresponding tests.

## Commit & Pull Request Guidelines

- Root history is currently minimal; use Conventional Commits (for example
  `feat(session): drain inbound chain on close`).
- Keep TypeScript runtime changes and `vendor/capnp-zig` submodule bumps in
  separate commits.
- PRs should list commands run, permissioned test modes used (`--allow-net`,
  `--allow-read`), and any fixture or artifact updates.

<!-- BEGIN BEADS INTEGRATION -->
## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

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

- ✅ Use bd for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `bd ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and docs/QUICKSTART.md.

<!-- END BEADS INTEGRATION -->

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
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
