# Full-Spectrum Audit Plan (2026-02-12)

## Scope

- First-party repository code only: `src/**`, `tools/**`, `scripts/**`,
  `examples/**`, `tests/**`, root config/docs.
- Excludes deep third-party audit of `vendor/capnp-zig/**` (tracked as external
  dependency).

## Goals

- Find correctness bugs, edge-case failures, race/ordering issues, API-contract
  inconsistencies, resource leaks, and maintainability risks.
- Propose concrete improvements with priority and rationale.
- Keep traceable evidence in checklist + devlog.

## Method

1. Baseline static gates: format/lint/type-check/test surface where practical.
2. Architecture and API contract review (`src/mod.ts`, `src/rpc.ts`,
   `src/encoding.ts`, `src/advanced.ts`).
3. Error and validation review (`src/errors.ts`, `src/validation.ts`).
4. Wire/framing correctness review (`src/rpc/wire*`, `src/rpc/wire/**`).
5. Session and client flow review (`src/rpc/session/**`).
6. Server runtime and bridge review (`src/rpc/server/**`).
7. Transport and resilience review (`src/rpc/transports/**`).
8. WASM ABI + peer lifecycle review (`src/wasm/**`).
9. Encoding/runtime serde review (`src/encoding/**`).
10. Observability review (`src/observability/**`).
11. Tooling/codegen review (`tools/capnpc-deno/**`, scripts, deno tasks).
12. Test quality and coverage-gap review (`tests/**`, bench/examples sanity).

## Recontext Protocol

- Before each major phase, re-open and read:
  - `docs/audit_2026_02_12/PLAN.md`
  - `docs/audit_2026_02_12/CHECKLIST.md`
  - `docs/audit_2026_02_12/DEVLOG.md`
- Update checklist status and append dated/time-stamped devlog entries.

## Output Format

- Findings ordered by severity: P0/P1/P2/P3.
- Each finding includes file path, lines, impact, and recommendation.
