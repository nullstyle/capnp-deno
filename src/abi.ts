/**
 * WASM ABI layer for Cap'n Proto.
 *
 * Provides the low-level interface to the capnp WASM module, including
 * peer management, host-call records, and memory read/write helpers.
 *
 * @module
 */

import { AbiError } from "./errors.ts";

// Cached TextEncoder and TextDecoder instances for efficient string conversion.
// These are stateless and can be reused across all WasmAbi instances.
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * Typed interface describing the raw exports from a Cap'n Proto WASM module.
 *
 * Required exports (memory, alloc, free, error, peer management) are
 * non-optional. Optional exports (host-call bridge, lifecycle helpers,
 * schema manifest, version negotiation) are marked with `?`.
 *
 * Typically obtained via {@link getCapnpWasmExports} rather than constructed
 * manually.
 */
export interface CapnpWasmExports {
  memory: WebAssembly.Memory;
  capnp_alloc(len: number): number;
  capnp_free(ptr: number, len: number): void;
  capnp_buf_free?(ptr: number, len: number): void;

  capnp_last_error_code(): number;
  capnp_last_error_ptr(): number;
  capnp_last_error_len(): number;
  capnp_clear_error(): void;

  capnp_peer_new(): number;
  capnp_peer_free(peer: number): void;
  capnp_peer_push_frame(
    peer: number,
    frame_ptr: number,
    frame_len: number,
  ): number;
  capnp_peer_pop_out_frame(
    peer: number,
    out_ptr_ptr: number,
    out_len_ptr: number,
  ): number;
  capnp_peer_pop_commit?(peer: number): void;
  capnp_peer_pop_host_call?(
    peer: number,
    out_question_id_ptr: number,
    out_interface_id_ptr: number,
    out_method_id_ptr: number,
    out_frame_ptr_ptr: number,
    out_frame_len_ptr: number,
  ): number;
  capnp_peer_free_host_call_frame?(
    peer: number,
    frame_ptr: number,
    frame_len: number,
  ): number;
  capnp_peer_respond_host_call_results?(
    peer: number,
    question_id: number,
    payload_ptr: number,
    payload_len: number,
  ): number;
  capnp_peer_respond_host_call_return_frame?(
    peer: number,
    return_frame_ptr: number,
    return_frame_len: number,
  ): number;
  capnp_peer_respond_host_call_exception?(
    peer: number,
    question_id: number,
    reason_ptr: number,
    reason_len: number,
  ): number;
  capnp_peer_send_finish?(
    peer: number,
    question_id: number,
    release_result_caps: number,
    require_early_cancellation: number,
  ): number;
  capnp_peer_send_release?(
    peer: number,
    cap_id: number,
    reference_count: number,
  ): number;
  capnp_peer_set_bootstrap_stub?(peer: number): number;
  capnp_peer_set_bootstrap_stub_with_id?(
    peer: number,
    out_export_id_ptr: number,
  ): number;
  capnp_schema_manifest_json?(
    out_ptr_ptr: number,
    out_len_ptr: number,
  ): number;

  capnp_wasm_abi_version?(): number;
  capnp_wasm_abi_min_version?(): number;
  capnp_wasm_abi_max_version?(): number;
  capnp_wasm_feature_flags_lo?(): number;
  capnp_wasm_feature_flags_hi?(): number;
  capnp_error_take?(
    out_code_ptr: number,
    out_msg_ptr_ptr: number,
    out_msg_len_ptr: number,
  ): number;
}

/**
 * Options for configuring {@link WasmAbi} version negotiation.
 */
export interface WasmAbiOptions {
  /** Expected ABI version number. Defaults to 1. */
  expectedVersion?: number;
  /** If true, the WASM module must export a version function or version range. */
  requireVersionExport?: boolean;
}

/**
 * Describes which optional capabilities the loaded WASM module supports.
 *
 * Populated automatically when constructing a {@link WasmAbi} instance.
 * Callers can inspect these flags to determine which features are available
 * before invoking optional ABI methods.
 */
export interface WasmAbiCapabilities {
  /** Whether `capnp_peer_pop_commit` is available for explicit frame commit. */
  hasPeerPopCommit: boolean;
  hasHostCallBridge: boolean;
  hasHostCallReturnFrame: boolean;
  hasHostCallFrameRelease: boolean;
  hasLifecycleHelpers: boolean;
  hasBootstrapStubIdentity: boolean;
  hasSchemaManifest: boolean;
  hasBufFree: boolean;
  hasErrorTake: boolean;
  hasAbiVersion: boolean;
  hasAbiVersionRange: boolean;
  hasFeatureFlags: boolean;
  abiVersion: number | null;
  abiMinVersion: number | null;
  abiMaxVersion: number | null;
  featureFlags: bigint;
}

/**
 * Represents a single host call extracted from the WASM peer's outbound queue.
 *
 * When a WASM peer makes an RPC call that should be handled on the host side,
 * the call details are returned as a `WasmHostCallRecord` by {@link WasmAbi.popHostCall}.
 */
export interface WasmHostCallRecord {
  /** The question ID identifying this RPC call within the session. */
  questionId: number;
  /** The Cap'n Proto interface ID for the target interface. */
  interfaceId: bigint;
  /** The method ordinal within the target interface. */
  methodId: number;
  /** The serialized Cap'n Proto call frame containing the parameters. */
  frame: Uint8Array;
}

/**
 * Default maximum number of frames that {@link WasmAbi.drainOutFrames} will
 * pop in a single call. This guards against a buggy or malicious WASM module
 * that generates an unbounded number of outbound frames, which could cause
 * out-of-memory on the host.
 */
export const DEFAULT_MAX_DRAIN_FRAMES = 1024;

/**
 * Result returned by {@link WasmAbi.drainOutFrames}.
 *
 * When the `maxFrames` limit is reached before the output queue is empty,
 * `truncated` is set to `true` so callers can detect the condition and
 * take appropriate action (e.g. log a warning, close the peer).
 */
export interface DrainOutFramesResult {
  /** The frames that were drained (may be fewer than the total available). */
  frames: Uint8Array[];
  /** True if draining stopped because the `maxFrames` limit was reached. */
  truncated: boolean;
}

/**
 * Options for sending a Finish message through the WASM ABI.
 */
export interface WasmSendFinishOptions {
  /** Whether to release result capabilities. Defaults to true. */
  releaseResultCaps?: boolean;
  /** Whether to require early cancellation. Defaults to false. */
  requireEarlyCancellation?: boolean;
}

/**
 * Error thrown by the WASM ABI layer when a low-level operation fails.
 *
 * Extends {@link AbiError} with a numeric `code` field that corresponds to
 * the error code returned by the WASM module's `capnp_last_error_code` export.
 */
export class WasmAbiError extends AbiError {
  /** Numeric error code from the WASM module. Zero indicates no specific code. */
  readonly code: number;

  /**
   * @param message - Human-readable error description.
   * @param code - Numeric error code from the WASM module. Defaults to 0.
   */
  constructor(message: string, code = 0) {
    super(message);
    this.name = "WasmAbiError";
    this.code = code;
  }
}

function expectFunction<T>(
  value: unknown,
  name: string,
): T {
  if (typeof value !== "function") {
    throw new WasmAbiError(`missing wasm export: ${name}`);
  }
  return value as T;
}

function expectMemory(value: unknown, name: string): WebAssembly.Memory {
  if (!(value instanceof WebAssembly.Memory)) {
    throw new WasmAbiError(`missing wasm memory export: ${name}`);
  }
  return value;
}

function normalizeU32(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new WasmAbiError(`${name} must return a u32, got ${value}`);
  }
  return value;
}

function readOptionalU32(
  fn: (() => number) | undefined,
  name: string,
): number | null {
  if (!fn) return null;
  return normalizeU32(fn(), name);
}

function detectCapabilities(exports: CapnpWasmExports): WasmAbiCapabilities {
  const hasHostCallResults =
    typeof exports.capnp_peer_respond_host_call_results === "function";
  const hasHostCallReturnFrame =
    typeof exports.capnp_peer_respond_host_call_return_frame === "function";

  const abiVersion = readOptionalU32(
    exports.capnp_wasm_abi_version,
    "capnp_wasm_abi_version",
  );
  const abiMinVersion = readOptionalU32(
    exports.capnp_wasm_abi_min_version,
    "capnp_wasm_abi_min_version",
  );
  const abiMaxVersion = readOptionalU32(
    exports.capnp_wasm_abi_max_version,
    "capnp_wasm_abi_max_version",
  );
  const featureFlagsLo = readOptionalU32(
    exports.capnp_wasm_feature_flags_lo,
    "capnp_wasm_feature_flags_lo",
  );
  const featureFlagsHi = readOptionalU32(
    exports.capnp_wasm_feature_flags_hi,
    "capnp_wasm_feature_flags_hi",
  );

  const hasAbiVersionRange = abiMinVersion !== null || abiMaxVersion !== null;
  if (hasAbiVersionRange) {
    if (abiMinVersion === null || abiMaxVersion === null) {
      throw new WasmAbiError(
        "capnp_wasm_abi_min_version and capnp_wasm_abi_max_version must both be present when version range negotiation is used",
      );
    }
    if (abiMinVersion > abiMaxVersion) {
      throw new WasmAbiError(
        `invalid wasm ABI version range: ${abiMinVersion}..${abiMaxVersion}`,
      );
    }
  }

  const hasFeatureFlags = featureFlagsLo !== null || featureFlagsHi !== null;
  if (hasFeatureFlags && (featureFlagsLo === null || featureFlagsHi === null)) {
    throw new WasmAbiError(
      "capnp_wasm_feature_flags_lo and capnp_wasm_feature_flags_hi must both be present",
    );
  }

  return {
    hasPeerPopCommit: typeof exports.capnp_peer_pop_commit === "function",
    hasHostCallBridge: typeof exports.capnp_peer_pop_host_call === "function" &&
      (hasHostCallResults || hasHostCallReturnFrame) &&
      typeof exports.capnp_peer_respond_host_call_exception === "function",
    hasHostCallReturnFrame,
    hasHostCallFrameRelease:
      typeof exports.capnp_peer_free_host_call_frame === "function",
    hasLifecycleHelpers: typeof exports.capnp_peer_send_finish === "function" &&
      typeof exports.capnp_peer_send_release === "function",
    hasBootstrapStubIdentity:
      typeof exports.capnp_peer_set_bootstrap_stub_with_id === "function",
    hasSchemaManifest: typeof exports.capnp_schema_manifest_json === "function",
    hasBufFree: typeof exports.capnp_buf_free === "function",
    hasErrorTake: typeof exports.capnp_error_take === "function",
    hasAbiVersion: abiVersion !== null,
    hasAbiVersionRange: hasAbiVersionRange,
    hasFeatureFlags: hasFeatureFlags,
    abiVersion,
    abiMinVersion,
    abiMaxVersion,
    featureFlags: hasFeatureFlags
      ? (BigInt(featureFlagsHi!) << 32n) | BigInt(featureFlagsLo!)
      : 0n,
  };
}

/**
 * Extracts and validates the typed Cap'n Proto ABI exports from a
 * WebAssembly instance.
 *
 * This function checks for all required exports (memory, alloc, free, error
 * management, peer creation) and discovers optional exports (host-call bridge,
 * lifecycle helpers, version negotiation).
 *
 * @param instance - A fully instantiated WebAssembly instance containing the
 *   Cap'n Proto WASM module.
 * @returns The validated, typed export bindings.
 * @throws {WasmAbiError} If any required export is missing or has the wrong type.
 */
export function getCapnpWasmExports(
  instance: WebAssembly.Instance,
): CapnpWasmExports {
  const raw = instance.exports as Record<string, unknown>;
  const exports: CapnpWasmExports = {
    memory: expectMemory(raw.memory, "memory"),
    capnp_alloc: expectFunction(raw.capnp_alloc, "capnp_alloc"),
    capnp_free: expectFunction(raw.capnp_free, "capnp_free"),
    capnp_last_error_code: expectFunction(
      raw.capnp_last_error_code,
      "capnp_last_error_code",
    ),
    capnp_last_error_ptr: expectFunction(
      raw.capnp_last_error_ptr,
      "capnp_last_error_ptr",
    ),
    capnp_last_error_len: expectFunction(
      raw.capnp_last_error_len,
      "capnp_last_error_len",
    ),
    capnp_clear_error: expectFunction(
      raw.capnp_clear_error,
      "capnp_clear_error",
    ),
    capnp_peer_new: expectFunction(raw.capnp_peer_new, "capnp_peer_new"),
    capnp_peer_free: expectFunction(raw.capnp_peer_free, "capnp_peer_free"),
    capnp_peer_push_frame: expectFunction(
      raw.capnp_peer_push_frame,
      "capnp_peer_push_frame",
    ),
    capnp_peer_pop_out_frame: expectFunction(
      raw.capnp_peer_pop_out_frame,
      "capnp_peer_pop_out_frame",
    ),
  };

  if (raw.capnp_peer_pop_commit !== undefined) {
    exports.capnp_peer_pop_commit = expectFunction(
      raw.capnp_peer_pop_commit,
      "capnp_peer_pop_commit",
    );
  }
  if (raw.capnp_peer_pop_host_call !== undefined) {
    exports.capnp_peer_pop_host_call = expectFunction(
      raw.capnp_peer_pop_host_call,
      "capnp_peer_pop_host_call",
    );
  }
  if (raw.capnp_peer_respond_host_call_results !== undefined) {
    exports.capnp_peer_respond_host_call_results = expectFunction(
      raw.capnp_peer_respond_host_call_results,
      "capnp_peer_respond_host_call_results",
    );
  }
  if (raw.capnp_peer_respond_host_call_return_frame !== undefined) {
    exports.capnp_peer_respond_host_call_return_frame = expectFunction(
      raw.capnp_peer_respond_host_call_return_frame,
      "capnp_peer_respond_host_call_return_frame",
    );
  }
  if (raw.capnp_peer_respond_host_call_exception !== undefined) {
    exports.capnp_peer_respond_host_call_exception = expectFunction(
      raw.capnp_peer_respond_host_call_exception,
      "capnp_peer_respond_host_call_exception",
    );
  }
  if (raw.capnp_peer_free_host_call_frame !== undefined) {
    exports.capnp_peer_free_host_call_frame = expectFunction(
      raw.capnp_peer_free_host_call_frame,
      "capnp_peer_free_host_call_frame",
    );
  }
  if (raw.capnp_peer_send_finish !== undefined) {
    exports.capnp_peer_send_finish = expectFunction(
      raw.capnp_peer_send_finish,
      "capnp_peer_send_finish",
    );
  }
  if (raw.capnp_peer_send_release !== undefined) {
    exports.capnp_peer_send_release = expectFunction(
      raw.capnp_peer_send_release,
      "capnp_peer_send_release",
    );
  }
  if (raw.capnp_peer_set_bootstrap_stub !== undefined) {
    exports.capnp_peer_set_bootstrap_stub = expectFunction(
      raw.capnp_peer_set_bootstrap_stub,
      "capnp_peer_set_bootstrap_stub",
    );
  }
  if (raw.capnp_peer_set_bootstrap_stub_with_id !== undefined) {
    exports.capnp_peer_set_bootstrap_stub_with_id = expectFunction(
      raw.capnp_peer_set_bootstrap_stub_with_id,
      "capnp_peer_set_bootstrap_stub_with_id",
    );
  }
  if (raw.capnp_schema_manifest_json !== undefined) {
    exports.capnp_schema_manifest_json = expectFunction(
      raw.capnp_schema_manifest_json,
      "capnp_schema_manifest_json",
    );
  }
  if (raw.capnp_buf_free !== undefined) {
    exports.capnp_buf_free = expectFunction(
      raw.capnp_buf_free,
      "capnp_buf_free",
    );
  }
  if (raw.capnp_wasm_abi_version !== undefined) {
    exports.capnp_wasm_abi_version = expectFunction(
      raw.capnp_wasm_abi_version,
      "capnp_wasm_abi_version",
    );
  }
  if (raw.capnp_wasm_abi_min_version !== undefined) {
    exports.capnp_wasm_abi_min_version = expectFunction(
      raw.capnp_wasm_abi_min_version,
      "capnp_wasm_abi_min_version",
    );
  }
  if (raw.capnp_wasm_abi_max_version !== undefined) {
    exports.capnp_wasm_abi_max_version = expectFunction(
      raw.capnp_wasm_abi_max_version,
      "capnp_wasm_abi_max_version",
    );
  }
  if (raw.capnp_wasm_feature_flags_lo !== undefined) {
    exports.capnp_wasm_feature_flags_lo = expectFunction(
      raw.capnp_wasm_feature_flags_lo,
      "capnp_wasm_feature_flags_lo",
    );
  }
  if (raw.capnp_wasm_feature_flags_hi !== undefined) {
    exports.capnp_wasm_feature_flags_hi = expectFunction(
      raw.capnp_wasm_feature_flags_hi,
      "capnp_wasm_feature_flags_hi",
    );
  }
  if (raw.capnp_error_take !== undefined) {
    exports.capnp_error_take = expectFunction(
      raw.capnp_error_take,
      "capnp_error_take",
    );
  }

  return exports;
}

// Layout of the popHostCall scratch region (24 bytes, 4-byte aligned):
//   offset  0: u32  questionId
//   offset  4: u64  interfaceId
//   offset 12: u16  methodId   (+ 2 bytes padding)
//   offset 16: u32  framePtr
//   offset 20: u32  frameLen
const HOST_CALL_SCRATCH_SIZE = 24;
const HC_OFF_QUESTION_ID = 0;
const HC_OFF_INTERFACE_ID = 4;
const HC_OFF_METHOD_ID = 12;
const HC_OFF_FRAME_PTR = 16;
const HC_OFF_FRAME_LEN = 20;

/**
 * High-level wrapper around the Cap'n Proto WASM ABI.
 *
 * `WasmAbi` provides a safe, ergonomic TypeScript interface over the raw WASM
 * function exports. It manages memory allocation, error extraction, peer
 * lifecycle, frame I/O, and host-call bridging.
 *
 * Most users should use {@link WasmPeer} (which wraps `WasmAbi`) or the
 * higher-level {@link instantiatePeer} function instead of constructing
 * `WasmAbi` directly.
 *
 * @example
 * ```ts
 * const exports = getCapnpWasmExports(instance);
 * const abi = new WasmAbi(exports, { expectedVersion: 1 });
 * const peerHandle = abi.createPeer();
 * ```
 */
export class WasmAbi {
  /** The raw typed WASM export bindings. */
  readonly exports: CapnpWasmExports;
  /** Detected optional capabilities of the loaded WASM module. */
  readonly capabilities: WasmAbiCapabilities;
  #errorTakeScratchPtr: number | null = null;
  #hostCallScratchPtr: number | null = null;

  // Cached views over WASM linear memory. Invalidated when the underlying
  // ArrayBuffer detaches (which happens on WebAssembly.Memory.grow()).
  #cachedBuffer: ArrayBuffer | SharedArrayBuffer | null = null;
  #cachedBytes: Uint8Array | null = null;
  #cachedView: DataView | null = null;

  /**
   * Creates a new WasmAbi wrapper around the given exports.
   *
   * @param exports - The typed WASM export bindings.
   * @param options - ABI version negotiation options.
   * @throws {WasmAbiError} If the ABI version does not match expectations.
   */
  constructor(exports: CapnpWasmExports, options: WasmAbiOptions = {}) {
    this.exports = exports;
    this.capabilities = detectCapabilities(exports);
    this.initErrorTakeScratch();
    this.initHostCallScratch();
    this.checkVersion(options);
  }

  /**
   * Creates a new Cap'n Proto peer in WASM memory.
   *
   * @returns The opaque peer handle for use with other ABI methods.
   * @throws {WasmAbiError} If peer creation fails.
   */
  createPeer(): number {
    this.clearError();
    const handle = this.exports.capnp_peer_new();
    if (handle === 0) {
      this.throwLastError("capnp_peer_new failed");
    }
    return handle;
  }

  /**
   * Frees a previously created peer. No-op if the handle is 0.
   *
   * @param handle - The peer handle returned by {@link createPeer}.
   */
  freePeer(handle: number): void {
    if (handle === 0) return;
    this.exports.capnp_peer_free(handle);
  }

  /**
   * Pushes an inbound Cap'n Proto frame into the peer for processing.
   *
   * @param peer - The peer handle.
   * @param frame - The raw bytes of the inbound Cap'n Proto message.
   * @throws {WasmAbiError} If the WASM module rejects the frame.
   */
  pushFrame(peer: number, frame: Uint8Array): void {
    const ptr = this.alloc(frame.byteLength);
    try {
      if (frame.byteLength > 0) {
        this.bytes().set(frame, ptr);
      }
      this.clearError();
      const ok = this.exports.capnp_peer_push_frame(
        peer,
        ptr,
        frame.byteLength,
      );
      if (ok !== 1) {
        this.throwLastError("capnp_peer_push_frame failed");
      }
    } finally {
      this.free(ptr, frame.byteLength);
    }
  }

  /**
   * Pops a single outbound frame from the peer's output queue.
   *
   * @param peer - The peer handle.
   * @returns The next outbound frame, or null if the queue is empty.
   * @throws {WasmAbiError} If an error occurs during the pop operation.
   */
  popOutFrame(peer: number): Uint8Array | null {
    const pairSize = 8;
    const pairPtr = this.alloc(pairSize);
    try {
      this.writeU32(pairPtr, 0);
      this.writeU32(pairPtr + 4, 0);

      this.clearError();
      const hasFrame = this.exports.capnp_peer_pop_out_frame(
        peer,
        pairPtr,
        pairPtr + 4,
      );
      if (hasFrame === 0) {
        const maybeErr = this.takeLastError();
        if (maybeErr) throw maybeErr;
        return null;
      }
      if (hasFrame !== 1) {
        throw new WasmAbiError(
          `unexpected capnp_peer_pop_out_frame result: ${hasFrame}`,
        );
      }

      const framePtr = this.readU32(pairPtr);
      const frameLen = this.readU32(pairPtr + 4);
      const frame = this.copyBytes(framePtr, frameLen);

      if (this.capabilities.hasPeerPopCommit) {
        this.clearError();
        this.exports.capnp_peer_pop_commit!(peer);
        const maybeCommitErr = this.takeLastError();
        if (maybeCommitErr) throw maybeCommitErr;
      }

      return frame;
    } finally {
      this.free(pairPtr, pairSize);
    }
  }

  /**
   * Drains outbound frames from the peer's output queue, up to a limit.
   *
   * If the queue contains more frames than `maxFrames`, draining stops early
   * and the returned result has `truncated: true`. This prevents a buggy or
   * malicious WASM module from causing unbounded memory growth on the host.
   *
   * @param peer - The peer handle.
   * @param maxFrames - Maximum number of frames to drain. Defaults to
   *   {@link DEFAULT_MAX_DRAIN_FRAMES} (1024).
   * @returns A {@link DrainOutFramesResult} with the drained frames and a
   *   truncation flag.
   */
  drainOutFrames(
    peer: number,
    maxFrames: number = DEFAULT_MAX_DRAIN_FRAMES,
  ): DrainOutFramesResult {
    const out: Uint8Array[] = [];
    while (out.length < maxFrames) {
      const frame = this.popOutFrame(peer);
      if (frame === null) return { frames: out, truncated: false };
      out.push(frame);
    }
    // We hit the limit — there may still be frames queued in the WASM peer.
    return { frames: out, truncated: true };
  }

  /**
   * Pops a pending host call from the WASM peer.
   *
   * Host calls are RPC calls that the WASM peer wants to dispatch to
   * host-side handlers. This method requires the host-call bridge capability.
   *
   * @param peer - The peer handle.
   * @returns The next host call record, or null if none are pending.
   * @throws {WasmAbiError} If the host-call bridge export is missing.
   */
  popHostCall(peer: number): WasmHostCallRecord | null {
    const fn = this.exports.capnp_peer_pop_host_call;
    if (!fn) {
      throw new WasmAbiError("missing wasm export: capnp_peer_pop_host_call");
    }

    // Use the pre-allocated scratch buffer if available, otherwise fall back
    // to per-call allocation (e.g. if the initial alloc failed during init).
    const scratch = this.#hostCallScratchPtr;
    if (scratch === null) {
      return this.popHostCallFallback(fn, peer);
    }

    const s = scratch;
    this.writeU32(s + HC_OFF_QUESTION_ID, 0);
    this.writeU64(s + HC_OFF_INTERFACE_ID, 0n);
    this.writeU16(s + HC_OFF_METHOD_ID, 0);
    this.writeU32(s + HC_OFF_FRAME_PTR, 0);
    this.writeU32(s + HC_OFF_FRAME_LEN, 0);

    this.clearError();
    const hasCall = fn(
      peer,
      s + HC_OFF_QUESTION_ID,
      s + HC_OFF_INTERFACE_ID,
      s + HC_OFF_METHOD_ID,
      s + HC_OFF_FRAME_PTR,
      s + HC_OFF_FRAME_LEN,
    );
    if (hasCall === 0) {
      const maybeErr = this.takeLastError();
      if (maybeErr) throw maybeErr;
      return null;
    }
    if (hasCall !== 1) {
      throw new WasmAbiError(
        `unexpected capnp_peer_pop_host_call result: ${hasCall}`,
      );
    }

    const questionId = this.readU32(s + HC_OFF_QUESTION_ID);
    const interfaceId = this.readU64(s + HC_OFF_INTERFACE_ID);
    const methodId = this.readU16(s + HC_OFF_METHOD_ID);
    const framePtr = this.readU32(s + HC_OFF_FRAME_PTR);
    const frameLen = this.readU32(s + HC_OFF_FRAME_LEN);
    const frame = this.copyBytes(framePtr, frameLen);
    this.freeHostCallFrame(peer, framePtr, frameLen);
    return {
      questionId,
      interfaceId,
      methodId,
      frame,
    };
  }

  freeHostCallFrame(peer: number, framePtr: number, frameLen: number): void {
    const fn = this.exports.capnp_peer_free_host_call_frame;
    if (!fn) return;

    this.clearError();
    const ok = fn(peer, framePtr, frameLen);
    if (ok !== 1) {
      this.throwLastError("capnp_peer_free_host_call_frame failed");
    }
  }

  /**
   * Responds to a host call with a successful result payload.
   *
   * @param peer - The peer handle.
   * @param questionId - The question ID from the original host call.
   * @param payloadFrame - The serialized result payload.
   * @throws {WasmAbiError} If the export is missing or the response fails.
   */
  respondHostCallResults(
    peer: number,
    questionId: number,
    payloadFrame: Uint8Array,
  ): void {
    const fn = this.exports.capnp_peer_respond_host_call_results;
    if (!fn) {
      throw new WasmAbiError(
        "missing wasm export: capnp_peer_respond_host_call_results",
      );
    }

    this.assertU32(questionId, "questionId");
    const ptr = this.alloc(payloadFrame.byteLength);
    try {
      if (payloadFrame.byteLength > 0) {
        this.bytes().set(payloadFrame, ptr);
      }
      this.clearError();
      const ok = fn(peer, questionId, ptr, payloadFrame.byteLength);
      if (ok !== 1) {
        this.throwLastError("capnp_peer_respond_host_call_results failed");
      }
    } finally {
      this.free(ptr, payloadFrame.byteLength);
    }
  }

  /**
   * Responds to a host call with a pre-encoded return frame.
   *
   * This method uses the newer return-frame ABI which supports cap tables
   * and non-default return flags. Requires the `hasHostCallReturnFrame` capability.
   *
   * @param peer - The peer handle.
   * @param returnFrame - The pre-encoded Cap'n Proto return frame.
   * @throws {WasmAbiError} If the export is missing or the response fails.
   */
  respondHostCallReturnFrame(
    peer: number,
    returnFrame: Uint8Array,
  ): void {
    const fn = this.exports.capnp_peer_respond_host_call_return_frame;
    if (!fn) {
      throw new WasmAbiError(
        "missing wasm export: capnp_peer_respond_host_call_return_frame",
      );
    }

    const ptr = this.alloc(returnFrame.byteLength);
    try {
      if (returnFrame.byteLength > 0) {
        this.bytes().set(returnFrame, ptr);
      }
      this.clearError();
      const ok = fn(peer, ptr, returnFrame.byteLength);
      if (ok !== 1) {
        this.throwLastError("capnp_peer_respond_host_call_return_frame failed");
      }
    } finally {
      this.free(ptr, returnFrame.byteLength);
    }
  }

  /**
   * Responds to a host call with an exception.
   *
   * @param peer - The peer handle.
   * @param questionId - The question ID from the original host call.
   * @param reason - The error reason as a string or UTF-8 bytes.
   * @throws {WasmAbiError} If the export is missing or the response fails.
   */
  respondHostCallException(
    peer: number,
    questionId: number,
    reason: string | Uint8Array,
  ): void {
    const fn = this.exports.capnp_peer_respond_host_call_exception;
    if (!fn) {
      throw new WasmAbiError(
        "missing wasm export: capnp_peer_respond_host_call_exception",
      );
    }

    this.assertU32(questionId, "questionId");
    const bytes = typeof reason === "string"
      ? TEXT_ENCODER.encode(reason)
      : reason;
    const ptr = this.alloc(bytes.byteLength);
    try {
      if (bytes.byteLength > 0) {
        this.bytes().set(bytes, ptr);
      }
      this.clearError();
      const ok = fn(peer, questionId, ptr, bytes.byteLength);
      if (ok !== 1) {
        this.throwLastError("capnp_peer_respond_host_call_exception failed");
      }
    } finally {
      this.free(ptr, bytes.byteLength);
    }
  }

  /**
   * Sends a Finish message through the WASM peer to signal that a question's
   * answer is no longer needed.
   *
   * @param peer - The peer handle.
   * @param questionId - The question ID to finish.
   * @param options - Options controlling result cap release and early cancellation.
   * @throws {WasmAbiError} If the lifecycle helper export is missing or the operation fails.
   */
  sendFinish(
    peer: number,
    questionId: number,
    options: WasmSendFinishOptions = {},
  ): void {
    const fn = this.exports.capnp_peer_send_finish;
    if (!fn) {
      throw new WasmAbiError("missing wasm export: capnp_peer_send_finish");
    }

    this.assertU32(questionId, "questionId");
    const releaseResultCaps = options.releaseResultCaps ?? true;
    const requireEarlyCancellation = options.requireEarlyCancellation ?? false;
    this.clearError();
    const ok = fn(
      peer,
      questionId,
      releaseResultCaps ? 1 : 0,
      requireEarlyCancellation ? 1 : 0,
    );
    if (ok !== 1) {
      this.throwLastError("capnp_peer_send_finish failed");
    }
  }

  /**
   * Sends a Release message through the WASM peer to decrement a capability's
   * reference count.
   *
   * @param peer - The peer handle.
   * @param capId - The capability ID to release.
   * @param referenceCount - Number of references to release. Defaults to 1.
   * @throws {WasmAbiError} If the lifecycle helper export is missing or the operation fails.
   */
  sendRelease(peer: number, capId: number, referenceCount = 1): void {
    const fn = this.exports.capnp_peer_send_release;
    if (!fn) {
      throw new WasmAbiError("missing wasm export: capnp_peer_send_release");
    }

    this.assertU32(capId, "capId");
    this.assertU32(referenceCount, "referenceCount");
    this.clearError();
    const ok = fn(peer, capId, referenceCount);
    if (ok !== 1) {
      this.throwLastError("capnp_peer_send_release failed");
    }
  }

  /**
   * Retrieves the schema manifest from the WASM module as a JSON string.
   *
   * @returns The schema manifest JSON.
   * @throws {WasmAbiError} If the schema manifest export is missing or the operation fails.
   */
  schemaManifestJson(): string {
    const fn = this.exports.capnp_schema_manifest_json;
    if (!fn) {
      throw new WasmAbiError("missing wasm export: capnp_schema_manifest_json");
    }

    const pairSize = 8;
    const pairPtr = this.alloc(pairSize);
    try {
      this.writeU32(pairPtr, 0);
      this.writeU32(pairPtr + 4, 0);

      this.clearError();
      const ok = fn(pairPtr, pairPtr + 4);
      if (ok !== 1) {
        this.throwLastError("capnp_schema_manifest_json failed");
      }

      const ptr = this.readU32(pairPtr);
      const len = this.readU32(pairPtr + 4);
      const text = this.decodeUtf8(ptr, len);
      this.freeOutBuffer(ptr, len);
      return text;
    } finally {
      this.free(pairPtr, pairSize);
    }
  }

  clearError(): void {
    this.exports.capnp_clear_error();
  }

  freeOutBuffer(ptr: number, len: number): void {
    if (ptr === 0) return;
    const wanted = len === 0 ? 1 : len;
    if (this.capabilities.hasBufFree) {
      this.exports.capnp_buf_free!(ptr, wanted);
      return;
    }
    this.exports.capnp_free(ptr, wanted);
  }

  takeLastError(): WasmAbiError | null {
    const taken = this.takeLastErrorViaExport();
    if (taken) return taken;
    return this.readLastErrorFallback();
  }

  throwLastError(fallback: string): never {
    const err = this.takeLastError();
    if (err) {
      this.clearError();
      throw err;
    }
    throw new WasmAbiError(fallback);
  }

  /**
   * Checks whether the WASM module advertises support for a specific feature bit.
   *
   * @param bit - Feature bit index (0-63).
   * @returns True if the feature bit is set in the module's feature flags.
   * @throws {WasmAbiError} If the bit index is out of range.
   */
  supportsFeature(bit: number): boolean {
    if (!Number.isInteger(bit) || bit < 0 || bit > 63) {
      throw new WasmAbiError(`feature bit must be in [0, 63], got ${bit}`);
    }
    return ((this.capabilities.featureFlags >> BigInt(bit)) & 1n) === 1n;
  }

  private checkVersion(options: WasmAbiOptions): void {
    const expected = options.expectedVersion ?? 1;
    if (this.capabilities.hasAbiVersion) {
      const actual = this.capabilities.abiVersion!;
      if (actual !== expected) {
        throw new WasmAbiError(
          `capnp_wasm_abi_version mismatch: expected ${expected}, got ${actual}`,
        );
      }
      return;
    }

    if (this.capabilities.hasAbiVersionRange) {
      const min = this.capabilities.abiMinVersion!;
      const max = this.capabilities.abiMaxVersion!;
      if (expected < min || expected > max) {
        throw new WasmAbiError(
          `capnp_wasm_abi_version mismatch: expected ${expected}, supported range ${min}..${max}`,
        );
      }
      return;
    }

    if (options.requireVersionExport === true) {
      throw new WasmAbiError(
        "missing capnp_wasm_abi_version export (or capnp_wasm_abi_min_version/capnp_wasm_abi_max_version range exports)",
      );
    }
  }

  private alloc(len: number): number {
    const wanted = len === 0 ? 1 : len;
    this.clearError();
    const ptr = this.exports.capnp_alloc(wanted);
    if (ptr === 0) {
      this.throwLastError(`capnp_alloc failed for ${wanted} bytes`);
    }
    return ptr;
  }

  private free(ptr: number, len: number): void {
    if (ptr === 0) return;
    const wanted = len === 0 ? 1 : len;
    this.exports.capnp_free(ptr, wanted);
  }

  private readLastErrorFallback(): WasmAbiError | null {
    const code = this.exports.capnp_last_error_code();
    if (code === 0) return null;

    const ptr = this.exports.capnp_last_error_ptr();
    const len = this.exports.capnp_last_error_len();
    const message = this.decodeUtf8(ptr, len);
    const text = message.length > 0 ? message : `WASM error code ${code}`;
    return new WasmAbiError(text, code);
  }

  private initErrorTakeScratch(): void {
    if (!this.capabilities.hasErrorTake) return;
    this.clearError();
    const ptr = this.exports.capnp_alloc(12);
    if (ptr === 0) {
      this.capabilities.hasErrorTake = false;
      return;
    }
    this.#errorTakeScratchPtr = ptr;
  }

  private initHostCallScratch(): void {
    if (!this.capabilities.hasHostCallBridge) return;
    this.clearError();
    const ptr = this.exports.capnp_alloc(HOST_CALL_SCRATCH_SIZE);
    if (ptr === 0) {
      // Allocation failed; popHostCall will fall back to per-call allocation.
      return;
    }
    this.#hostCallScratchPtr = ptr;
  }

  /** Fallback path for popHostCall when the scratch buffer is unavailable. */
  private popHostCallFallback(
    fn: NonNullable<CapnpWasmExports["capnp_peer_pop_host_call"]>,
    peer: number,
  ): WasmHostCallRecord | null {
    const questionIdPtr = this.alloc(4);
    const interfaceIdPtr = this.alloc(8);
    const methodIdPtr = this.alloc(2);
    const framePtrPtr = this.alloc(4);
    const frameLenPtr = this.alloc(4);
    try {
      this.writeU32(questionIdPtr, 0);
      this.writeU64(interfaceIdPtr, 0n);
      this.writeU16(methodIdPtr, 0);
      this.writeU32(framePtrPtr, 0);
      this.writeU32(frameLenPtr, 0);

      this.clearError();
      const hasCall = fn(
        peer,
        questionIdPtr,
        interfaceIdPtr,
        methodIdPtr,
        framePtrPtr,
        frameLenPtr,
      );
      if (hasCall === 0) {
        const maybeErr = this.takeLastError();
        if (maybeErr) throw maybeErr;
        return null;
      }
      if (hasCall !== 1) {
        throw new WasmAbiError(
          `unexpected capnp_peer_pop_host_call result: ${hasCall}`,
        );
      }

      const questionId = this.readU32(questionIdPtr);
      const interfaceId = this.readU64(interfaceIdPtr);
      const methodId = this.readU16(methodIdPtr);
      const framePtr = this.readU32(framePtrPtr);
      const frameLen = this.readU32(frameLenPtr);
      const frame = this.copyBytes(framePtr, frameLen);
      this.freeHostCallFrame(peer, framePtr, frameLen);
      return {
        questionId,
        interfaceId,
        methodId,
        frame,
      };
    } finally {
      this.free(questionIdPtr, 4);
      this.free(interfaceIdPtr, 8);
      this.free(methodIdPtr, 2);
      this.free(framePtrPtr, 4);
      this.free(frameLenPtr, 4);
    }
  }

  private takeLastErrorViaExport(): WasmAbiError | null {
    if (
      !this.capabilities.hasErrorTake ||
      !this.exports.capnp_error_take ||
      this.#errorTakeScratchPtr === null
    ) {
      return null;
    }

    const scratch = this.#errorTakeScratchPtr;
    this.writeU32(scratch, 0);
    this.writeU32(scratch + 4, 0);
    this.writeU32(scratch + 8, 0);

    const taken = this.exports.capnp_error_take(
      scratch,
      scratch + 4,
      scratch + 8,
    );
    if (taken === 0) return null;
    if (taken !== 1) {
      throw new WasmAbiError(
        `unexpected capnp_error_take result: ${taken}`,
      );
    }

    const code = this.readU32(scratch);
    const ptr = this.readU32(scratch + 4);
    const len = this.readU32(scratch + 8);
    const text = this.decodeUtf8(ptr, len);
    this.freeOutBuffer(ptr, len);
    const message = text.length > 0 ? text : `WASM error code ${code}`;
    return new WasmAbiError(message, code);
  }

  private decodeUtf8(ptr: number, len: number): string {
    if (len === 0) return "";
    const memory = this.bytes();
    if (ptr + len > memory.byteLength) {
      return "invalid wasm error buffer bounds";
    }
    const slice = memory.subarray(ptr, ptr + len);
    return TEXT_DECODER.decode(slice);
  }

  private copyBytes(ptr: number, len: number): Uint8Array {
    if (len === 0) return new Uint8Array();
    const memory = this.bytes();
    if (ptr + len > memory.byteLength) {
      throw new WasmAbiError("invalid outbound frame bounds");
    }
    const out = new Uint8Array(len);
    out.set(memory.subarray(ptr, ptr + len));
    return out;
  }

  private assertU32(value: number, name: string): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new WasmAbiError(`${name} must be a u32, got ${value}`);
    }
  }

  private writeU16(offset: number, value: number): void {
    this.view().setUint16(offset, value & 0xffff, true);
  }

  private writeU32(offset: number, value: number): void {
    this.view().setUint32(offset, value >>> 0, true);
  }

  private writeU64(offset: number, value: bigint): void {
    this.view().setBigUint64(offset, value, true);
  }

  private readU16(offset: number): number {
    return this.view().getUint16(offset, true);
  }

  private readU32(offset: number): number {
    return this.view().getUint32(offset, true);
  }

  private readU64(offset: number): bigint {
    return this.view().getBigUint64(offset, true);
  }

  private bytes(): Uint8Array {
    const buf = this.exports.memory.buffer;
    if (this.#cachedBuffer !== buf || this.#cachedBytes === null) {
      this.#cachedBuffer = buf;
      this.#cachedBytes = new Uint8Array(buf);
      this.#cachedView = new DataView(buf);
    }
    return this.#cachedBytes;
  }

  private view(): DataView {
    const buf = this.exports.memory.buffer;
    if (this.#cachedBuffer !== buf || this.#cachedView === null) {
      this.#cachedBuffer = buf;
      this.#cachedBytes = new Uint8Array(buf);
      this.#cachedView = new DataView(buf);
    }
    return this.#cachedView;
  }
}
