#!/usr/bin/env bash
set -euo pipefail

repo_root="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  pwd
)"

cd "$repo_root"

before_snapshot="$(mktemp)"
after_snapshot="$(mktemp)"
trap 'rm -f "$before_snapshot" "$after_snapshot"' EXIT

capture_state() {
  local out_file="$1"
  {
    git --no-pager status --short -- src/rpc/gen/capnp
    git --no-pager diff -- src/rpc/gen/capnp
    git --no-pager diff --cached -- src/rpc/gen/capnp
  } > "$out_file"
}

capture_state "$before_snapshot"
./scripts/generate_rpc_schema_ts.sh
capture_state "$after_snapshot"

if ! cmp -s "$before_snapshot" "$after_snapshot"; then
  echo "ERROR: RPC generated TypeScript files are out of sync."
  echo "Run ./scripts/generate_rpc_schema_ts.sh and commit the updated artifacts."
  echo
  git --no-pager status --short -- src/rpc/gen/capnp
  echo
  git --no-pager diff -- src/rpc/gen/capnp || true
  exit 1
fi

echo "RPC generated TypeScript files are in sync."
