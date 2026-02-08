import { getCapnpWasmExports, WasmAbi, WasmAbiError } from "../mod.ts";
import { FakeCapnpWasm } from "./fake_wasm.ts";
import { assertEquals, assertThrows } from "./test_utils.ts";

Deno.test("getCapnpWasmExports validates required and optional export types", () => {
  const missingAll = { exports: {} } as unknown as WebAssembly.Instance;
  assertThrows(
    () => getCapnpWasmExports(missingAll),
    /missing wasm memory export: memory/i,
  );

  const missingAlloc = {
    exports: {
      memory: new WebAssembly.Memory({ initial: 1 }),
    },
  } as unknown as WebAssembly.Instance;
  assertThrows(
    () => getCapnpWasmExports(missingAlloc),
    /missing wasm export: capnp_alloc/i,
  );

  const fake = new FakeCapnpWasm({
    extraExports: {
      capnp_peer_pop_commit: 123,
    },
  });
  const invalidOptional = {
    exports: fake.exports as unknown as Record<string, unknown>,
  } as unknown as WebAssembly.Instance;
  assertThrows(
    () => getCapnpWasmExports(invalidOptional),
    /missing wasm export: capnp_peer_pop_commit/i,
  );
});

Deno.test("WasmAbi rejects invalid version/feature-flag export combinations", () => {
  const badRange = new FakeCapnpWasm({
    extraExports: {
      capnp_wasm_abi_version: undefined,
      capnp_wasm_abi_min_version: () => 3,
      capnp_wasm_abi_max_version: () => 2,
    },
  });
  assertThrows(
    () => new WasmAbi(badRange.exports),
    /invalid wasm ABI version range: 3\.\.2/i,
  );

  const partialFlags = new FakeCapnpWasm({
    extraExports: {
      capnp_wasm_feature_flags_lo: () => 1,
      capnp_wasm_feature_flags_hi: undefined,
    },
  });
  assertThrows(
    () => new WasmAbi(partialFlags.exports),
    /feature_flags_lo and capnp_wasm_feature_flags_hi must both be present/i,
  );
});

Deno.test("WasmAbi requireVersionExport enforces version exports", () => {
  const fake = new FakeCapnpWasm({
    extraExports: {
      capnp_wasm_abi_version: undefined,
      capnp_wasm_abi_min_version: undefined,
      capnp_wasm_abi_max_version: undefined,
    },
  });
  assertThrows(
    () =>
      new WasmAbi(fake.exports, {
        requireVersionExport: true,
      }),
    /missing capnp_wasm_abi_version export/i,
  );
});

Deno.test("WasmAbi surfaces unexpected capnp_error_take results", () => {
  const fake = new FakeCapnpWasm({
    extraExports: {
      capnp_error_take: () => 2,
    },
  });
  const abi = new WasmAbi(fake.exports);

  let thrown: unknown;
  try {
    abi.pushFrame(0xdead_beef, new Uint8Array([0x01]));
  } catch (error) {
    thrown = error;
  }

  if (!(thrown instanceof WasmAbiError)) {
    throw new Error(`expected WasmAbiError, got: ${String(thrown)}`);
  }
  assertEquals(
    /unexpected capnp_error_take result: 2/i.test(thrown.message),
    true,
  );
});

Deno.test("WasmAbi host-call/lifecycle/schema helpers fail cleanly when exports are unavailable", () => {
  const fake = new FakeCapnpWasm();
  const abi = new WasmAbi(fake.exports);

  assertEquals(abi.capabilities.hasHostCallBridge, false);
  assertEquals(abi.capabilities.hasLifecycleHelpers, false);
  assertEquals(abi.capabilities.hasSchemaManifest, false);

  assertThrows(
    () => abi.popHostCall(1),
    /missing wasm export: capnp_peer_pop_host_call/i,
  );
  assertThrows(
    () => abi.respondHostCallResults(1, 1, new Uint8Array()),
    /missing wasm export: capnp_peer_respond_host_call_results/i,
  );
  assertThrows(
    () => abi.respondHostCallException(1, 1, "boom"),
    /missing wasm export: capnp_peer_respond_host_call_exception/i,
  );
  assertThrows(
    () => abi.sendFinish(1, 1),
    /missing wasm export: capnp_peer_send_finish/i,
  );
  assertThrows(
    () => abi.sendRelease(1, 1, 1),
    /missing wasm export: capnp_peer_send_release/i,
  );
  assertThrows(
    () => abi.schemaManifestJson(),
    /missing wasm export: capnp_schema_manifest_json/i,
  );
});

Deno.test("WasmAbi supportsFeature validates bit ranges", () => {
  const fake = new FakeCapnpWasm({
    extraExports: {
      capnp_wasm_feature_flags_lo: () => 0,
      capnp_wasm_feature_flags_hi: () => 0,
    },
  });
  const abi = new WasmAbi(fake.exports);

  assertThrows(
    () => abi.supportsFeature(-1),
    /feature bit must be in \[0, 63\]/i,
  );
  assertThrows(
    () => abi.supportsFeature(64),
    /feature bit must be in \[0, 63\]/i,
  );
});
