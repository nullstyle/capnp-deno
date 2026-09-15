#!/usr/bin/env bash
set -euo pipefail
# Compatibility entrypoint; the native Deno task also works on Windows.
script_dir="$(cd "$(dirname "$0")" && pwd)"
exec deno run --allow-read --allow-write --allow-env --allow-run=git,zig,wasm-opt "$script_dir/build_wasm.ts" "$@"
