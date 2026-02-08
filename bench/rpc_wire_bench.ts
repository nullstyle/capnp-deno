import {
  decodeBootstrapRequestFrame,
  decodeCallRequestFrame,
  decodeReturnFrame,
  encodeBootstrapRequestFrame,
  encodeCallRequestFrame,
  encodeReturnExceptionFrame,
  encodeReturnResultsFrame,
  type RpcCapDescriptor,
} from "../mod.ts";
import {
  BOOTSTRAP_Q1_SUCCESS_INBOUND,
  CALL_BOOTSTRAP_CAP_Q2_INBOUND,
  CALL_BOOTSTRAP_CAP_Q2_OUTBOUND,
} from "../tests/fixtures/rpc_frames.ts";

let blackhole = 0;

function consumeBytes(bytes: Uint8Array): void {
  blackhole ^= bytes.byteLength;
  if (bytes.byteLength > 0) {
    blackhole ^= bytes[0];
    blackhole ^= bytes[bytes.byteLength - 1];
  }
}

function consumeNumber(value: number): void {
  blackhole ^= value >>> 0;
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

const paramsContent = encodeSingleU32StructMessage(77);
const resultContent = encodeSingleU32StructMessage(88);
const capTable48: RpcCapDescriptor[] = Array.from(
  { length: 48 },
  (_v, i) => ({
    tag: i % 2 === 0 ? 1 : 3,
    id: 10_000 + i,
  }),
);

Deno.bench({
  name: "rpc_wire:encode_call_empty",
  group: "rpc_wire_encode",
  baseline: true,
  n: 80_000,
  warmup: 2_000,
  fn() {
    const frame = encodeCallRequestFrame({
      questionId: 2,
      interfaceId: 0x1234n,
      methodId: 9,
      targetImportedCap: 1,
    });
    consumeBytes(frame);
  },
});

Deno.bench({
  name: "rpc_wire:encode_call_with_cap_table_48",
  group: "rpc_wire_encode",
  n: 30_000,
  warmup: 1_000,
  fn() {
    const frame = encodeCallRequestFrame({
      questionId: 11,
      interfaceId: 0x1234n,
      methodId: 9,
      targetImportedCap: 3,
      paramsContent,
      paramsCapTable: capTable48,
    });
    consumeBytes(frame);
  },
});

Deno.bench({
  name: "rpc_wire:encode_bootstrap",
  group: "rpc_wire_encode",
  n: 80_000,
  warmup: 2_000,
  fn() {
    const frame = encodeBootstrapRequestFrame({ questionId: 1 });
    consumeBytes(frame);
  },
});

Deno.bench({
  name: "rpc_wire:decode_call_fixture",
  group: "rpc_wire_decode",
  baseline: true,
  n: 80_000,
  warmup: 2_000,
  fn() {
    const decoded = decodeCallRequestFrame(CALL_BOOTSTRAP_CAP_Q2_INBOUND);
    consumeNumber(decoded.questionId);
    consumeNumber(decoded.methodId);
    consumeNumber(decoded.targetImportedCap ?? 0);
  },
});

Deno.bench({
  name: "rpc_wire:decode_return_exception_fixture",
  group: "rpc_wire_decode",
  n: 80_000,
  warmup: 2_000,
  fn() {
    const decoded = decodeReturnFrame(CALL_BOOTSTRAP_CAP_Q2_OUTBOUND);
    consumeNumber(decoded.answerId);
  },
});

Deno.bench({
  name: "rpc_wire:decode_bootstrap_fixture",
  group: "rpc_wire_decode",
  n: 80_000,
  warmup: 2_000,
  fn() {
    const decoded = decodeBootstrapRequestFrame(BOOTSTRAP_Q1_SUCCESS_INBOUND);
    consumeNumber(decoded.questionId);
  },
});

Deno.bench({
  name: "rpc_wire:roundtrip_call_encode_decode",
  group: "rpc_wire_roundtrip",
  baseline: true,
  n: 40_000,
  warmup: 1_000,
  fn() {
    const encoded = encodeCallRequestFrame({
      questionId: 99,
      interfaceId: 0x1234n,
      methodId: 7,
      targetImportedCap: 5,
      paramsContent,
      paramsCapTable: capTable48,
    });
    const decoded = decodeCallRequestFrame(encoded);
    consumeNumber(decoded.questionId);
    consumeNumber(decoded.paramsCapTable.length);
  },
});

Deno.bench({
  name: "rpc_wire:roundtrip_return_results_encode_decode",
  group: "rpc_wire_roundtrip",
  n: 40_000,
  warmup: 1_000,
  fn() {
    const encoded = encodeReturnResultsFrame({
      answerId: 42,
      content: resultContent,
      capTable: capTable48,
    });
    const decoded = decodeReturnFrame(encoded);
    consumeNumber(decoded.answerId);
  },
});

Deno.bench({
  name: "rpc_wire:roundtrip_return_exception_encode_decode",
  group: "rpc_wire_roundtrip",
  n: 40_000,
  warmup: 1_000,
  fn() {
    const encoded = encodeReturnExceptionFrame({
      answerId: 42,
      reason: "benchmark exception",
    });
    const decoded = decodeReturnFrame(encoded);
    consumeNumber(decoded.answerId);
  },
});
