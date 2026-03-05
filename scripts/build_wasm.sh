#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
capnp_deno_root="$(cd "$script_dir/.." && pwd)"
artifacts_dir="${CAPNP_DENO_ARTIFACTS_DIR:-$capnp_deno_root/generated}"
build_timeout_seconds="${CAPNPC_ZIG_BUILD_TIMEOUT_SECONDS:-0}"
build_retry_count="${CAPNPC_ZIG_BUILD_RETRIES:-0}"
build_heartbeat_seconds="${CAPNPC_ZIG_BUILD_HEARTBEAT_SECONDS:-60}"

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

if ! [[ "$build_timeout_seconds" =~ ^[0-9]+$ ]]; then
  echo "CAPNPC_ZIG_BUILD_TIMEOUT_SECONDS must be a non-negative integer." >&2
  exit 1
fi
if ! [[ "$build_retry_count" =~ ^[0-9]+$ ]]; then
  echo "CAPNPC_ZIG_BUILD_RETRIES must be a non-negative integer." >&2
  exit 1
fi
if ! [[ "$build_heartbeat_seconds" =~ ^[0-9]+$ ]] || [[ "$build_heartbeat_seconds" -lt 1 ]]; then
  echo "CAPNPC_ZIG_BUILD_HEARTBEAT_SECONDS must be a positive integer." >&2
  exit 1
fi

run_zig_build_with_watchdog() {
  local timeout_seconds="$1"
  local heartbeat_seconds="$2"
  local pid=""
  local start_epoch=0
  local now_epoch=0
  local elapsed_seconds=0

  zig build wasm-deno -Doptimize=ReleaseSmall &
  pid="$!"
  start_epoch="$(date +%s)"

  while kill -0 "$pid" >/dev/null 2>&1; do
    sleep "$heartbeat_seconds"
    now_epoch="$(date +%s)"
    elapsed_seconds="$((now_epoch - start_epoch))"
    echo "zig build wasm-deno still running (${elapsed_seconds}s elapsed)"

    if [[ "$timeout_seconds" -gt 0 && "$elapsed_seconds" -ge "$timeout_seconds" ]]; then
      echo "zig build wasm-deno exceeded timeout (${timeout_seconds}s); terminating attempt." >&2
      kill -TERM "$pid" >/dev/null 2>&1 || true
      sleep 5
      kill -KILL "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
      return 124
    fi
  done

  wait "$pid"
}

cd "$capnpc_zig_root"

max_attempts="$((build_retry_count + 1))"
attempt=1
build_exit=1

while [[ "$attempt" -le "$max_attempts" ]]; do
  echo "Running zig wasm build attempt ${attempt}/${max_attempts}"
  build_exit=0
  run_zig_build_with_watchdog "$build_timeout_seconds" "$build_heartbeat_seconds" ||
    build_exit="$?"

  if [[ "$build_exit" -eq 0 ]]; then
    break
  fi

  if [[ "$build_exit" -eq 124 && "$attempt" -lt "$max_attempts" ]]; then
    echo "Retrying zig wasm build after timeout; clearing local zig build cache..." >&2
    rm -rf "$capnpc_zig_root/.zig-cache" "$capnpc_zig_root/zig-out"
  else
    break
  fi

  attempt="$((attempt + 1))"
done

if [[ "$build_exit" -ne 0 ]]; then
  echo "zig wasm build failed with exit code ${build_exit}" >&2
  exit "$build_exit"
fi

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

# Optionally post-optimize with Binaryen when available.
if command -v wasm-opt >/dev/null 2>&1; then
  wasm_tmp="$artifacts_dir/capnp_deno.wasm.tmp"
  if wasm-opt --enable-bulk-memory -Oz --strip-debug \
    -o "$wasm_tmp" \
    "$artifacts_dir/capnp_deno.wasm"; then
    mv "$wasm_tmp" "$artifacts_dir/capnp_deno.wasm"
  else
    rm -f "$wasm_tmp"
    echo "wasm-opt failed; keeping unoptimized wasm artifact." >&2
  fi
else
  echo "wasm-opt not found; skipping post-link wasm optimization." >&2
fi

echo "Wrote $artifacts_dir/capnp_deno.wasm"
