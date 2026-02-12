import { WasmAbi } from "../../src/advanced.ts";
import { FakeCapnpWasm } from "../fake_wasm.ts";
import {
  assert,
  assertBytes,
  assertEquals,
  assertThrows,
} from "../test_utils.ts";

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
  assertEquals(abi.capabilities.hasHostCallBridge, false);
  assertEquals(abi.capabilities.hasLifecycleHelpers, false);
  assertEquals(abi.capabilities.hasSchemaManifest, false);
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
  assertEquals(abi.capabilities.hasHostCallBridge, false);
  assertEquals(abi.capabilities.hasLifecycleHelpers, false);
  assertEquals(abi.capabilities.hasSchemaManifest, false);

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

Deno.test("WasmAbi host-call and lifecycle wrappers route through optional exports", () => {
  const hostCalls: Array<{
    questionId: number;
    interfaceId: bigint;
    methodId: number;
    frame: Uint8Array;
  }> = [
    {
      questionId: 42,
      interfaceId: 0x1234n,
      methodId: 9,
      frame: new Uint8Array([0xaa, 0xbb, 0xcc]),
    },
  ];
  const seenResults: Array<{ questionId: number; payload: Uint8Array }> = [];
  const seenExceptions: Array<{ questionId: number; reason: string }> = [];
  const seenFreedHostFrames: Array<{ ptr: number; len: number }> = [];
  const seenFinish: Array<{
    questionId: number;
    releaseResultCaps: number;
    requireEarlyCancellation: number;
  }> = [];
  const seenRelease: Array<{ capId: number; referenceCount: number }> = [];
  let manifestFreed = false;

  const fake = new FakeCapnpWasm({
    extraExports: {
      capnp_peer_pop_host_call: (
        _peer: number,
        outQuestionIdPtr: number,
        outInterfaceIdPtr: number,
        outMethodIdPtr: number,
        outFramePtrPtr: number,
        outFrameLenPtr: number,
      ) => {
        const next = hostCalls.shift();
        if (!next) return 0;
        fake.writeU32(outQuestionIdPtr, next.questionId);
        const view = new DataView(fake.memory.buffer);
        view.setBigUint64(outInterfaceIdPtr, next.interfaceId, true);
        view.setUint16(outMethodIdPtr, next.methodId, true);
        const framePtr = fake.allocBytes(next.frame);
        fake.writeU32(outFramePtrPtr, framePtr);
        fake.writeU32(outFrameLenPtr, next.frame.byteLength);
        return 1;
      },
      capnp_peer_respond_host_call_results: (
        _peer: number,
        questionId: number,
        payloadPtr: number,
        payloadLen: number,
      ) => {
        seenResults.push({
          questionId,
          payload: fake.readBytes(payloadPtr, payloadLen),
        });
        return 1;
      },
      capnp_peer_respond_host_call_exception: (
        _peer: number,
        questionId: number,
        reasonPtr: number,
        reasonLen: number,
      ) => {
        seenExceptions.push({
          questionId,
          reason: fake.decode(fake.readBytes(reasonPtr, reasonLen)),
        });
        return 1;
      },
      capnp_peer_free_host_call_frame: (
        _peer: number,
        framePtr: number,
        frameLen: number,
      ) => {
        seenFreedHostFrames.push({ ptr: framePtr, len: frameLen });
        return 1;
      },
      capnp_peer_send_finish: (
        _peer: number,
        questionId: number,
        releaseResultCaps: number,
        requireEarlyCancellation: number,
      ) => {
        seenFinish.push({
          questionId,
          releaseResultCaps,
          requireEarlyCancellation,
        });
        return 1;
      },
      capnp_peer_send_release: (
        _peer: number,
        capId: number,
        referenceCount: number,
      ) => {
        seenRelease.push({ capId, referenceCount });
        return 1;
      },
      capnp_schema_manifest_json: (outPtrPtr: number, outLenPtr: number) => {
        const manifest = new TextEncoder().encode(
          '{"schema":"demo.capnp","serde":[]}',
        );
        const ptr = fake.allocBytes(manifest);
        fake.writeU32(outPtrPtr, ptr);
        fake.writeU32(outLenPtr, manifest.byteLength);
        return 1;
      },
      capnp_buf_free: (_ptr: number, _len: number) => {
        manifestFreed = true;
      },
    },
  });

  const abi = new WasmAbi(fake.exports);
  assertEquals(abi.capabilities.hasHostCallBridge, true);
  assertEquals(abi.capabilities.hasHostCallReturnFrame, false);
  assertEquals(abi.capabilities.hasHostCallFrameRelease, true);
  assertEquals(abi.capabilities.hasLifecycleHelpers, true);
  assertEquals(abi.capabilities.hasSchemaManifest, true);

  const hostCall = abi.popHostCall(1);
  assert(hostCall !== null, "expected host call");
  assertEquals(hostCall.questionId, 42);
  assertEquals(hostCall.interfaceId, 0x1234n);
  assertEquals(hostCall.methodId, 9);
  assertBytes(hostCall.frame, [0xaa, 0xbb, 0xcc]);
  assertEquals(seenFreedHostFrames.length, 1);
  assertEquals(seenFreedHostFrames[0].len, 3);
  assertEquals(abi.popHostCall(1), null);

  abi.respondHostCallResults(1, 42, new Uint8Array([0x01, 0x02, 0x03]));
  assertEquals(seenResults.length, 1);
  assertEquals(seenResults[0].questionId, 42);
  assertBytes(seenResults[0].payload, [0x01, 0x02, 0x03]);

  abi.respondHostCallException(1, 43, "boom");
  assertEquals(seenExceptions.length, 1);
  assertEquals(seenExceptions[0].questionId, 43);
  assertEquals(seenExceptions[0].reason, "boom");

  abi.sendFinish(1, 50, {
    releaseResultCaps: false,
    requireEarlyCancellation: true,
  });
  assertEquals(seenFinish.length, 1);
  assertEquals(seenFinish[0].questionId, 50);
  assertEquals(seenFinish[0].releaseResultCaps, 0);
  assertEquals(seenFinish[0].requireEarlyCancellation, 1);

  abi.sendRelease(1, 7, 3);
  assertEquals(seenRelease.length, 1);
  assertEquals(seenRelease[0].capId, 7);
  assertEquals(seenRelease[0].referenceCount, 3);

  const manifest = abi.schemaManifestJson();
  assertEquals(manifest, '{"schema":"demo.capnp","serde":[]}');
  assertEquals(manifestFreed, true);
});

Deno.test("WasmAbi detects and uses optional host-call return-frame export", () => {
  const seenReturnFrames: Uint8Array[] = [];
  const fake = new FakeCapnpWasm({
    extraExports: {
      capnp_peer_pop_host_call: () => 0,
      capnp_peer_respond_host_call_results: undefined,
      capnp_peer_respond_host_call_return_frame: (
        _peer: number,
        framePtr: number,
        frameLen: number,
      ) => {
        seenReturnFrames.push(fake.readBytes(framePtr, frameLen));
        return 1;
      },
      capnp_peer_respond_host_call_exception: () => 1,
    },
  });

  const abi = new WasmAbi(fake.exports);
  assertEquals(abi.capabilities.hasHostCallBridge, true);
  assertEquals(abi.capabilities.hasHostCallReturnFrame, true);

  abi.respondHostCallReturnFrame(1, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  assertEquals(seenReturnFrames.length, 1);
  assertBytes(seenReturnFrames[0], [0xde, 0xad, 0xbe, 0xef]);
});
