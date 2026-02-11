import { createRuntimePeer } from "../../src/rpc/server/runtime_module.ts";
import { assertEquals, assertThrows } from "../test_utils.ts";

Deno.test("createRuntimePeer loads bundled runtime exports", () => {
  const peer = createRuntimePeer();
  try {
    assertEquals(peer.abi.capabilities.abiVersion, 1);
    assertEquals(peer.closed, false);
  } finally {
    peer.close();
  }
});

Deno.test("createRuntimePeer forwards expectedVersion negotiation", () => {
  assertThrows(
    () => {
      const peer = createRuntimePeer({ expectedVersion: 99 });
      peer.close();
    },
    /capnp_wasm_abi_version mismatch: expected 99, got 1/,
  );
});
