import {
  decodeCallRequestFrame,
  decodeReturnFrame,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  instantiatePeer,
  RpcSession,
  type RpcTransport,
  type WasmPeer,
} from "../../advanced.ts";
import {
  BOOTSTRAP_Q1_INBOUND,
  BOOTSTRAP_Q1_SUCCESS_INBOUND,
  CALL_BOOTSTRAP_CAP_Q2_INBOUND,
  CALL_UNKNOWN_CAP_Q2_INBOUND,
} from "../fixtures/rpc_frames.ts";
import { assert, assertEquals } from "../test_utils.ts";

const wasmPath = new URL(
  "../../generated/capnp_deno.wasm",
  import.meta.url,
);

class MockTransport implements RpcTransport {
  readonly sent: Uint8Array[] = [];
  #onFrame: ((frame: Uint8Array) => void | Promise<void>) | null = null;

  start(
    onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): void {
    this.#onFrame = onFrame;
  }

  send(frame: Uint8Array): void {
    this.sent.push(new Uint8Array(frame));
  }

  close(): void {}

  async emit(frame: Uint8Array): Promise<void> {
    if (!this.#onFrame) throw new Error("transport not started");
    await this.#onFrame(frame);
  }
}

async function withPeer(
  run: (instance: WebAssembly.Instance, peer: WasmPeer) => void | Promise<void>,
): Promise<void> {
  const { instance, peer } = await instantiatePeer(wasmPath, {}, {
    expectedVersion: 1,
    requireVersionExport: true,
  });
  try {
    await run(instance, peer);
  } finally {
    peer.close();
  }
}

function enableBootstrapStub(
  instance: WebAssembly.Instance,
  peer: WasmPeer,
): number {
  const raw = instance.exports as Record<string, unknown>;
  const withId = raw.capnp_peer_set_bootstrap_stub_with_id;
  if (typeof withId === "function") {
    const alloc = raw.capnp_alloc;
    const free = raw.capnp_free;
    const memory = raw.memory;
    if (
      typeof alloc !== "function" || typeof free !== "function" ||
      !(memory instanceof WebAssembly.Memory)
    ) {
      throw new Error("missing memory/alloc/free for bootstrap stub id helper");
    }
    const idPtr = (alloc as (len: number) => number)(4);
    if (idPtr === 0) {
      throw new Error("capnp_alloc failed for bootstrap stub id helper");
    }
    try {
      const view = new DataView(memory.buffer);
      view.setUint32(idPtr, 0, true);
      const ok = (withId as (handle: number, outExportIdPtr: number) => number)(
        peer.handle,
        idPtr,
      );
      if (ok !== 1) {
        const err = peer.abi.exports.capnp_last_error_code();
        const msg = err === 0
          ? "capnp_peer_set_bootstrap_stub_with_id failed"
          : `capnp_peer_set_bootstrap_stub_with_id failed with code=${err}`;
        throw new Error(msg);
      }
      return view.getUint32(idPtr, true);
    } finally {
      (free as (ptr: number, len: number) => void)(idPtr, 4);
    }
  }

  const fn = raw.capnp_peer_set_bootstrap_stub;
  if (typeof fn !== "function") {
    throw new Error("missing capnp_peer_set_bootstrap_stub export");
  }
  const ok = (fn as (handle: number) => number)(peer.handle);
  if (ok !== 1) {
    const err = peer.abi.exports.capnp_last_error_code();
    const msg = err === 0
      ? "capnp_peer_set_bootstrap_stub failed"
      : `capnp_peer_set_bootstrap_stub failed with code=${err}`;
    throw new Error(msg);
  }
  return 1;
}

function encodeSingleU32StructMessage(value: number): Uint8Array {
  const out = new Uint8Array(24);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, 0, true);
  view.setUint32(4, 2, true);
  view.setBigUint64(8, 0x0000_0001_0000_0000n, true);
  view.setUint32(16, value >>> 0, true);
  return out;
}

const MASK_30 = 0x3fff_ffffn;

function signed30(value: bigint): number {
  const raw = Number(value & MASK_30);
  return (raw & (1 << 29)) !== 0 ? raw - (1 << 30) : raw;
}

function decodeSingleU32StructMessage(frame: Uint8Array): number {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const root = view.getBigUint64(8, true);
  const offset = signed30((root >> 2n) & MASK_30);
  const dataWord = 1 + offset;
  return view.getUint32(8 + (dataWord * 8), true);
}

function assertUnknownCapabilityCall(
  peer: WasmPeer,
  capabilityIndex: number,
  questionId: number,
  callTemplate: {
    interfaceId: bigint;
    methodId: number;
    paramsContent: Uint8Array;
    paramsCapTable: Array<{ tag: number; id: number }>;
  },
): void {
  const { frames: outbound } = peer.pushFrame(
    encodeCallRequestFrame({
      questionId,
      interfaceId: callTemplate.interfaceId,
      methodId: callTemplate.methodId,
      targetImportedCap: capabilityIndex,
      paramsContent: callTemplate.paramsContent,
      paramsCapTable: callTemplate.paramsCapTable,
    }),
  );
  assertEquals(outbound.length, 1);
  const decoded = decodeReturnFrame(outbound[0]);
  assertEquals(decoded.kind, "exception");
  if (decoded.kind !== "exception") {
    throw new Error(`expected exception return, got: ${decoded.kind}`);
  }
  assertEquals(decoded.answerId, questionId);
  assert(
    /unknown capability/i.test(decoded.reason),
    `expected unknown capability exception, got: ${decoded.reason}`,
  );
}

Deno.test("real wasm peer bootstrap/call flow matches wire fixtures", async () => {
  await withPeer((_instance, peer) => {
    const { frames: bootstrapOutbound } = peer.pushFrame(BOOTSTRAP_Q1_INBOUND);
    assertEquals(bootstrapOutbound.length, 1);
    const bootstrap = decodeReturnFrame(bootstrapOutbound[0]);
    assertEquals(bootstrap.kind, "results");
    if (bootstrap.kind !== "results") {
      throw new Error(`expected results return, got: ${bootstrap.kind}`);
    }
    assertEquals(bootstrap.answerId, 1);
    assertEquals(bootstrap.capTable.length, 1);
    assertEquals(bootstrap.capTable[0].tag, 1);
    assertEquals(bootstrap.capTable[0].id, 0);
    assertEquals(bootstrap.noFinishNeeded, false);

    const { frames: callOutbound } = peer.pushFrame(
      CALL_UNKNOWN_CAP_Q2_INBOUND,
    );
    assertEquals(callOutbound.length, 1);
    const call = decodeReturnFrame(callOutbound[0]);
    assertEquals(call.kind, "exception");
    if (call.kind !== "exception") {
      throw new Error(`expected exception return, got: ${call.kind}`);
    }
    assertEquals(call.answerId, 2);
    assertEquals(call.reason, "unknown capability");

    assertEquals(peer.drainOutgoingFrames().frames.length, 0);
  });
});

Deno.test("real wasm peer successful bootstrap/call flow matches fixtures", async () => {
  await withPeer((instance, peer) => {
    const bootstrapStubExportId = enableBootstrapStub(instance, peer);

    const { frames: bootstrapOutbound } = peer.pushFrame(
      BOOTSTRAP_Q1_SUCCESS_INBOUND,
    );
    assertEquals(bootstrapOutbound.length, 1);
    const bootstrap = decodeReturnFrame(bootstrapOutbound[0]);
    assertEquals(bootstrap.kind, "results");
    if (bootstrap.kind !== "results") {
      throw new Error(`expected results return, got: ${bootstrap.kind}`);
    }
    assertEquals(bootstrap.answerId, 1);
    assertEquals(bootstrap.capTable.length, 1);
    assertEquals(bootstrap.capTable[0].tag, 1);
    assertEquals(bootstrap.capTable[0].id, bootstrapStubExportId);

    const { frames: callOutbound } = peer.pushFrame(
      CALL_BOOTSTRAP_CAP_Q2_INBOUND,
    );
    assertEquals(callOutbound.length, 1);
    const call = decodeReturnFrame(callOutbound[0]);
    assertEquals(call.kind, "exception");
    if (call.kind !== "exception") {
      throw new Error(`expected exception return, got: ${call.kind}`);
    }
    assertEquals(call.answerId, 2);
    assertEquals(call.reason, "bootstrap stub");
    assertEquals(peer.abi.popHostCall(peer.handle), null);
  });
});

Deno.test("RpcSession pumps real wasm peer using successful bootstrap fixture", async () => {
  await withPeer(async (instance, peer) => {
    const bootstrapStubExportId = enableBootstrapStub(instance, peer);

    const transport = new MockTransport();
    const session = new RpcSession(peer, transport);

    try {
      await session.start();
      await transport.emit(BOOTSTRAP_Q1_SUCCESS_INBOUND);
      await session.flush();

      assertEquals(transport.sent.length, 1);
      const bootstrap = decodeReturnFrame(transport.sent[0]);
      assertEquals(bootstrap.kind, "results");
      if (bootstrap.kind !== "results") {
        throw new Error(`expected results return, got: ${bootstrap.kind}`);
      }
      assertEquals(bootstrap.answerId, 1);
      assertEquals(bootstrap.capTable.length, 1);
      assertEquals(bootstrap.capTable[0].tag, 1);
      assertEquals(bootstrap.capTable[0].id, bootstrapStubExportId);
    } finally {
      await session.close();
    }
  });
});

Deno.test("real wasm rpc lifecycle: finish retires returned caps and release frames are accepted", async () => {
  await withPeer((instance, peer) => {
    const bootstrapStubExportId = enableBootstrapStub(instance, peer);
    const fixtureCall = decodeCallRequestFrame(CALL_BOOTSTRAP_CAP_Q2_INBOUND);
    const callTemplate = {
      interfaceId: fixtureCall.interfaceId,
      methodId: fixtureCall.methodId,
      paramsContent: fixtureCall.paramsContent,
      paramsCapTable: fixtureCall.paramsCapTable,
    };

    const { frames: bootstrapOutbound } = peer.pushFrame(
      BOOTSTRAP_Q1_SUCCESS_INBOUND,
    );
    assertEquals(bootstrapOutbound.length, 1);
    const bootstrap = decodeReturnFrame(bootstrapOutbound[0]);
    assertEquals(bootstrap.kind, "results");
    if (bootstrap.kind !== "results") {
      throw new Error(`expected results return, got: ${bootstrap.kind}`);
    }
    assertEquals(bootstrap.answerId, 1);
    assertEquals(bootstrap.capTable.length, 1);
    const bootstrapCapId = bootstrap.capTable[0].id;
    assertEquals(bootstrapCapId, bootstrapStubExportId);

    const hostBridgeCall = encodeCallRequestFrame({
      questionId: 2,
      interfaceId: callTemplate.interfaceId,
      methodId: callTemplate.methodId,
      targetImportedCap: 0,
      paramsContent: callTemplate.paramsContent,
      paramsCapTable: callTemplate.paramsCapTable,
    });
    const { frames: callOutbound } = peer.pushFrame(hostBridgeCall);
    assertEquals(callOutbound.length, 0);

    const hostCall = peer.abi.popHostCall(peer.handle);
    assert(hostCall !== null, "expected host call bridge record");
    assertEquals(hostCall.questionId, 2);
    const responsePayload = encodeSingleU32StructMessage(808);
    peer.abi.respondHostCallResults(
      peer.handle,
      hostCall.questionId,
      responsePayload,
    );
    const { frames: postResponseFrames } = peer.drainOutgoingFrames();
    assertEquals(postResponseFrames.length, 1);
    const postResponse = decodeReturnFrame(postResponseFrames[0]);
    assertEquals(postResponse.kind, "results");
    if (postResponse.kind !== "results") {
      throw new Error(`expected results return, got: ${postResponse.kind}`);
    }
    assertEquals(postResponse.answerId, 2);
    assertEquals(
      decodeSingleU32StructMessage(postResponse.contentBytes),
      808,
    );
    const returnedCapIds = postResponse.capTable.map((entry) => entry.id);

    const { frames: finishOutbound } = peer.pushFrame(
      encodeFinishFrame({
        questionId: 2,
        releaseResultCaps: true,
      }),
    );
    assertEquals(finishOutbound.length, 0);

    if (returnedCapIds.length > 0) {
      let questionId = 3;
      for (const capId of returnedCapIds) {
        assertUnknownCapabilityCall(peer, capId, questionId, callTemplate);
        questionId += 1;
      }
    }

    for (const capId of returnedCapIds) {
      const { frames: releaseReturned } = peer.pushFrame(
        encodeReleaseFrame({ id: capId, referenceCount: 1 }),
      );
      assertEquals(releaseReturned.length, 0);
    }

    const { frames: releaseOutbound } = peer.pushFrame(
      encodeReleaseFrame({ id: bootstrapCapId, referenceCount: 1 }),
    );
    assertEquals(releaseOutbound.length, 0);
    assertEquals(peer.drainOutgoingFrames().frames.length, 0);
  });
});
