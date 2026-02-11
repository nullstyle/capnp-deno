#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -gt 2 ]; then
  echo "usage: $0 [target] [output]" >&2
  echo "example: $0 x86_64-unknown-linux-gnu dist/capnpc-deno-x86_64-unknown-linux-gnu" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
OUTPUT="${2:-$ROOT_DIR/dist/capnpc-deno}"

mkdir -p "$(dirname "$OUTPUT")"

CMD=(
  deno
  compile
  --allow-read
  --allow-write
  --allow-run=capnp
  --output
  "$OUTPUT"
)

if [ -n "$TARGET" ]; then
  CMD+=(--target "$TARGET")
fi

CMD+=("$ROOT_DIR/tools/capnpc-deno/main.ts")
"${CMD[@]}"

