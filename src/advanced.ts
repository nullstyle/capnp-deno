export * from "./mod.ts";

export {
  type CapnpWasmExports,
  decodeL3EventRecord,
  DEFAULT_MAX_DRAIN_FRAMES,
  type DrainOutFramesResult,
  getCapnpWasmExports,
  WASM_FEATURE_HOST_CALL_PARAM_CAP_RETENTION,
  WASM_FEATURE_L3_HANDOFF,
  WasmAbi,
  type WasmAbiCapabilities,
  WasmAbiError,
  type WasmAbiOptions,
  type WasmHostCallRecord,
  type WasmL3Event,
  type WasmSendFinishOptions,
} from "./wasm/abi.ts";

export { WasmPeer } from "./wasm/peer.ts";

// Experimental Level-3 three-party capability handoff (wasm feature bit 10).
export {
  type AcceptedCapability,
  acceptProvision,
  type AcceptProvisionOptions,
  type HandoffProvideHandle,
  type HandoffTokens,
  L3_EVENT_ACCEPT_RETURN,
  L3_EVENT_AWAIT_RETURN,
  L3_EVENT_RETURN_EXCEPTION,
  mintHandoffTokens,
  provideCapability,
  type ProvideCapabilityOptions,
  registerThirdPartyAwait,
  sendThirdPartyAnswer,
} from "./rpc/l3_handoff.ts";

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
