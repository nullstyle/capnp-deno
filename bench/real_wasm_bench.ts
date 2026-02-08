import {
  decodeReturnFrame,
  encodeCallRequestFrame,
  instantiatePeer,
  type JsonSerdeCodec,
  type WasmPeer,
  WasmSerde,
} from "../mod.ts";

type Person = {
  name: string;
  age: number;
  email: string;
};

interface RealWasmRuntime {
  peer: WasmPeer;
  personCodec: JsonSerdeCodec<Person>;
}

const wasmPath = new URL("../.artifacts/capnp_deno.wasm", import.meta.url);

let blackhole = 0;

async function canReadWasm(path: URL): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
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
  const personCodec = serde.createJsonCodec<Person>({
    toJsonExport: "capnp_example_person_to_json",
    fromJsonExport: "capnp_example_person_from_json",
  });

  runtime = {
    peer,
    personCodec,
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

    const outbound = runtime.peer.pushFrame(frame);
    if (outbound.length !== 1) {
      throw new Error("expected single outbound return frame");
    }
    const decoded = decodeReturnFrame(outbound[0]);
    blackhole ^= decoded.answerId;
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
