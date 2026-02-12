# Contributing

## Prerequisites

- [Deno](https://deno.land/) 2.6+
- [Just](https://github.com/casey/just) (task runner)
- [Zig](https://ziglang.org/) 0.15+ (only for WASM builds)

Tool versions are pinned in `mise.toml`.

## Development workflow

```sh
# Format, lint, type-check, and run unit tests
deno task verify

# Run only unit tests
deno task test:unit

# Run integration tests (requires network)
deno task test:integration

# Run real WASM tests (requires WASM build)
deno task build:wasm
deno task test:real

# Run benchmarks
deno task bench
```

## Code style

- Format with `deno fmt` (enforced in CI).
- Lint with `deno lint` (enforced in CI).
- TypeScript strict mode is enabled.
- Use `const` by default; `let` only when reassignment is needed.
- Prefer named `function` declarations over arrow functions.
- Use `#private` fields for class encapsulation.
- All public APIs must have JSDoc with `@param`, `@returns`, and `@example`
  tags.

## Error handling

- Use the custom error hierarchy (`AbiError`, `TransportError`, `ProtocolError`,
  `SessionError`, `InstantiationError`).
- Never throw bare `Error` from library code (validation functions are the sole
  exception).
- Normalize caught errors with `normalizeCapnpError()` and friends.
- Never swallow errors silently without a comment explaining why.

## Testing

- Place tests in `tests/` with the naming convention `{module}_test.ts`.
- Use the helpers in `tests/test_utils.ts` (`assertEquals`, `assertThrows`,
  `assertBytes`, `deferred`, `withTimeout`).
- Clean up resources in `try/finally` blocks.
- Use deterministic clocks for timing-sensitive tests.
- All tests must pass before merging: `deno task verify`.

## Commits

- Write concise commit messages that explain _why_, not _what_.
- Keep commits focused on a single logical change.
