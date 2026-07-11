set shell := ["bash", "-cu"]

default:
    @just --list

fmt:
    deno task fmt

lint:
    deno task lint

check:
    deno task check

check-generated:
    deno task check:generated

check-rpc-schema-sync:
    deno task check:rpc-schema-sync

check-tools:
    deno task check:tools

test-unit:
    deno task test:unit

test-codegen:
    deno task test:codegen

test-integration:
    deno task test:integration

test-codegen-e2e:
    deno task test:codegen-e2e

test-real:
    deno task test:real

build-wasm:
    mise x -- env CAPNPC_ZIG_ROOT=vendor/capnp-zig deno task build:wasm

smoke-real:
    deno task smoke:real

publish-dry-run:
    deno publish --dry-run --allow-dirty

bench:
    deno task bench

bench-fast:
    deno task bench:fast

bench-real:
    deno task bench:real

perf-check:
    just bench-fast
    deno test --no-check --allow-env=CI --allow-write=bench/results.json --allow-run=git bench/regression_test.ts

ci-bench:
    @echo "=========================================="
    @echo "  Performance Benchmarks"
    @echo "=========================================="
    deno task bench:fast 2>&1 || echo "WARNING: bench:fast exited with non-zero status (non-blocking)"
    @echo "=========================================="
    @echo "  Benchmark Regression Checks (blocking)"
    @echo "=========================================="
    deno test --no-check --allow-env=CI --allow-write=bench/results.json --allow-run=git bench/regression_test.ts
    @echo "=========================================="
    @echo "  Benchmarks complete"
    @echo "=========================================="

verify:
    deno task verify

verify-real:
    mise x -- env CAPNPC_ZIG_ROOT=vendor/capnp-zig deno task verify:real

ci-fast:
    just verify

ci-integration:
    just verify
    just test-integration
    just test-codegen-e2e

ci-real:
    just verify-real

ci:
    just ci-integration

release-check:
    just verify
    just test-codegen
    just test-codegen-e2e
    just test-integration
    just build-wasm
    just smoke-real
    just test-real
    just publish-dry-run

# List CI workflow jobs as seen by `act`
act-list:
    act -l

# Run local CI-equivalent jobs with `act` (single runner profile, sequential)

# Excludes benchmark regression job by default since host/container timing is not comparable to CI baseline.
act-ci event="pull_request":
    act {{ event }} -j verify
    act {{ event }} -j integration
    act {{ event }} -j real-wasm

# Run a single CI job locally with `act` (example: `just act-ci-job verify`)
act-ci-job job event="pull_request":
    act {{ event }} -j {{ job }}

# Run benchmark regression check locally under `act` (optional; often noisy on laptops/containers)
act-bench event="pull_request":
    act {{ event }} -j bench

vendor-test:
    cd vendor/capnp-zig && just test

regen-rpc-fixtures:
    zig build --build-file tools/gen_rpc_fixtures/build.zig run > tests/fixtures/rpc_frames.ts
    deno fmt tests/fixtures/rpc_frames.ts

regen-rpc-ts:
    ./scripts/generate_rpc_schema_ts.sh

codegen-schema schema out="generated":
    deno task codegen generate --schema {{ schema }} --out {{ out }}

codegen-src src out="generated" layout="schema":
    deno task codegen generate --src {{ src }} --out {{ out }} --layout {{ layout }}

codegen-request request out="generated":
    deno task codegen generate --request-bin {{ request }} --out {{ out }}

install-codegen-plugin:
    deno task codegen:install

uninstall-codegen-plugin:
    deno task codegen:uninstall

build-codegen-binary:
    deno task codegen:compile

build-codegen-binary-target target out:
    deno task codegen:compile {{ target }} {{ out }}

codegen-plugin schema out="generated" import_path=".":
    capnp compile -I {{ import_path }} -odeno:{{ out }} {{ schema }}

codegen-plugin-local schema out="generated" import_path=".":
    capnp compile -I {{ import_path }} -o ./scripts/capnpc-deno:{{ out }} {{ schema }}
