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

test-real:
    deno task test:real

build-wasm:
    CAPNPC_ZIG_ROOT=vendor/capnp-zig deno task build:wasm

smoke-real:
    deno task smoke:real

bench:
    deno task bench

bench-fast:
    deno task bench:fast

bench-real:
    deno task bench:real

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

verify-integration:
    deno task verify:integration

verify-real:
    CAPNPC_ZIG_ROOT=vendor/capnp-zig deno task verify:real

ci-fast:
    just verify

ci-integration:
    just verify
    just verify-integration

ci-real:
    just verify-real

ci:
    just ci-integration

vendor-test:
    cd vendor/capnp-zig && just test

regen-rpc-fixtures:
    cd vendor/capnp-zig && zig build gen-rpc-fixtures > ../../tests/fixtures/rpc_frames.ts

regen-rpc-ts:
    ./scripts/generate_rpc_schema_ts.sh

codegen-schema schema out="generated":
    deno task codegen generate --schema {{schema}} --out {{out}}

codegen-src src out="generated" layout="schema":
    deno task codegen generate --src {{src}} --out {{out}} --layout {{layout}}

codegen-request request out="generated":
    deno task codegen generate --request-bin {{request}} --out {{out}}

install-codegen-plugin:
    deno task codegen:install

uninstall-codegen-plugin:
    deno task codegen:uninstall

build-codegen-binary:
    deno task codegen:compile

build-codegen-binary-target target out:
    deno task codegen:compile {{target}} {{out}}

codegen-plugin schema out="generated" import_path=".":
    capnp compile -I {{import_path}} -odeno:{{out}} {{schema}}

codegen-plugin-local schema out="generated" import_path=".":
    capnp compile -I {{import_path}} -o ./scripts/capnpc-deno:{{out}} {{schema}}
