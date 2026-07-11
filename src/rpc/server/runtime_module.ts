/**
 * Runtime module configuration for WASM peer creation.
 *
 * @module
 */

import type { CapnpWasmExports } from "../../wasm/abi.ts";
import type { WasmPeer } from "../../wasm/peer.ts";
import { WasmPeer as WasmPeerClass } from "../../wasm/peer.ts";
import * as runtimeWasmExports from "../../../generated/capnp_deno.wasm";

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
 *
 * @param options - Runtime module options; `expectedVersion` defaults to `1`.
 * @returns A new {@link WasmPeer} backed by the bundled runtime WASM module.
 *
 * @example
 * ```ts
 * // createRuntimePeer comes from `@nullstyle/capnp/advanced`.
 * const peer = createRuntimePeer();
 * try {
 *   // Hand the peer to an RpcSession or drive it directly.
 * } finally {
 *   peer.close();
 * }
 * ```
 */
export function createRuntimePeer(
  options: RpcRuntimeModuleOptions = {},
): WasmPeer {
  return WasmPeerClass.fromExports(STATIC_RUNTIME_WASM_EXPORTS, {
    expectedVersion: options.expectedVersion ?? 1,
  });
}

/**
 * Returns the export object of the bundled Cap'n Proto runtime WASM module.
 *
 * Use this to feed low-level helpers such as `WasmSerde.fromExports(...)` or
 * `WasmPeer.fromExports(...)` without building or instantiating a WASM module
 * yourself.
 *
 * @returns The statically imported runtime WASM exports shipped with the
 *   package.
 *
 * @example
 * ```ts
 * // getRuntimeWasmExports and WasmSerde come from `@nullstyle/capnp/advanced`.
 * const serde = WasmSerde.fromExports(getRuntimeWasmExports());
 * ```
 */
export function getRuntimeWasmExports():
  & CapnpWasmExports
  & Record<string, unknown> {
  return STATIC_RUNTIME_WASM_EXPORTS;
}
