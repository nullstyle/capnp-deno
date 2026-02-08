#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
capnp_deno_root="$(cd "$script_dir/.." && pwd)"
artifacts_dir="${CAPNP_DENO_ARTIFACTS_DIR:-$capnp_deno_root/generated}"

if [[ -n "${CAPNPC_ZIG_ROOT:-}" ]]; then
  capnpc_zig_root="$CAPNPC_ZIG_ROOT"
else
  monorepo_root="$(cd "$script_dir/../../.." && pwd)"
  if [[ -f "$monorepo_root/build.zig" && -f "$monorepo_root/src/wasm/capnp_deno.zig" ]]; then
    capnpc_zig_root="$monorepo_root"
  else
    echo "Unable to locate capnpc-zig root. Set CAPNPC_ZIG_ROOT=/path/to/capnpc-zig." >&2
    exit 1
  fi
fi

capnpc_zig_root="$(cd "$capnpc_zig_root" && pwd)"

cd "$capnpc_zig_root"
zig build wasm-deno

wasm_src_legacy="$capnpc_zig_root/zig-out/bin/capnp_deno.wasm"
wasm_src_host="$capnpc_zig_root/zig-out/bin/capnp_wasm_host.wasm"

if [[ -f "$wasm_src_legacy" ]]; then
  wasm_src="$wasm_src_legacy"
elif [[ -f "$wasm_src_host" ]]; then
  wasm_src="$wasm_src_host"
else
  echo "Expected wasm artifact not found at either:" >&2
  echo "  $wasm_src_legacy" >&2
  echo "  $wasm_src_host" >&2
  exit 1
fi

mkdir -p "$artifacts_dir"
cp "$wasm_src" "$artifacts_dir/capnp_deno.wasm"
echo "Wrote $artifacts_dir/capnp_deno.wasm"
