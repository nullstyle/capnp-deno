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

export interface JsonSerdeExportBinding {
  key: string;
  toJsonExport: string;
  fromJsonExport: string;
}

export interface JsonSerdeCodec<T> {
  encode(value: T): Uint8Array;
  decode(bytes: Uint8Array): T;
  encodeJson(json: string): Uint8Array;
  decodeToJson(bytes: Uint8Array): string;
}

export interface JsonSerdeCodecOptions<T> {
  toJsonExport: string;
  fromJsonExport: string;
  stringify?: (value: T) => string;
  parse?: (json: string) => T;
}

export interface JsonSerdeCodecLookupOptions<T> {
  key: string;
  stringify?: (value: T) => string;
  parse?: (json: string) => T;
}

export class WasmSerde {
  readonly abi: WasmAbi;
  readonly rawExports: Record<string, unknown>;

  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  private constructor(
    abi: WasmAbi,
    rawExports: Record<string, unknown>,
  ) {
    this.abi = abi;
    this.rawExports = rawExports;
  }

  static fromInstance(
    instance: WebAssembly.Instance,
    options: WasmAbiOptions = {},
  ): WasmSerde {
    const raw = instance.exports as Record<string, unknown>;
    const typed = getCapnpWasmExports(instance);
    const abi = new WasmAbi(typed, options);
    return new WasmSerde(abi, raw);
  }

  static fromExports(
    exports: CapnpWasmExports & Record<string, unknown>,
    options: WasmAbiOptions = {},
  ): WasmSerde {
    const abi = new WasmAbi(exports, options);
    return new WasmSerde(abi, exports);
  }

  decodeToJson(exportName: string, bytes: Uint8Array): string {
    const binaryToJson = this.resolveSerdeExport(exportName);
    const out = this.callSerde(binaryToJson, bytes, exportName);
    return this.decoder.decode(out);
  }

  encodeFromJson(exportName: string, json: string): Uint8Array {
    const jsonToBinary = this.resolveSerdeExport(exportName);
    const encoded = this.encoder.encode(json);
    return this.callSerde(jsonToBinary, encoded, exportName);
  }

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

  resolveJsonCodec(key: string): JsonSerdeExportBinding {
    const binding = this.listJsonCodecs().find((entry) => entry.key === key);
    if (!binding) {
      throw new WasmAbiError(
        `missing wasm serde codec exports for key: ${key}`,
      );
    }
    return binding;
  }

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

  private callSerde(
    fn: SerdeExportFn,
    input: Uint8Array,
    exportName: string,
  ): Uint8Array {
    const pairSize = 8;
    const inputLen = input.byteLength;
    const inputPtr = this.alloc(inputLen);
    const pairPtr = this.alloc(pairSize);

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
      const out = this.copyBytes(outPtr, outLen);
      this.freeOutBuffer(outPtr, outLen);
      return out;
    } finally {
      this.free(inputPtr, inputLen);
      this.free(pairPtr, pairSize);
    }
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
