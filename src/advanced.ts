export * from "./mod.ts";

export {
  type CapnpWasmExports,
  DEFAULT_MAX_DRAIN_FRAMES,
  type DrainOutFramesResult,
  getCapnpWasmExports,
  WASM_FEATURE_HOST_CALL_PARAM_CAP_RETENTION,
  WasmAbi,
  type WasmAbiCapabilities,
  WasmAbiError,
  type WasmAbiOptions,
  type WasmHostCallRecord,
  type WasmSendFinishOptions,
} from "./wasm/abi.ts";

export { WasmPeer } from "./wasm/peer.ts";

export { instantiatePeer } from "./wasm/load.ts";

export {
  createRuntimePeer,
  getRuntimeWasmExports,
} from "./rpc/server/runtime_module.ts";

export {
  type JsonSerdeCodec,
  type JsonSerdeCodecLookupOptions,
  type JsonSerdeCodecOptions,
  type JsonSerdeExportBinding,
  WasmSerde,
} from "./encoding/serde.ts";
