import { instantiatePeer, InstantiationError } from "../../src/advanced.ts";
import { FakeCapnpWasm } from "../fake_wasm.ts";
import { assert, assertEquals } from "../test_utils.ts";

interface WasmPatches {
  compile?: (bytes: BufferSource) => Promise<WebAssembly.Module>;
  instantiate?: (
    module: WebAssembly.Module,
    imports?: WebAssembly.Imports,
  ) => Promise<WebAssembly.Instance>;
  instantiateStreaming?: (
    source: Response | Promise<Response>,
    imports?: WebAssembly.Imports,
  ) => Promise<WebAssembly.WebAssemblyInstantiatedSource>;
  fetch?: (input: Request | URL | string) => Promise<Response>;
  readFile?: (path: string | URL) => Promise<Uint8Array>;
}

function createFakeInstantiatedSource(): WebAssembly.WebAssemblyInstantiatedSource {
  const fake = new FakeCapnpWasm();
  return {
    module: {} as WebAssembly.Module,
    instance: {
      exports: fake.exports as unknown as WebAssembly.Exports,
    } as WebAssembly.Instance,
  };
}

function toBytes(buffer: BufferSource): number[] {
  if (buffer instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(buffer));
  }
  const view = new Uint8Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  return Array.from(view);
}

async function withPatchedGlobals(
  patches: WasmPatches,
  fn: () => Promise<void>,
): Promise<void> {
  const wasmMutable = WebAssembly as unknown as {
    compile: typeof WebAssembly.compile;
    instantiate: typeof WebAssembly.instantiate;
    instantiateStreaming: typeof WebAssembly.instantiateStreaming;
  };

  const originalCompile = wasmMutable.compile;
  const originalInstantiate = wasmMutable.instantiate;
  const originalInstantiateStreaming = wasmMutable.instantiateStreaming;
  const originalFetch = globalThis.fetch;
  const denoMutable = Deno as unknown as {
    readFile: typeof Deno.readFile;
  };
  const originalReadFile = denoMutable.readFile;

  if (patches.compile) {
    wasmMutable.compile = patches
      .compile as unknown as typeof WebAssembly.compile;
  }
  if (patches.instantiate) {
    wasmMutable.instantiate = patches
      .instantiate as unknown as typeof WebAssembly.instantiate;
  }
  if (patches.instantiateStreaming) {
    wasmMutable.instantiateStreaming = patches
      .instantiateStreaming as unknown as typeof WebAssembly.instantiateStreaming;
  }
  if (patches.fetch) {
    globalThis.fetch = patches.fetch as unknown as typeof globalThis.fetch;
  }
  if (patches.readFile) {
    denoMutable.readFile = patches.readFile as unknown as typeof Deno.readFile;
  }

  try {
    await fn();
  } finally {
    wasmMutable.compile = originalCompile;
    wasmMutable.instantiate = originalInstantiate;
    wasmMutable.instantiateStreaming = originalInstantiateStreaming;
    globalThis.fetch = originalFetch;
    denoMutable.readFile = originalReadFile;
  }
}

Deno.test("instantiatePeer accepts BufferSource variants", async () => {
  const compiledPayloads: number[][] = [];
  await withPatchedGlobals({
    compile: (bytes) => {
      compiledPayloads.push(toBytes(bytes));
      return Promise.resolve({} as WebAssembly.Module);
    },
    instantiate: () => Promise.resolve(createFakeInstantiatedSource().instance),
  }, async () => {
    const shared = new SharedArrayBuffer(3);
    new Uint8Array(shared).set([1, 2, 3]);

    const backing = new Uint8Array([9, 8, 7, 6]).buffer;
    const view = new Uint8Array(backing, 1, 2);

    const direct = new Uint8Array([5, 4]).buffer;

    const fromShared = await instantiatePeer(shared as unknown as BufferSource);
    const fromView = await instantiatePeer(view);
    const fromDirect = await instantiatePeer(direct);

    fromShared.peer.close();
    fromView.peer.close();
    fromDirect.peer.close();
  });

  assertEquals(
    JSON.stringify(compiledPayloads),
    JSON.stringify([[1, 2, 3], [8, 7], [5, 4]]),
  );
});

Deno.test("instantiatePeer falls back when instantiateStreaming fails", async () => {
  let streamingCalls = 0;
  let compileCalls = 0;
  let instantiateCalls = 0;
  const seenImports: Array<WebAssembly.Imports | undefined> = [];

  await withPatchedGlobals({
    instantiateStreaming: (_response, imports) => {
      streamingCalls += 1;
      seenImports.push(imports);
      return Promise.reject(new Error("streaming unavailable"));
    },
    compile: (_bytes) => {
      compileCalls += 1;
      return Promise.resolve({} as WebAssembly.Module);
    },
    instantiate: (_module, imports) => {
      instantiateCalls += 1;
      seenImports.push(imports);
      return Promise.resolve(createFakeInstantiatedSource().instance);
    },
  }, async () => {
    const response = new Response(new Uint8Array([0xaa, 0xbb]), {
      status: 200,
      headers: { "content-type": "application/wasm" },
    });
    const imports = { env: { now: 1 } } as unknown as WebAssembly.Imports;
    const result = await instantiatePeer(response, imports);
    assert(result.peer.handle > 0, "expected valid peer handle");
    result.peer.close();
  });

  assertEquals(streamingCalls, 1);
  assertEquals(compileCalls, 1);
  assertEquals(instantiateCalls, 1);
  assertEquals(seenImports.length, 2);
});

Deno.test("instantiatePeer loads URL via fetch and supports streaming success", async () => {
  const seenUrls: string[] = [];
  let streamingCalls = 0;
  let compileCalls = 0;

  await withPatchedGlobals({
    fetch: (input) => {
      seenUrls.push(String(input));
      return Promise.resolve(
        new Response(new Uint8Array([0x01]), {
          status: 200,
          headers: { "content-type": "application/wasm" },
        }),
      );
    },
    instantiateStreaming: () => {
      streamingCalls += 1;
      return Promise.resolve(createFakeInstantiatedSource());
    },
    compile: (_bytes) => {
      compileCalls += 1;
      return Promise.resolve({} as WebAssembly.Module);
    },
  }, async () => {
    const result = await instantiatePeer("https://example.com/capnp.wasm");
    assert(result.peer.handle > 0, "expected valid peer handle");
    result.peer.close();
  });

  assertEquals(
    JSON.stringify(seenUrls),
    JSON.stringify([
      "https://example.com/capnp.wasm",
    ]),
  );
  assertEquals(streamingCalls, 1);
  assertEquals(compileCalls, 0);
});

Deno.test("instantiatePeer reports fetch failures for URL sources", async () => {
  await withPatchedGlobals({
    fetch: () =>
      Promise.resolve(
        new Response("missing", {
          status: 404,
          statusText: "Not Found",
        }),
      ),
  }, async () => {
    let thrown: unknown;
    try {
      await instantiatePeer(new URL("https://example.com/missing.wasm"));
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof InstantiationError &&
        /failed to fetch wasm module: 404 Not Found/i.test(thrown.message),
      `expected fetch InstantiationError, got: ${String(thrown)}`,
    );
  });
});

Deno.test("instantiatePeer reads file URLs and path strings via Deno.readFile", async () => {
  const readFileCalls: Array<string> = [];
  let compileCalls = 0;
  let instantiateCalls = 0;

  await withPatchedGlobals({
    readFile: (path) => {
      readFileCalls.push(String(path));
      return Promise.resolve(new Uint8Array([0x09, 0x08, 0x07]));
    },
    compile: (_bytes) => {
      compileCalls += 1;
      return Promise.resolve({} as WebAssembly.Module);
    },
    instantiate: () => {
      instantiateCalls += 1;
      return Promise.resolve(createFakeInstantiatedSource().instance);
    },
  }, async () => {
    const fromFileUrl = await instantiatePeer(new URL("file:///tmp/a.wasm"));
    const fromPath = await instantiatePeer("/tmp/b.wasm");
    fromFileUrl.peer.close();
    fromPath.peer.close();
  });

  assertEquals(
    JSON.stringify(readFileCalls),
    JSON.stringify(["file:///tmp/a.wasm", "/tmp/b.wasm"]),
  );
  assertEquals(compileCalls, 2);
  assertEquals(instantiateCalls, 2);
});
