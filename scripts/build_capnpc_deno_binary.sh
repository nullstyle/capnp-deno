#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
exec deno run --allow-read --allow-write --allow-run=deno "$script_dir/build_capnpc_deno_binary.ts" "$@"
