#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
exec deno run --allow-read --allow-write --allow-run=deno "$script_dir/rpc_schema.ts" --check
