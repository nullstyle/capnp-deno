/**
 * WASM module instantiation and peer loading.
 *
 * @module
 */

import { getCapnpWasmExports, type WasmAbiOptions } from "./abi.ts";
import { InstantiationError } from "../errors.ts";
import { WasmPeer } from "./peer.ts";

/**
 * Result of instantiating a Cap'n Proto WASM peer via {@link instantiatePeer}.
 */
export interface InstantiatePeerResult {
  /** The underlying WebAssembly instance. */
  instance: WebAssembly.Instance;
  /** The compiled WebAssembly module (can be reused for additional instances). */
  module: WebAssembly.Module;
  /** The ready-to-use WasmPeer. */
  peer: WasmPeer;
}

function isArrayBufferView(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value);
}

function toArrayBuffer(source: BufferSource): ArrayBuffer {
  if (source instanceof ArrayBuffer) {
    return source;
  }
  if (source instanceof SharedArrayBuffer) {
    const copy = new Uint8Array(source.byteLength);
    copy.set(new Uint8Array(source));
    return copy.buffer;
  }
  if (isArrayBufferView(source)) {
    const copy = new Uint8Array(source.byteLength);
    copy.set(
      new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
    );
    return copy.buffer;
  }
  throw new InstantiationError("unsupported BufferSource");
}

function isLikelyUrlString(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
}

async function instantiateFromArrayBuffer(
  bytes: ArrayBuffer,
  imports: WebAssembly.Imports,
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  const module = await WebAssembly.compile(bytes);
  const instance = await WebAssembly.instantiate(module, imports);
  return { module, instance };
}

async function instantiateFromResponse(
  response: Response,
  imports: WebAssembly.Imports,
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  try {
    return await WebAssembly.instantiateStreaming(response, imports);
  } catch (_err) {
    return await instantiateFromArrayBuffer(
      await response.arrayBuffer(),
      imports,
    );
  }
}

async function instantiateFromUrl(
  url: URL,
  imports: WebAssembly.Imports,
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  if (url.protocol === "file:") {
    const bytes = await Deno.readFile(url);
    return await instantiateFromArrayBuffer(toArrayBuffer(bytes), imports);
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new InstantiationError(
      `failed to fetch wasm module: ${response.status} ${response.statusText}`,
    );
  }
  return await instantiateFromResponse(response, imports);
}

/**
 * Loads a Cap'n Proto WASM module and creates a ready-to-use {@link WasmPeer}.
 *
 * This is the primary entry point for loading WASM modules. It accepts a
 * variety of source types and handles compilation, instantiation, export
 * validation, and peer creation in a single call.
 *
 * @param source - The WASM module source. Accepts:
 *   - A `URL` or URL string pointing to a `.wasm` file (supports `file:`, `http:`, `https:` schemes)
 *   - A file path string (loaded via `Deno.readFile`)
 *   - A `Response` object (uses streaming instantiation when possible)
 *   - A `BufferSource` containing the raw WASM bytes
 * @param imports - WebAssembly imports to provide to the module. Defaults to `{}`.
 * @param options - ABI version negotiation options.
 * @returns The instantiated module, compiled module, and ready-to-use peer.
 * @throws {InstantiationError} If the source cannot be loaded or compiled.
 * @throws {WasmAbiError} If required exports are missing or version negotiation fails.
 *
 * @example
 * ```ts
 * const { peer } = await instantiatePeer(
 *   new URL("./capnp_deno.wasm", import.meta.url),
 *   {},
 *   { expectedVersion: 1 },
 * );
 * try {
 *   const { frames: outbound } = peer.pushFrame(inboundFrame);
 *   // ... process outbound frames
 * } finally {
 *   peer.close();
 * }
 * ```
 */
export async function instantiatePeer(
  source: URL | string | Response | BufferSource,
  imports: WebAssembly.Imports = {},
  options: WasmAbiOptions = {},
): Promise<InstantiatePeerResult> {
  let instantiated: WebAssembly.WebAssemblyInstantiatedSource;

  if (source instanceof Response) {
    instantiated = await instantiateFromResponse(source, imports);
  } else if (source instanceof URL) {
    instantiated = await instantiateFromUrl(source, imports);
  } else if (typeof source === "string") {
    if (isLikelyUrlString(source)) {
      instantiated = await instantiateFromUrl(new URL(source), imports);
    } else {
      const bytes = await Deno.readFile(source);
      instantiated = await instantiateFromArrayBuffer(
        toArrayBuffer(bytes),
        imports,
      );
    }
  } else {
    instantiated = await instantiateFromArrayBuffer(
      toArrayBuffer(source),
      imports,
    );
  }

  const exports = getCapnpWasmExports(instantiated.instance);
  const peer = WasmPeer.fromExports(exports, options);
  return {
    instance: instantiated.instance,
    module: instantiated.module,
    peer,
  };
}
