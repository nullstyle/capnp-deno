# Repository Guidelines

## Project Structure & Module Organization

- `mod.ts` is the only public entrypoint; export user-facing APIs from here.
- `src/abi.ts` wraps raw WASM exports (memory, alloc/free, error state, peer
  calls).
- `src/wasm_peer.ts` and `src/session.ts` implement host runtime flow. Core
  invariant: after each inbound frame, drain all outbound frames in order.
- `src/framer.ts` plus `src/transports/*.ts` provide stream/message adapters
  (`TcpTransport`, `WebSocketTransport`, `MessagePortTransport`).
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
