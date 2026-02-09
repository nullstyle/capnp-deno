/**
 * Runtime module configuration for WASM peer creation.
 *
 * @module
 */

import type { CapnpWasmExports } from "./abi.ts";
import type { WasmPeer } from "./wasm_peer.ts";
import { WasmPeer as WasmPeerClass } from "./wasm_peer.ts";
import * as runtimeWasmExports from "../generated/capnp_deno.wasm";

/**
 * Options for loading the default runtime module used by high-level session
 * and runtime factory helpers.
 */
export interface RpcRuntimeModuleOptions {
  /** Expected ABI version. Defaults to `1`. */
  expectedVersion?: number;
}

const STATIC_RUNTIME_WASM_EXPORTS = runtimeWasmExports as unknown as
  & CapnpWasmExports
  & Record<string, unknown>;

/**
 * Create a fresh WASM peer using the runtime module defaults.
 */
export function createRuntimePeer(
  options: RpcRuntimeModuleOptions = {},
): WasmPeer {
  return WasmPeerClass.fromExports(STATIC_RUNTIME_WASM_EXPORTS, {
    expectedVersion: options.expectedVersion ?? 1,
  });
}
