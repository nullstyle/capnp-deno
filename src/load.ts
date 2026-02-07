import { getCapnpWasmExports, type WasmAbiOptions } from "./abi.ts";
import { InstantiationError } from "./errors.ts";
import { WasmPeer } from "./wasm_peer.ts";

export interface InstantiatePeerResult {
  instance: WebAssembly.Instance;
  module: WebAssembly.Module;
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
