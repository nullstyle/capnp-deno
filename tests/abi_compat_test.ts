import { WasmAbi } from "../mod.ts";
import { FakeCapnpWasm } from "./fake_wasm.ts";
import {
  assert,
  assertBytes,
  assertEquals,
  assertThrows,
} from "./test_utils.ts";

Deno.test("WasmAbi falls back cleanly for v1-only export shape", () => {
  const fake = new FakeCapnpWasm({
    extraExports: {
      capnp_peer_pop_commit: undefined,
      capnp_buf_free: undefined,
      capnp_wasm_abi_version: undefined,
    },
  });

  const abi = new WasmAbi(fake.exports);
  assertEquals(abi.capabilities.hasPeerPopCommit, false);
  assertEquals(abi.capabilities.hasBufFree, false);
  assertEquals(abi.capabilities.hasAbiVersion, false);
  assertEquals(abi.capabilities.hasAbiVersionRange, false);

  const peer = abi.createPeer();
  abi.pushFrame(peer, new Uint8Array([0xaa, 0xbb, 0xcc]));
  const out = abi.popOutFrame(peer);
  assert(out !== null, "expected outbound frame");
  assertBytes(out, [0xaa, 0xbb, 0xcc]);
  assertEquals(fake.commitCalls.length, 0, "commit hook should not be used");
});

Deno.test("WasmAbi detects version-range and feature-flag exports", () => {
  const fake = new FakeCapnpWasm({
    extraExports: {
      capnp_wasm_abi_version: undefined,
      capnp_wasm_abi_min_version: () => 1,
      capnp_wasm_abi_max_version: () => 3,
      capnp_wasm_feature_flags_lo: () => 0x0000_0005,
      capnp_wasm_feature_flags_hi: () => 0x0000_0002,
      capnp_error_take: () => 0,
    },
  });

  const abi = new WasmAbi(fake.exports, {
    expectedVersion: 2,
    requireVersionExport: true,
  });
  assertEquals(abi.capabilities.hasAbiVersion, false);
  assertEquals(abi.capabilities.hasAbiVersionRange, true);
  assertEquals(abi.capabilities.abiMinVersion, 1);
  assertEquals(abi.capabilities.abiMaxVersion, 3);
  assertEquals(abi.capabilities.hasFeatureFlags, true);
  assertEquals(abi.capabilities.featureFlags, 0x0000_0002_0000_0005n);
  assertEquals(abi.capabilities.hasErrorTake, true);

  assertEquals(abi.supportsFeature(0), true);
  assertEquals(abi.supportsFeature(1), false);
  assertEquals(abi.supportsFeature(2), true);
  assertEquals(abi.supportsFeature(33), true);
});

Deno.test("WasmAbi rejects unsupported negotiated version ranges", () => {
  const fake = new FakeCapnpWasm({
    extraExports: {
      capnp_wasm_abi_version: undefined,
      capnp_wasm_abi_min_version: () => 2,
      capnp_wasm_abi_max_version: () => 3,
    },
  });

  assertThrows(
    () =>
      new WasmAbi(fake.exports, {
        expectedVersion: 1,
        requireVersionExport: true,
      }),
    /supported range 2\.\.3/,
  );
});

Deno.test("WasmAbi rejects partial capability export pairs", () => {
  const fake = new FakeCapnpWasm({
    extraExports: {
      capnp_wasm_abi_min_version: () => 1,
      capnp_wasm_abi_max_version: undefined,
    },
  });

  assertThrows(
    () => new WasmAbi(fake.exports),
    /capnp_wasm_abi_min_version and capnp_wasm_abi_max_version must both be present/,
  );
});

Deno.test("WasmAbi uses capnp_error_take and frees taken error buffers", () => {
  const freed: Array<{ ptr: number; len: number }> = [];
  let takeCalls = 0;
  const fake = new FakeCapnpWasm({
    extraExports: {
      capnp_error_take: (
        outCodePtr: number,
        outMsgPtrPtr: number,
        outMsgLenPtr: number,
      ) => {
        takeCalls += 1;
        const message = new TextEncoder().encode("taken via capnp_error_take");
        const msgPtr = fake.allocBytes(message);
        fake.writeU32(outCodePtr, 777);
        fake.writeU32(outMsgPtrPtr, msgPtr);
        fake.writeU32(outMsgLenPtr, message.byteLength);
        return 1;
      },
      capnp_buf_free: (ptr: number, len: number) => {
        freed.push({ ptr, len });
      },
    },
  });

  const abi = new WasmAbi(fake.exports);
  assertThrows(
    () => abi.pushFrame(123_456, new Uint8Array([0x01])),
    /taken via capnp_error_take/,
  );
  assertEquals(takeCalls, 1);
  assertEquals(freed.length, 1);
  assert(freed[0].ptr > 0, "taken message pointer should be non-zero");
  assert(freed[0].len > 0, "taken message length should be non-zero");
});
