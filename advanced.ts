export * from "./mod.ts";

export {
  type CapnpWasmExports,
  DEFAULT_MAX_DRAIN_FRAMES,
  type DrainOutFramesResult,
  getCapnpWasmExports,
  WasmAbi,
  type WasmAbiCapabilities,
  WasmAbiError,
  type WasmAbiOptions,
  type WasmHostCallRecord,
  type WasmSendFinishOptions,
} from "./src/wasm/abi.ts";

export { WasmPeer } from "./src/wasm/peer.ts";

export { instantiatePeer } from "./src/wasm/load.ts";

export {
  type JsonSerdeCodec,
  type JsonSerdeCodecLookupOptions,
  type JsonSerdeCodecOptions,
  type JsonSerdeExportBinding,
  WasmSerde,
} from "./src/encoding/serde.ts";
