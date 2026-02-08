import {
  decodeCallRequestFrame,
  decodeReturnFrame,
  encodeBootstrapRequestFrame,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  instantiatePeer,
  type JsonSerdeCodec,
  type WasmPeer,
  WasmSerde,
} from "../advanced.ts";
import { CALL_BOOTSTRAP_CAP_Q2_INBOUND } from "../tests/fixtures/rpc_frames.ts";

type Person = {
  name: string;
  age: number;
  email: string;
};

interface RealWasmRuntime {
  peer: WasmPeer;
  personCodec: JsonSerdeCodec<Person>;
  bootstrapStubExportId: number;
}

const wasmPath = new URL("../generated/capnp_deno.wasm", import.meta.url);

let blackhole = 0;

async function canReadWasm(path: URL): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
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

const hasRealWasm = await canReadWasm(wasmPath);
let runtime: RealWasmRuntime | null = null;

if (hasRealWasm) {
  const { instance, peer } = await instantiatePeer(wasmPath, {}, {
    expectedVersion: 1,
    requireVersionExport: true,
  });
  const serde = WasmSerde.fromInstance(instance, {
    expectedVersion: 1,
    requireVersionExport: true,
  });
  const bootstrapStubExportId = enableBootstrapStub(instance, peer);
  const personCodec = serde.createJsonCodec<Person>({
    toJsonExport: "capnp_example_person_to_json",
    fromJsonExport: "capnp_example_person_from_json",
  });

  runtime = {
    peer,
    personCodec,
    bootstrapStubExportId,
  };

  addEventListener("unload", () => {
    peer.close();
  });
}

const personValue: Person = {
  name: "Alice",
  age: 42,
  email: "alice@example.com",
};

const personBytes = runtime ? runtime.personCodec.encode(personValue) : null;
const callFixture = decodeCallRequestFrame(CALL_BOOTSTRAP_CAP_Q2_INBOUND);

interface LifecycleFrames {
  bootstrapQuestionId: number;
  callQuestionId: number;
  bootstrapFrame: Uint8Array;
  bootstrapFinishFrame: Uint8Array;
  callFrame: Uint8Array;
  callFinishFrame: Uint8Array;
}

function createLifecycleFrames(count: number): LifecycleFrames[] {
  return Array.from({ length: count }, (_v, i) => {
    const base = i * 2;
    const bootstrapQuestionId = base + 1;
    const callQuestionId = base + 2;
    return {
      bootstrapQuestionId,
      callQuestionId,
      bootstrapFrame: encodeBootstrapRequestFrame({
        questionId: bootstrapQuestionId,
      }),
      bootstrapFinishFrame: encodeFinishFrame({
        questionId: bootstrapQuestionId,
        releaseResultCaps: false,
      }),
      callFrame: encodeCallRequestFrame({
        questionId: callQuestionId,
        interfaceId: callFixture.interfaceId,
        methodId: callFixture.methodId,
        targetImportedCap: 0,
        paramsContent: callFixture.paramsContent,
        paramsCapTable: callFixture.paramsCapTable,
      }),
      callFinishFrame: encodeFinishFrame({
        questionId: callQuestionId,
        releaseResultCaps: true,
      }),
    };
  });
}

const unknownCapFrames = Array.from(
  { length: 1024 },
  (_v, i) =>
    encodeCallRequestFrame({
      questionId: i + 1,
      interfaceId: 0x1234n,
      methodId: 9,
      targetImportedCap: 999,
    }),
);
let unknownCapCursor = 0;
const successfulLifecycleFrames = createLifecycleFrames(1024);
let successfulLifecycleCursor = 0;
const lifecycleResponsePayload = new Uint8Array(24);
{
  const view = new DataView(
    lifecycleResponsePayload.buffer,
    lifecycleResponsePayload.byteOffset,
    lifecycleResponsePayload.byteLength,
  );
  view.setUint32(0, 0, true);
  view.setUint32(4, 2, true);
  view.setBigUint64(8, 0x0000_0001_0000_0000n, true);
  view.setUint32(16, 808, true);
}
Deno.bench({
  name: "real_wasm:peer_unknown_cap_call",
  group: "real_wasm_peer",
  baseline: true,
  ignore: runtime === null,
  n: 3_000,
  warmup: 120,
  fn() {
    if (!runtime) return;

    const frame = unknownCapFrames[unknownCapCursor];
    unknownCapCursor = (unknownCapCursor + 1) % unknownCapFrames.length;

    const { frames: outbound } = runtime.peer.pushFrame(frame);
    if (outbound.length !== 1) {
      throw new Error("expected single outbound return frame");
    }
    const decoded = decodeReturnFrame(outbound[0]);
    blackhole ^= decoded.answerId;
  },
});

Deno.bench({
  name: "real_wasm:rpc_successful_lifecycle",
  group: "real_wasm_rpc",
  baseline: true,
  ignore: runtime === null,
  n: 1_500,
  warmup: 80,
  fn() {
    if (!runtime) return;

    const frameSet = successfulLifecycleFrames[successfulLifecycleCursor];
    successfulLifecycleCursor = (successfulLifecycleCursor + 1) %
      successfulLifecycleFrames.length;

    const { frames: bootstrapOutbound } = runtime.peer.pushFrame(
      frameSet.bootstrapFrame,
    );
    if (bootstrapOutbound.length !== 1) {
      throw new Error("expected single bootstrap return frame");
    }
    const bootstrap = decodeReturnFrame(bootstrapOutbound[0]);
    if (bootstrap.kind !== "results") {
      throw new Error("expected bootstrap results return");
    }
    if (bootstrap.answerId !== frameSet.bootstrapQuestionId) {
      throw new Error("bootstrap answer id mismatch");
    }
    if (bootstrap.capTable.length === 0) {
      throw new Error("expected bootstrap capability");
    }
    const bootstrapCapId = bootstrap.capTable[0].id;
    if (bootstrapCapId !== runtime.bootstrapStubExportId) {
      throw new Error("unexpected bootstrap capability id");
    }

    const { frames: callOutbound } = runtime.peer.pushFrame(frameSet.callFrame);
    if (callOutbound.length !== 0) {
      throw new Error("expected host-call bridge to buffer outbound response");
    }

    const hostCall = runtime.peer.abi.popHostCall(runtime.peer.handle);
    if (!hostCall) {
      throw new Error("expected host call bridge record");
    }
    runtime.peer.abi.respondHostCallResults(
      runtime.peer.handle,
      hostCall.questionId,
      lifecycleResponsePayload,
    );

    const { frames: postResponseFrames } = runtime.peer.drainOutgoingFrames();
    if (postResponseFrames.length !== 1) {
      throw new Error("expected single host-call response frame");
    }
    const postResponse = decodeReturnFrame(postResponseFrames[0]);
    if (postResponse.kind !== "results") {
      throw new Error("expected call results return");
    }
    if (postResponse.answerId !== frameSet.callQuestionId) {
      throw new Error("call answer id mismatch");
    }

    const { frames: finishCall } = runtime.peer.pushFrame(
      frameSet.callFinishFrame,
    );
    if (finishCall.length !== 0) {
      throw new Error("expected no outbound frames for call finish");
    }
    const { frames: finishBootstrap } = runtime.peer.pushFrame(
      frameSet.bootstrapFinishFrame,
    );
    if (finishBootstrap.length !== 0) {
      throw new Error("expected no outbound frames for bootstrap finish");
    }
    const { frames: releaseBootstrap } = runtime.peer.pushFrame(
      encodeReleaseFrame({
        id: bootstrapCapId,
        referenceCount: 1,
      }),
    );
    if (releaseBootstrap.length !== 0) {
      throw new Error("expected no outbound frames for bootstrap release");
    }
    if (runtime.peer.drainOutgoingFrames().frames.length !== 0) {
      throw new Error("unexpected residual outbound frames");
    }

    blackhole ^= postResponse.answerId;
    blackhole ^= bootstrapCapId;
    blackhole ^= postResponse.capTable.length;
  },
});

Deno.bench({
  name: "real_wasm:serde_encode_person",
  group: "real_wasm_serde",
  baseline: true,
  ignore: runtime === null,
  n: 8_000,
  warmup: 200,
  fn() {
    if (!runtime) return;
    const bytes = runtime.personCodec.encode(personValue);
    blackhole ^= bytes.byteLength;
  },
});

Deno.bench({
  name: "real_wasm:serde_decode_person",
  group: "real_wasm_serde",
  ignore: runtime === null || personBytes === null,
  n: 8_000,
  warmup: 200,
  fn() {
    if (!runtime || !personBytes) return;
    const person = runtime.personCodec.decode(personBytes);
    blackhole ^= person.age;
  },
});
