import {
  type CapnpWasmExports,
  getCapnpWasmExports,
  WasmAbi,
  WasmAbiError,
  type WasmAbiOptions,
} from "./abi.ts";

type SerdeExportFn = (
  input_ptr: number,
  input_len: number,
  out_ptr_ptr: number,
  out_len_ptr: number,
) => number;

/**
 * Describes a pair of WASM serde exports for a specific Cap'n Proto type,
 * linking the `capnp_<key>_to_json` and `capnp_<key>_from_json` export names.
 */
export interface JsonSerdeExportBinding {
  /** The type key extracted from the export name (e.g. `"my_struct"` from `capnp_my_struct_to_json`). */
  key: string;
  /** The name of the WASM export that converts Cap'n Proto binary to JSON. */
  toJsonExport: string;
  /** The name of the WASM export that converts JSON to Cap'n Proto binary. */
  fromJsonExport: string;
}

/**
 * A typed codec for serializing and deserializing a Cap'n Proto type `T`
 * through a JSON intermediate representation, backed by WASM serde exports.
 *
 * @typeParam T - The TypeScript type that this codec encodes and decodes.
 */
export interface JsonSerdeCodec<T> {
  /** Encode a value to Cap'n Proto binary bytes via JSON serialization. */
  encode(value: T): Uint8Array;
  /** Decode Cap'n Proto binary bytes to a value via JSON deserialization. */
  decode(bytes: Uint8Array): T;
  /** Encode a raw JSON string to Cap'n Proto binary bytes. */
  encodeJson(json: string): Uint8Array;
  /** Decode Cap'n Proto binary bytes to a raw JSON string. */
  decodeToJson(bytes: Uint8Array): string;
}

/**
 * Options for creating a {@link JsonSerdeCodec} with explicit WASM export names.
 *
 * @typeParam T - The TypeScript type that the codec handles.
 */
export interface JsonSerdeCodecOptions<T> {
  /** The name of the WASM export that converts Cap'n Proto binary to JSON. */
  toJsonExport: string;
  /** The name of the WASM export that converts JSON to Cap'n Proto binary. */
  fromJsonExport: string;
  /** Custom function to serialize `T` to a JSON string. Defaults to `JSON.stringify`. */
  stringify?: (value: T) => string;
  /** Custom function to parse a JSON string into `T`. Defaults to `JSON.parse`. */
  parse?: (json: string) => T;
}

/**
 * Options for creating a {@link JsonSerdeCodec} by looking up WASM exports
 * by their type key (e.g. `"my_struct"` matches `capnp_my_struct_to_json`
 * and `capnp_my_struct_from_json`).
 *
 * @typeParam T - The TypeScript type that the codec handles.
 */
export interface JsonSerdeCodecLookupOptions<T> {
  /** The type key used to find matching `capnp_<key>_to_json` / `capnp_<key>_from_json` exports. */
  key: string;
  /** Custom function to serialize `T` to a JSON string. Defaults to `JSON.stringify`. */
  stringify?: (value: T) => string;
  /** Custom function to parse a JSON string into `T`. Defaults to `JSON.parse`. */
  parse?: (json: string) => T;
}

/**
 * Provides JSON-based serialization and deserialization of Cap'n Proto types
 * through WASM serde exports.
 *
 * A WASM module compiled from a Cap'n Proto schema can export functions like
 * `capnp_<type>_to_json` and `capnp_<type>_from_json`. This class wraps those
 * exports with an optimized calling convention that minimizes memory copies
 * between JavaScript and WASM linear memory.
 *
 * Use the factory methods {@link fromInstance} or {@link fromExports} to create
 * instances. Then use {@link decodeToJson}, {@link encodeFromJson}, or create
 * typed codecs via {@link createJsonCodec} or {@link createJsonCodecFor}.
 *
 * @example
 * ```ts
 * const serde = WasmSerde.fromInstance(wasmInstance);
 * const codec = serde.createJsonCodecFor<MyStruct>({ key: "my_struct" });
 * const bytes = codec.encode({ field: "hello" });
 * const decoded = codec.decode(bytes);
 * ```
 */
export class WasmSerde {
  /** The underlying WASM ABI used for memory management. */
  readonly abi: WasmAbi;
  /** The raw WASM instance exports for direct access to serde functions. */
  readonly rawExports: Record<string, unknown>;

  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  /** Persistent 8-byte scratch buffer in WASM memory for out_ptr/out_len pairs. */
  private scratchPairPtr: number;

  private constructor(
    abi: WasmAbi,
    rawExports: Record<string, unknown>,
  ) {
    this.abi = abi;
    this.rawExports = rawExports;
    // Pre-allocate the 8-byte pair buffer once instead of per-call.
    this.scratchPairPtr = this.alloc(8);
  }

  /**
   * Create a {@link WasmSerde} from a WebAssembly instance.
   *
   * @param instance - The instantiated WASM module.
   * @param options - Options forwarded to the underlying {@link WasmAbi}.
   * @returns A new `WasmSerde` instance.
   */
  static fromInstance(
    instance: WebAssembly.Instance,
    options: WasmAbiOptions = {},
  ): WasmSerde {
    const raw = instance.exports as Record<string, unknown>;
    const typed = getCapnpWasmExports(instance);
    const abi = new WasmAbi(typed, options);
    return new WasmSerde(abi, raw);
  }

  /**
   * Create a {@link WasmSerde} from pre-extracted WASM exports.
   *
   * @param exports - The typed WASM exports combined with raw export entries.
   * @param options - Options forwarded to the underlying {@link WasmAbi}.
   * @returns A new `WasmSerde` instance.
   */
  static fromExports(
    exports: CapnpWasmExports & Record<string, unknown>,
    options: WasmAbiOptions = {},
  ): WasmSerde {
    const abi = new WasmAbi(exports, options);
    return new WasmSerde(abi, exports);
  }

  /**
   * Decode Cap'n Proto binary bytes to a JSON string.
   *
   * Optimized path: reads the WASM output directly as a string via
   * TextDecoder on a WASM memory subarray, avoiding an intermediate
   * Uint8Array copy of the JSON bytes.
   */
  decodeToJson(exportName: string, bytes: Uint8Array): string {
    const binaryToJson = this.resolveSerdeExport(exportName);
    return this.callSerdeToString(binaryToJson, bytes, exportName);
  }

  /**
   * Encode a JSON string into Cap'n Proto binary bytes.
   *
   * Optimized path: uses TextEncoder.encodeInto() to write the JSON
   * string directly into WASM linear memory, eliminating the intermediate
   * JS-side Uint8Array allocation from TextEncoder.encode().
   */
  encodeFromJson(exportName: string, json: string): Uint8Array {
    const jsonToBinary = this.resolveSerdeExport(exportName);
    return this.callSerdeFromString(jsonToBinary, json, exportName);
  }

  /**
   * Create a typed {@link JsonSerdeCodec} from explicit WASM export names.
   *
   * @typeParam T - The TypeScript type that the codec handles.
   * @param options - The export names and optional custom stringify/parse functions.
   * @returns A codec for encoding and decoding values of type `T`.
   */
  createJsonCodec<T>(options: JsonSerdeCodecOptions<T>): JsonSerdeCodec<T> {
    const stringify = options.stringify ?? ((value: T) => {
      const text = JSON.stringify(value);
      if (text === undefined) {
        throw new WasmAbiError("JSON.stringify returned undefined");
      }
      return text;
    });
    const parse = options.parse ?? ((text: string) => JSON.parse(text) as T);
    const toJsonName = options.toJsonExport;
    const fromJsonName = options.fromJsonExport;

    return {
      encode: (value: T): Uint8Array => {
        return this.encodeFromJson(fromJsonName, stringify(value));
      },
      decode: (bytes: Uint8Array): T => {
        return parse(this.decodeToJson(toJsonName, bytes));
      },
      encodeJson: (json: string): Uint8Array => {
        return this.encodeFromJson(fromJsonName, json);
      },
      decodeToJson: (bytes: Uint8Array): string => {
        return this.decodeToJson(toJsonName, bytes);
      },
    };
  }

  /**
   * Discover all available JSON serde codec bindings in the WASM module.
   *
   * Scans the raw exports for matching pairs of `capnp_<key>_to_json` and
   * `capnp_<key>_from_json` functions and returns them sorted by key.
   *
   * @returns An array of discovered codec bindings.
   */
  listJsonCodecs(): JsonSerdeExportBinding[] {
    const toJsonByKey = new Map<string, string>();
    const fromJsonByKey = new Map<string, string>();

    for (const [name, value] of Object.entries(this.rawExports)) {
      if (typeof value !== "function") continue;

      const toMatch = /^capnp_(.+)_to_json$/.exec(name);
      if (toMatch) {
        toJsonByKey.set(toMatch[1], name);
        continue;
      }

      const fromMatch = /^capnp_(.+)_from_json$/.exec(name);
      if (fromMatch) {
        fromJsonByKey.set(fromMatch[1], name);
      }
    }

    const out: JsonSerdeExportBinding[] = [];
    for (const [key, toJsonExport] of toJsonByKey.entries()) {
      const fromJsonExport = fromJsonByKey.get(key);
      if (!fromJsonExport) continue;
      out.push({
        key,
        toJsonExport,
        fromJsonExport,
      });
    }

    out.sort((a, b) => a.key.localeCompare(b.key));
    return out;
  }

  /**
   * Look up a specific JSON serde codec binding by its type key.
   *
   * @param key - The type key (e.g. `"my_struct"`).
   * @returns The matching codec binding.
   * @throws {WasmAbiError} If no matching exports are found for the given key.
   */
  resolveJsonCodec(key: string): JsonSerdeExportBinding {
    const binding = this.listJsonCodecs().find((entry) => entry.key === key);
    if (!binding) {
      throw new WasmAbiError(
        `missing wasm serde codec exports for key: ${key}`,
      );
    }
    return binding;
  }

  /**
   * Create a typed {@link JsonSerdeCodec} by looking up the WASM exports by type key.
   *
   * This is a convenience method that combines {@link resolveJsonCodec} and
   * {@link createJsonCodec} into a single call.
   *
   * @typeParam T - The TypeScript type that the codec handles.
   * @param options - The type key and optional custom stringify/parse functions.
   * @returns A codec for encoding and decoding values of type `T`.
   * @throws {WasmAbiError} If no matching exports are found for the given key.
   */
  createJsonCodecFor<T>(
    options: JsonSerdeCodecLookupOptions<T>,
  ): JsonSerdeCodec<T> {
    const binding = this.resolveJsonCodec(options.key);
    return this.createJsonCodec({
      toJsonExport: binding.toJsonExport,
      fromJsonExport: binding.fromJsonExport,
      stringify: options.stringify,
      parse: options.parse,
    });
  }

  private resolveSerdeExport(name: string): SerdeExportFn {
    const value = this.rawExports[name];
    if (typeof value !== "function") {
      throw new WasmAbiError(`missing wasm serde export: ${name}`);
    }
    return value as SerdeExportFn;
  }

  /**
   * Optimized encode path: writes a JS string directly into WASM memory
   * using TextEncoder.encodeInto(), avoiding the intermediate Uint8Array
   * that TextEncoder.encode() would create.
   *
   * Old path (3 copies):
   *   1. encoder.encode(json) -> JS Uint8Array
   *   2. bytes().set(jsArray, wasmPtr) -> WASM memory
   *   3. copyBytes(outPtr, outLen) -> JS Uint8Array result
   *
   * New path (2 copies):
   *   1. encodeInto(json, wasmMemorySlice) -> directly into WASM memory
   *   2. copyBytes(outPtr, outLen) -> JS Uint8Array result
   */
  private callSerdeFromString(
    fn: SerdeExportFn,
    input: string,
    exportName: string,
  ): Uint8Array {
    const pairPtr = this.scratchPairPtr;

    // Allocate enough space for the UTF-8 encoding of the input string.
    // maxByteLength = string.length * 3 is the upper bound for UTF-8.
    // For common ASCII-heavy JSON, the actual byte length will be much smaller,
    // but we need to allocate the worst case up front for encodeInto().
    const maxInputLen = input.length * 3;
    const inputLen = maxInputLen === 0 ? 0 : maxInputLen;
    const inputPtr = this.alloc(inputLen);

    try {
      let actualInputLen = 0;
      if (inputLen > 0) {
        // Write string directly into WASM memory, zero intermediate copies.
        const wasmSlice = new Uint8Array(
          this.abi.exports.memory.buffer,
          inputPtr,
          inputLen,
        );
        const result = this.encoder.encodeInto(input, wasmSlice);
        actualInputLen = result.written;
      }

      this.writeU32(pairPtr, 0);
      this.writeU32(pairPtr + 4, 0);

      this.clearError();
      const ok = fn(
        inputPtr,
        actualInputLen,
        pairPtr,
        pairPtr + 4,
      );
      if (ok !== 1) {
        this.abi.throwLastError(`${exportName} failed`);
      }

      const outPtr = this.readU32(pairPtr);
      const outLen = this.readU32(pairPtr + 4);
      const out = this.copyBytes(outPtr, outLen);
      this.freeOutBuffer(outPtr, outLen);
      return out;
    } finally {
      this.free(inputPtr, inputLen);
    }
  }

  /**
   * Optimized decode path: reads the WASM serde output directly as a
   * string using TextDecoder on a WASM memory subarray, avoiding the
   * intermediate copyBytes allocation.
   *
   * Old path (3 copies):
   *   1. bytes().set(input, wasmPtr) -> copy input into WASM
   *   2. copyBytes(outPtr, outLen) -> copy output to JS Uint8Array
   *   3. decoder.decode(jsArray) -> JS string
   *
   * New path (2 copies):
   *   1. bytes().set(input, wasmPtr) -> copy input into WASM
   *   2. decoder.decode(wasmMemorySubarray) -> JS string directly from WASM
   */
  private callSerdeToString(
    fn: SerdeExportFn,
    input: Uint8Array,
    exportName: string,
  ): string {
    const pairPtr = this.scratchPairPtr;
    const inputLen = input.byteLength;
    const inputPtr = this.alloc(inputLen);

    try {
      if (inputLen > 0) {
        this.bytes().set(input, inputPtr);
      }
      this.writeU32(pairPtr, 0);
      this.writeU32(pairPtr + 4, 0);

      this.clearError();
      const ok = fn(
        inputPtr,
        inputLen,
        pairPtr,
        pairPtr + 4,
      );
      if (ok !== 1) {
        this.abi.throwLastError(`${exportName} failed`);
      }

      const outPtr = this.readU32(pairPtr);
      const outLen = this.readU32(pairPtr + 4);

      // Decode directly from WASM memory without copying to a JS Uint8Array first.
      const text = this.decodeFromWasm(outPtr, outLen);
      this.freeOutBuffer(outPtr, outLen);
      return text;
    } finally {
      this.free(inputPtr, inputLen);
    }
  }

  /**
   * Decode UTF-8 text directly from a region in WASM linear memory,
   * without first copying the bytes into a separate JS Uint8Array.
   */
  private decodeFromWasm(ptr: number, len: number): string {
    if (len === 0) return "";
    const memory = this.bytes();
    if (ptr + len > memory.byteLength) {
      throw new WasmAbiError("invalid wasm serde output bounds");
    }
    // Use subarray to create a view (not a copy) into WASM memory,
    // then decode directly from the view.
    return this.decoder.decode(memory.subarray(ptr, ptr + len));
  }

  private freeOutBuffer(ptr: number, len: number): void {
    this.abi.freeOutBuffer(ptr, len);
  }

  private clearError(): void {
    this.abi.clearError();
  }

  private alloc(len: number): number {
    const wanted = len === 0 ? 1 : len;
    this.clearError();
    const ptr = this.abi.exports.capnp_alloc(wanted);
    if (ptr === 0) {
      this.abi.throwLastError(`capnp_alloc failed for ${wanted} bytes`);
    }
    return ptr;
  }

  private free(ptr: number, len: number): void {
    if (ptr === 0) return;
    const wanted = len === 0 ? 1 : len;
    this.abi.exports.capnp_free(ptr, wanted);
  }

  private copyBytes(ptr: number, len: number): Uint8Array {
    if (len === 0) return new Uint8Array();
    const memory = this.bytes();
    if (ptr + len > memory.byteLength) {
      throw new WasmAbiError("invalid wasm serde output bounds");
    }
    const out = new Uint8Array(len);
    out.set(memory.subarray(ptr, ptr + len));
    return out;
  }

  private writeU32(offset: number, value: number): void {
    this.view().setUint32(offset, value >>> 0, true);
  }

  private readU32(offset: number): number {
    return this.view().getUint32(offset, true);
  }

  private bytes(): Uint8Array {
    return new Uint8Array(this.abi.exports.memory.buffer);
  }

  private view(): DataView {
    return new DataView(this.abi.exports.memory.buffer);
  }
}
