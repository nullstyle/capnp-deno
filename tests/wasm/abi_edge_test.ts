import {
  getCapnpWasmExports,
  WasmAbi,
  WasmAbiError,
} from "../../src/advanced.ts";
import { FakeCapnpWasm } from "../fake_wasm.ts";
import { assert, assertEquals, assertThrows } from "../test_utils.ts";

function asInstance(exports: unknown): WebAssembly.Instance {
  return {
    exports: exports as WebAssembly.Exports,
  } as unknown as WebAssembly.Instance;
}

Deno.test("WasmAbi/getCapnpWasmExports accepts optional function exports and validates u32 metadata", () => {
  const fake = new FakeCapnpWasm({
    extraExports: {
      capnp_peer_pop_commit: () => {},
      capnp_peer_pop_host_call: () => 0,
      capnp_peer_respond_host_call_results: () => 1,
      capnp_peer_respond_host_call_exception: () => 1,
      capnp_peer_free_host_call_frame: () => 1,
      capnp_peer_send_finish: () => 1,
      capnp_peer_send_release: () => 1,
      capnp_peer_set_bootstrap_stub: () => 1,
      capnp_peer_set_bootstrap_stub_with_id: () => 1,
      capnp_schema_manifest_json: () => 1,
      capnp_buf_free: () => {},
      capnp_wasm_abi_min_version: () => 1,
      capnp_wasm_abi_max_version: () => 1,
      capnp_wasm_feature_flags_lo: () => 1,
      capnp_wasm_feature_flags_hi: () => 0,
      capnp_error_take: () => 0,
    },
  });

  const wasmExports = getCapnpWasmExports(asInstance(fake.exports));
  assert(typeof wasmExports.capnp_peer_pop_commit === "function");
  assert(typeof wasmExports.capnp_peer_pop_host_call === "function");
  assert(
    typeof wasmExports.capnp_peer_respond_host_call_results === "function",
  );
  assert(
    typeof wasmExports.capnp_peer_respond_host_call_exception === "function",
  );
  assert(typeof wasmExports.capnp_peer_free_host_call_frame === "function");
  assert(typeof wasmExports.capnp_peer_send_finish === "function");
  assert(typeof wasmExports.capnp_peer_send_release === "function");
  assert(typeof wasmExports.capnp_peer_set_bootstrap_stub === "function");
  assert(
    typeof wasmExports.capnp_peer_set_bootstrap_stub_with_id === "function",
  );
  assert(typeof wasmExports.capnp_schema_manifest_json === "function");
  assert(typeof wasmExports.capnp_buf_free === "function");
  assert(typeof wasmExports.capnp_wasm_abi_min_version === "function");
  assert(typeof wasmExports.capnp_wasm_abi_max_version === "function");
  assert(typeof wasmExports.capnp_wasm_feature_flags_lo === "function");
  assert(typeof wasmExports.capnp_wasm_feature_flags_hi === "function");
  assert(typeof wasmExports.capnp_error_take === "function");

  const badVersion = new FakeCapnpWasm({
    extraExports: {
      capnp_wasm_abi_version: () => -1,
    },
  });
  assertThrows(
    () => new WasmAbi(badVersion.exports),
    /capnp_wasm_abi_version must return a u32/i,
  );

  const badFeatureHi = new FakeCapnpWasm({
    extraExports: {
      capnp_wasm_feature_flags_lo: () => 0,
      capnp_wasm_feature_flags_hi: () => 0x1_0000_0000,
    },
  });
  assertThrows(
    () => new WasmAbi(badFeatureHi.exports),
    /capnp_wasm_feature_flags_hi must return a u32/i,
  );
});

Deno.test("WasmAbi createPeer/popOutFrame surfaces peer creation and pop-result errors", () => {
  const peerCreateFails = new FakeCapnpWasm({
    extraExports: {
      capnp_peer_new: () => 0,
    },
  });
  const createAbi = new WasmAbi(peerCreateFails.exports);
  assertThrows(
    () => createAbi.createPeer(),
    /capnp_peer_new failed/i,
  );

  const popUnexpected = new FakeCapnpWasm({
    extraExports: {
      capnp_peer_pop_out_frame: () => 2,
    },
  });
  const popAbi = new WasmAbi(popUnexpected.exports);
  assertThrows(
    () => popAbi.popOutFrame(1),
    /unexpected capnp_peer_pop_out_frame result: 2/i,
  );
});

Deno.test("WasmAbi popOutFrame surfaces commit errors and outbound bounds failures", () => {
  const fake = new FakeCapnpWasm({
    extraExports: {
      capnp_peer_pop_commit: () => {
        fake.failWithError(811, "commit failed");
      },
    },
  });

  const abi = new WasmAbi(fake.exports);
  const peer = abi.createPeer();
  abi.pushFrame(peer, new Uint8Array([0xaa]));
  assertThrows(
    () => abi.popOutFrame(peer),
    /commit failed/i,
  );

  const badBounds = new FakeCapnpWasm({
    extraExports: {
      capnp_peer_pop_out_frame: (
        _peer: number,
        outPtrPtr: number,
        outLenPtr: number,
      ) => {
        const memLen = badBounds.memory.buffer.byteLength;
        badBounds.writeU32(outPtrPtr, memLen - 4);
        badBounds.writeU32(outLenPtr, 32);
        return 1;
      },
    },
  });
  const badBoundsAbi = new WasmAbi(badBounds.exports);
  assertThrows(
    () => badBoundsAbi.popOutFrame(1),
    /invalid outbound frame bounds/i,
  );
});

Deno.test("WasmAbi host-call helper lifecycle covers missing, unexpected, and failing paths", () => {
  const missing = new WasmAbi(new FakeCapnpWasm().exports);
  missing.freeHostCallFrame(1, 123, 4);

  const unexpectedCall = new FakeCapnpWasm({
    extraExports: {
      capnp_peer_pop_host_call: () => 2,
      capnp_peer_respond_host_call_results: () => 1,
      capnp_peer_respond_host_call_exception: () => 1,
    },
  });
  const unexpectedAbi = new WasmAbi(unexpectedCall.exports);
  assertThrows(
    () => unexpectedAbi.popHostCall(1),
    /unexpected capnp_peer_pop_host_call result: 2/i,
  );

  const frameFreeFail = new FakeCapnpWasm({
    extraExports: {
      capnp_peer_free_host_call_frame: () => 0,
    },
  });
  const frameFreeAbi = new WasmAbi(frameFreeFail.exports);
  assertThrows(
    () => frameFreeAbi.freeHostCallFrame(1, 1, 1),
    /capnp_peer_free_host_call_frame failed/i,
  );
});

Deno.test("WasmAbi respondHostCallResults/Exception cover success and failure behavior", () => {
  const resultsFail = new FakeCapnpWasm({
    extraExports: {
      capnp_peer_respond_host_call_results: () => 0,
    },
  });
  const resultsFailAbi = new WasmAbi(resultsFail.exports);
  assertThrows(
    () => resultsFailAbi.respondHostCallResults(1, 7, new Uint8Array([1])),
    /capnp_peer_respond_host_call_results failed/i,
  );

  let seenReason = "";
  let reasonLen = 0;
  const exceptionOk = new FakeCapnpWasm({
    extraExports: {
      capnp_peer_respond_host_call_exception: (
        _peer: number,
        _questionId: number,
        reasonPtr: number,
        len: number,
      ) => {
        reasonLen = len;
        seenReason = exceptionOk.decode(exceptionOk.readBytes(reasonPtr, len));
        return 1;
      },
    },
  });
  const exceptionOkAbi = new WasmAbi(exceptionOk.exports);
  exceptionOkAbi.respondHostCallException(
    1,
    8,
    new Uint8Array([0x62, 0x6f, 0x6f, 0x6d]),
  );
  assertEquals(reasonLen, 4);
  assertEquals(seenReason, "boom");

  const exceptionFail = new FakeCapnpWasm({
    extraExports: {
      capnp_peer_respond_host_call_exception: () => 0,
    },
  });
  const exceptionFailAbi = new WasmAbi(exceptionFail.exports);
  assertThrows(
    () => exceptionFailAbi.respondHostCallException(1, 9, "nope"),
    /capnp_peer_respond_host_call_exception failed/i,
  );
});

Deno.test("WasmAbi sendFinish/sendRelease cover defaults, validation, and failure paths", () => {
  const finishCalls: Array<{
    releaseResultCaps: number;
    requireEarlyCancellation: number;
  }> = [];
  const ok = new FakeCapnpWasm({
    extraExports: {
      capnp_peer_send_finish: (
        _peer: number,
        _questionId: number,
        releaseResultCaps: number,
        requireEarlyCancellation: number,
      ) => {
        finishCalls.push({ releaseResultCaps, requireEarlyCancellation });
        return 1;
      },
      capnp_peer_send_release: () => 1,
    },
  });
  const okAbi = new WasmAbi(ok.exports);
  okAbi.sendFinish(1, 10);
  assertEquals(finishCalls.length, 1);
  assertEquals(finishCalls[0].releaseResultCaps, 1);
  assertEquals(finishCalls[0].requireEarlyCancellation, 0);
  assertThrows(
    () => okAbi.sendRelease(1, -1, 1),
    /capId must be a u32/i,
  );

  const finishFail = new FakeCapnpWasm({
    extraExports: {
      capnp_peer_send_finish: () => 0,
      capnp_peer_send_release: () => 1,
    },
  });
  const finishFailAbi = new WasmAbi(finishFail.exports);
  assertThrows(
    () => finishFailAbi.sendFinish(1, 11),
    /capnp_peer_send_finish failed/i,
  );

  const releaseFail = new FakeCapnpWasm({
    extraExports: {
      capnp_peer_send_finish: () => 1,
      capnp_peer_send_release: () => 0,
    },
  });
  const releaseFailAbi = new WasmAbi(releaseFail.exports);
  assertThrows(
    () => releaseFailAbi.sendRelease(1, 1, 1),
    /capnp_peer_send_release failed/i,
  );
});

Deno.test("WasmAbi schema helpers and allocation/error-take fallbacks cover edge branches", () => {
  let bufFreeCalls = 0;
  const fake = new FakeCapnpWasm({
    extraExports: {
      capnp_schema_manifest_json: (outPtrPtr: number, outLenPtr: number) => {
        fake.writeU32(outPtrPtr, 0);
        fake.writeU32(outLenPtr, 0);
        return 1;
      },
      capnp_buf_free: () => {
        bufFreeCalls += 1;
      },
    },
  });
  const abi = new WasmAbi(fake.exports);
  assertEquals(abi.schemaManifestJson(), "");
  assertEquals(bufFreeCalls, 0);

  const schemaFail = new FakeCapnpWasm({
    extraExports: {
      capnp_schema_manifest_json: () => 0,
    },
  });
  const schemaFailAbi = new WasmAbi(schemaFail.exports);
  assertThrows(
    () => schemaFailAbi.schemaManifestJson(),
    /capnp_schema_manifest_json failed/i,
  );

  const allocFail = new FakeCapnpWasm({
    extraExports: {
      capnp_alloc: () => 0,
    },
  });
  const allocFailAbi = new WasmAbi(allocFail.exports);
  assertThrows(
    () => allocFailAbi.pushFrame(1, new Uint8Array([1])),
    /capnp_alloc failed for 1 bytes/i,
  );

  const errorTakeScratchFail = new FakeCapnpWasm({
    extraExports: {
      capnp_error_take: () => 0,
      capnp_alloc: (len: number) => (len === 12 ? 0 : 1024),
    },
  });
  const scratchAbi = new WasmAbi(errorTakeScratchFail.exports);
  assertEquals(scratchAbi.capabilities.hasErrorTake, false);

  const errorTakeEmptyMessage = new FakeCapnpWasm({
    extraExports: {
      capnp_error_take: (
        outCodePtr: number,
        outMsgPtrPtr: number,
        outMsgLenPtr: number,
      ) => {
        errorTakeEmptyMessage.writeU32(outCodePtr, 777);
        errorTakeEmptyMessage.writeU32(outMsgPtrPtr, 0);
        errorTakeEmptyMessage.writeU32(outMsgLenPtr, 0);
        return 1;
      },
      capnp_peer_push_frame: () => 0,
    },
  });
  const emptyMsgAbi = new WasmAbi(errorTakeEmptyMessage.exports);
  let thrown: unknown;
  try {
    emptyMsgAbi.pushFrame(1, new Uint8Array([1]));
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof WasmAbiError &&
      /WASM error code 777/.test(thrown.message),
    `expected fallback message from empty error_take payload, got: ${
      String(thrown)
    }`,
  );
});

Deno.test("WasmAbi memory view cache invalidates correctly after buffer detachment from memory growth", () => {
  // This test verifies the memory caching optimization:
  // When WASM memory grows, the old ArrayBuffer detaches and a new one
  // is allocated. The cached Uint8Array/DataView must be invalidated.
  const fake = new FakeCapnpWasm();
  const abi = new WasmAbi(fake.exports);

  // Write data through the ABI and read it back to exercise the cache
  const peer = abi.createPeer();
  abi.pushFrame(peer, new Uint8Array([0xAA, 0xBB]));
  const frame = abi.popOutFrame(peer);
  assert(frame !== null, "expected frame after pushFrame");
  assertEquals(frame![0], 0xAA);
  assertEquals(frame![1], 0xBB);

  // Capture the current buffer identity
  const bufferBefore = fake.memory.buffer;

  // Grow memory -- this detaches the old ArrayBuffer
  fake.memory.grow(1);

  // Verify the buffer is now a different object
  const bufferAfter = fake.memory.buffer;
  assert(
    bufferBefore !== bufferAfter,
    "memory.grow should produce a new ArrayBuffer",
  );

  // Verify detachment: the old buffer should have byteLength === 0
  assertEquals(bufferBefore.byteLength, 0);

  // The ABI should still work correctly after detachment because the
  // cache invalidates on buffer identity change
  abi.pushFrame(peer, new Uint8Array([0xCC, 0xDD]));
  const frame2 = abi.popOutFrame(peer);
  assert(frame2 !== null, "expected frame after memory growth");
  assertEquals(frame2![0], 0xCC);
  assertEquals(frame2![1], 0xDD);

  abi.freePeer(peer);
});
