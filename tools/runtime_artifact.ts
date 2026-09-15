/** Runtime build provenance shared by rebuild, verification, and packaging. */
export interface RuntimeToolchain {
  schemaVersion: number;
  capnpZigCommit: string;
  zigVersion: string;
  buildStep: string;
  optimization: string;
  binaryenVersion: string;
  binaryenArgs: string[];
}

export interface RuntimeReceipt {
  schemaVersion: 1;
  toolchain: RuntimeToolchain;
  artifact: { filename: string; sha256: string; bytes: number };
  abi: {
    version: number;
    minimum: number;
    maximum: number;
    features: number[];
  };
  exports: WebAssembly.ModuleExportDescriptor[];
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function describeRuntime(
  bytes: Uint8Array,
  toolchain: RuntimeToolchain,
): Promise<RuntimeReceipt> {
  const module = await WebAssembly.compile(bytes.slice().buffer);
  if (WebAssembly.Module.imports(module).length !== 0) {
    throw new Error("runtime WASM must not require host imports");
  }
  const instance = await WebAssembly.instantiate(module);
  function numericExport(name: string): number {
    const fn = instance.exports[name];
    if (typeof fn !== "function") throw new Error(`runtime lacks ${name}`);
    const result = fn();
    if (typeof result !== "number") {
      throw new Error(`invalid runtime export ${name}`);
    }
    return result >>> 0;
  }
  return {
    schemaVersion: 1,
    toolchain,
    artifact: {
      filename: "capnp_deno.wasm",
      sha256: await sha256(bytes),
      bytes: bytes.length,
    },
    abi: {
      version: numericExport("capnp_wasm_abi_version"),
      minimum: numericExport("capnp_wasm_abi_min_version"),
      maximum: numericExport("capnp_wasm_abi_max_version"),
      features: [
        numericExport("capnp_wasm_feature_flags_lo"),
        numericExport("capnp_wasm_feature_flags_hi"),
      ],
    },
    exports: WebAssembly.Module.exports(module).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    ),
  };
}

export async function verifyRuntime(
  bytes: Uint8Array,
  receipt: RuntimeReceipt,
  toolchain: RuntimeToolchain,
): Promise<void> {
  // Check bytes before compiling: corruption must never execute as a module.
  if (
    receipt.schemaVersion !== 1 ||
    receipt.artifact.filename !== "capnp_deno.wasm" ||
    receipt.artifact.bytes !== bytes.length ||
    receipt.artifact.sha256 !== await sha256(bytes)
  ) {
    throw new Error(
      "runtime artifact integrity mismatch; rebuild with deno task build:wasm",
    );
  }
  if (JSON.stringify(receipt.toolchain) !== JSON.stringify(toolchain)) {
    throw new Error("runtime provenance does not match the pinned toolchain");
  }
  const actual = await describeRuntime(bytes, toolchain);
  if (JSON.stringify(actual) !== JSON.stringify(receipt)) {
    throw new Error("runtime ABI/export receipt does not match the artifact");
  }
}

if (import.meta.main) {
  const artifact = new URL("../generated/capnp_deno.wasm", import.meta.url);
  const receipt = await Deno.readTextFile(
    new URL("../generated/capnp_deno.provenance.json", import.meta.url),
  );
  const pin = await Deno.readTextFile(
    new URL("./runtime-toolchain.json", import.meta.url),
  );
  await verifyRuntime(
    await Deno.readFile(artifact),
    JSON.parse(receipt),
    JSON.parse(pin),
  );
  console.log("Runtime artifact and provenance verified");
}
