#!/usr/bin/env bash
set -euo pipefail

repo_root="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  pwd
)"
out_dir="${1:-$repo_root/src/rpc/gen/capnp}"

cd "$repo_root"

deno task codegen generate \
  --layout flat \
  --schema vendor/capnp-zig/src/rpc/capnp/rpc.capnp \
  --schema vendor/capnp-zig/src/rpc/capnp/persistent.capnp \
  --out "$out_dir" \
  -I vendor/capnp-zig/src/rpc/capnp \
  -I vendor/capnp-zig/vendor/ext/capnproto/c++/src \
  --quiet

# Generated files default to package import specifiers. Rewrite to repo-local
# imports so runtime code can consume these modules without package resolution.
if [[ "$(uname -s)" == "Darwin" ]]; then
  sed_in_place=(-i '')
else
  sed_in_place=(-i)
fi

sed "${sed_in_place[@]}" \
  's|"@nullstyle/capnp/encoding"|"../../../encoding.ts"|g; s|"@nullstyle/capnp/rpc"|"../../server/rpc_runtime.ts"|g; s|RpcGeneratedServerDispatch as RpcServerDispatch|RpcServerDispatch|g' \
  "$out_dir/rpc_types.ts" \
  "$out_dir/persistent_types.ts"
