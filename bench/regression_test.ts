/**
 * Benchmark regression checks for critical hot-path operations.
 *
 * These are Deno tests (not Deno.bench) that enforce generous time budgets
 * on core operations. They are designed to catch severe performance
 * regressions (e.g. an O(n) path becoming O(n^2)) rather than micro-
 * optimisation drifts. The budgets are intentionally loose so they pass
 * reliably on CI runners whose performance varies.
 *
 * Run with:  deno test bench/regression_test.ts
 */

import { assert, assertEquals } from "../tests/test_utils.ts";
import {
  CapnpFrameFramer,
  decodeBootstrapRequestFrame,
  decodeCallRequestFrame,
  decodeReturnFrame,
  encodeBootstrapRequestFrame,
  encodeCallRequestFrame,
  encodeReturnExceptionFrame,
  encodeReturnResultsFrame,
  type RpcCapDescriptor,
  validateCapnpFrame,
} from "../mod.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORD_BYTES = 8;

function buildSingleSegmentFrame(firstByte: number, words = 1): Uint8Array {
  const frame = new Uint8Array(8 + words * WORD_BYTES);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint32(0, 0, true);
  view.setUint32(4, words, true);
  frame[8] = firstByte & 0xff;
  return frame;
}

function concatFrames(frames: Uint8Array[]): Uint8Array {
  const total = frames.reduce((sum, f) => sum + f.byteLength, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const f of frames) {
    out.set(f, cursor);
    cursor += f.byteLength;
  }
  return out;
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

function buildPointerChainFrame(depth: number): Uint8Array {
  const segment = new Uint8Array((depth + 1) * WORD_BYTES);
  for (let i = 0; i < depth; i += 1) {
    const isLeaf = i === depth - 1;
    const word = structPointerWord(0, isLeaf ? 1 : 0, isLeaf ? 0 : 1);
    new DataView(segment.buffer, segment.byteOffset, segment.byteLength)
      .setBigUint64(i * WORD_BYTES, word, true);
  }
  // Build message with 1 segment
  const segCount = 1;
  const headerWords = 1 + segCount + (segCount % 2 === 0 ? 1 : 0);
  const headerBytes = headerWords * 4;
  const out = new Uint8Array(headerBytes + segment.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, segCount - 1, true);
  view.setUint32(4, segment.byteLength / WORD_BYTES, true);
  out.set(segment, headerBytes);
  return out;
}

function structPointerWord(
  offsetWords: number,
  dataWords: number,
  pointerCount: number,
): bigint {
  const signed = offsetWords < 0
    ? (offsetWords + (1 << 30)) & 0x3fff_ffff
    : offsetWords & 0x3fff_ffff;
  return (BigInt(signed) << 2n) |
    (BigInt(dataWords & 0xffff) << 32n) |
    (BigInt(pointerCount & 0xffff) << 48n);
}

/**
 * Measure the wall-clock time for `iterations` calls of `fn`.
 * Returns elapsed milliseconds.
 */
function timedRun(fn: () => void, iterations: number): number {
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    fn();
  }
  return performance.now() - start;
}

// ---------------------------------------------------------------------------
// Regression tests with generous time budgets
// ---------------------------------------------------------------------------

Deno.test("regression: framer push/pop 10k iterations < 2000ms", () => {
  const frameA = buildSingleSegmentFrame(0x22);
  const frameB = buildSingleSegmentFrame(0x33);
  const coalesced = concatFrames([frameA, frameB]);

  const elapsed = timedRun(() => {
    const framer = new CapnpFrameFramer();
    framer.push(coalesced);
    const a = framer.popFrame();
    const b = framer.popFrame();
    assert(a !== null, "expected first frame");
    assert(b !== null, "expected second frame");
  }, 10_000);

  console.log(`  framer push/pop 10k: ${elapsed.toFixed(1)}ms`);
  assert(
    elapsed < 2000,
    `framer push/pop took ${elapsed.toFixed(1)}ms, budget is 2000ms`,
  );
});

Deno.test("regression: framer fragmented reassembly 10k iterations < 2000ms", () => {
  const frame = buildSingleSegmentFrame(0x11);
  const head = frame.subarray(0, 5);
  const tail = frame.subarray(5);

  const elapsed = timedRun(() => {
    const framer = new CapnpFrameFramer();
    framer.push(head);
    assertEquals(framer.popFrame(), null);
    framer.push(tail);
    const out = framer.popFrame();
    assert(out !== null, "expected completed frame");
  }, 10_000);

  console.log(`  framer fragmented 10k: ${elapsed.toFixed(1)}ms`);
  assert(
    elapsed < 2000,
    `framer fragmented reassembly took ${
      elapsed.toFixed(1)
    }ms, budget is 2000ms`,
  );
});

Deno.test("regression: validateCapnpFrame depth-64 chain 5k iterations < 3000ms", () => {
  const deepFrame = buildPointerChainFrame(64);

  const elapsed = timedRun(() => {
    validateCapnpFrame(deepFrame, { maxNestingDepth: 64 });
  }, 5_000);

  console.log(`  validateCapnpFrame depth-64 5k: ${elapsed.toFixed(1)}ms`);
  assert(
    elapsed < 3000,
    `validateCapnpFrame took ${elapsed.toFixed(1)}ms, budget is 3000ms`,
  );
});

Deno.test("regression: rpc wire encode call 10k iterations < 2000ms", () => {
  const elapsed = timedRun(() => {
    encodeCallRequestFrame({
      questionId: 2,
      interfaceId: 0x1234n,
      methodId: 9,
      targetImportedCap: 1,
    });
  }, 10_000);

  console.log(`  rpc_wire encode call 10k: ${elapsed.toFixed(1)}ms`);
  assert(
    elapsed < 2000,
    `rpc_wire encode call took ${elapsed.toFixed(1)}ms, budget is 2000ms`,
  );
});

Deno.test("regression: rpc wire encode call with 48-cap table 5k iterations < 3000ms", () => {
  const paramsContent = encodeSingleU32StructMessage(77);
  const capTable48: RpcCapDescriptor[] = Array.from(
    { length: 48 },
    (_v, i) => ({
      tag: i % 2 === 0 ? 1 : 3,
      id: 10_000 + i,
    }),
  );

  const elapsed = timedRun(() => {
    encodeCallRequestFrame({
      questionId: 11,
      interfaceId: 0x1234n,
      methodId: 9,
      targetImportedCap: 3,
      paramsContent,
      paramsCapTable: capTable48,
    });
  }, 5_000);

  console.log(`  rpc_wire encode call+cap48 5k: ${elapsed.toFixed(1)}ms`);
  assert(
    elapsed < 3000,
    `rpc_wire encode call+cap48 took ${elapsed.toFixed(1)}ms, budget is 3000ms`,
  );
});

Deno.test("regression: rpc wire decode call 10k iterations < 2000ms", () => {
  const frame = encodeCallRequestFrame({
    questionId: 99,
    interfaceId: 0x1234n,
    methodId: 7,
    targetImportedCap: 5,
    paramsContent: encodeSingleU32StructMessage(77),
  });

  const elapsed = timedRun(() => {
    decodeCallRequestFrame(frame);
  }, 10_000);

  console.log(`  rpc_wire decode call 10k: ${elapsed.toFixed(1)}ms`);
  assert(
    elapsed < 2000,
    `rpc_wire decode call took ${elapsed.toFixed(1)}ms, budget is 2000ms`,
  );
});

Deno.test("regression: rpc wire encode/decode bootstrap 10k iterations < 2000ms", () => {
  const elapsed = timedRun(() => {
    const frame = encodeBootstrapRequestFrame({ questionId: 1 });
    decodeBootstrapRequestFrame(frame);
  }, 10_000);

  console.log(`  rpc_wire bootstrap roundtrip 10k: ${elapsed.toFixed(1)}ms`);
  assert(
    elapsed < 2000,
    `rpc_wire bootstrap roundtrip took ${
      elapsed.toFixed(1)
    }ms, budget is 2000ms`,
  );
});

Deno.test("regression: rpc wire return results roundtrip 5k iterations < 3000ms", () => {
  const resultContent = encodeSingleU32StructMessage(88);
  const capTable48: RpcCapDescriptor[] = Array.from(
    { length: 48 },
    (_v, i) => ({
      tag: i % 2 === 0 ? 1 : 3,
      id: 10_000 + i,
    }),
  );

  const elapsed = timedRun(() => {
    const encoded = encodeReturnResultsFrame({
      answerId: 42,
      content: resultContent,
      capTable: capTable48,
    });
    decodeReturnFrame(encoded);
  }, 5_000);

  console.log(
    `  rpc_wire return results roundtrip 5k: ${elapsed.toFixed(1)}ms`,
  );
  assert(
    elapsed < 3000,
    `rpc_wire return results roundtrip took ${
      elapsed.toFixed(1)
    }ms, budget is 3000ms`,
  );
});

Deno.test("regression: rpc wire return exception roundtrip 10k iterations < 2000ms", () => {
  const elapsed = timedRun(() => {
    const encoded = encodeReturnExceptionFrame({
      answerId: 42,
      reason: "benchmark exception message for regression test",
    });
    decodeReturnFrame(encoded);
  }, 10_000);

  console.log(
    `  rpc_wire return exception roundtrip 10k: ${elapsed.toFixed(1)}ms`,
  );
  assert(
    elapsed < 2000,
    `rpc_wire return exception roundtrip took ${
      elapsed.toFixed(1)
    }ms, budget is 2000ms`,
  );
});
