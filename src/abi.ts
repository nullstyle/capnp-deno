import { AbiError } from "./errors.ts";

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
  capnp_peer_respond_host_call_results?(
    peer: number,
    question_id: number,
    payload_ptr: number,
    payload_len: number,
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

export interface WasmAbiOptions {
  expectedVersion?: number;
  requireVersionExport?: boolean;
}

export interface WasmAbiCapabilities {
  hasPeerPopCommit: boolean;
  hasHostCallBridge: boolean;
  hasLifecycleHelpers: boolean;
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

export interface WasmHostCallRecord {
  questionId: number;
  interfaceId: bigint;
  methodId: number;
  frame: Uint8Array;
}

export interface WasmSendFinishOptions {
  releaseResultCaps?: boolean;
  requireEarlyCancellation?: boolean;
}

export class WasmAbiError extends AbiError {
  readonly code: number;

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
      typeof exports.capnp_peer_respond_host_call_results === "function" &&
      typeof exports.capnp_peer_respond_host_call_exception === "function",
    hasLifecycleHelpers: typeof exports.capnp_peer_send_finish === "function" &&
      typeof exports.capnp_peer_send_release === "function",
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
  if (raw.capnp_peer_respond_host_call_exception !== undefined) {
    exports.capnp_peer_respond_host_call_exception = expectFunction(
      raw.capnp_peer_respond_host_call_exception,
      "capnp_peer_respond_host_call_exception",
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

export class WasmAbi {
  readonly exports: CapnpWasmExports;
  readonly capabilities: WasmAbiCapabilities;
  #errorTakeScratchPtr: number | null = null;

  constructor(exports: CapnpWasmExports, options: WasmAbiOptions = {}) {
    this.exports = exports;
    this.capabilities = detectCapabilities(exports);
    this.initErrorTakeScratch();
    this.checkVersion(options);
  }

  createPeer(): number {
    this.clearError();
    const handle = this.exports.capnp_peer_new();
    if (handle === 0) {
      this.throwLastError("capnp_peer_new failed");
    }
    return handle;
  }

  freePeer(handle: number): void {
    if (handle === 0) return;
    this.exports.capnp_peer_free(handle);
  }

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

  drainOutFrames(peer: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    while (true) {
      const frame = this.popOutFrame(peer);
      if (frame === null) return out;
      out.push(frame);
    }
  }

  popHostCall(peer: number): WasmHostCallRecord | null {
    const fn = this.exports.capnp_peer_pop_host_call;
    if (!fn) {
      throw new WasmAbiError("missing wasm export: capnp_peer_pop_host_call");
    }

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
      ? new TextEncoder().encode(reason)
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
    return new TextDecoder().decode(slice);
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
    return new Uint8Array(this.exports.memory.buffer);
  }

  private view(): DataView {
    return new DataView(this.exports.memory.buffer);
  }
}
