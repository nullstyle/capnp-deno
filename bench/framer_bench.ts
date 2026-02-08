import { CapnpFrameFramer, validateCapnpFrame } from "../advanced.ts";

const WORD_BYTES = 8;

let blackhole = 0;

function consumeBytes(bytes: Uint8Array): void {
  blackhole ^= bytes.byteLength;
  if (bytes.byteLength > 0) {
    blackhole ^= bytes[0];
    blackhole ^= bytes[bytes.byteLength - 1];
  }
}

function buildSingleSegmentFrame(firstByte: number, words = 1): Uint8Array {
  const frame = new Uint8Array(8 + words * WORD_BYTES);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint32(0, 0, true);
  view.setUint32(4, words, true);
  frame[8] = firstByte & 0xff;
  return frame;
}

function concatFrames(frames: Uint8Array[]): Uint8Array {
  const total = frames.reduce((sum, frame) => sum + frame.byteLength, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const frame of frames) {
    out.set(frame, cursor);
    cursor += frame.byteLength;
  }
  return out;
}

function buildMessage(segments: Uint8Array[]): Uint8Array {
  const segmentCount = segments.length;
  const headerWords = 1 + segmentCount + (segmentCount % 2 === 0 ? 1 : 0);
  const headerBytes = headerWords * 4;
  const bodyBytes = segments.reduce(
    (sum, segment) => sum + segment.byteLength,
    0,
  );

  const out = new Uint8Array(headerBytes + bodyBytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, segmentCount - 1, true);
  for (let i = 0; i < segmentCount; i += 1) {
    view.setUint32(4 + i * 4, segments[i].byteLength / WORD_BYTES, true);
  }

  let cursor = headerBytes;
  for (const segment of segments) {
    out.set(segment, cursor);
    cursor += segment.byteLength;
  }
  return out;
}

function setWord(segment: Uint8Array, wordIndex: number, word: bigint): void {
  new DataView(segment.buffer, segment.byteOffset, segment.byteLength)
    .setBigUint64(wordIndex * WORD_BYTES, word, true);
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

function farPointerWord(
  targetSegmentId: number,
  landingPadWord: number,
  isDoubleFar: boolean,
): bigint {
  let word = 0x2n;
  if (isDoubleFar) word |= 0x1n << 2n;
  word |= BigInt(landingPadWord & 0x1fff_ffff) << 3n;
  word |= BigInt(targetSegmentId >>> 0) << 32n;
  return word;
}

function writeNonNullPointerChain(
  segment: Uint8Array,
  startWord: number,
  depth: number,
): void {
  for (let i = 0; i < depth; i += 1) {
    const pointerWord = startWord + i;
    const isLeaf = i === depth - 1;
    setWord(
      segment,
      pointerWord,
      structPointerWord(0, isLeaf ? 1 : 0, isLeaf ? 0 : 1),
    );
  }
}

function buildPointerChainFrame(depth: number): Uint8Array {
  const segment = new Uint8Array((depth + 1) * WORD_BYTES);
  writeNonNullPointerChain(segment, 0, depth);
  return buildMessage([segment]);
}

function buildSingleFarRootFrame(depth: number): Uint8Array {
  const segment0 = new Uint8Array(WORD_BYTES);
  setWord(segment0, 0, farPointerWord(1, 0, false));

  const segment1 = new Uint8Array((depth + 1) * WORD_BYTES);
  writeNonNullPointerChain(segment1, 0, depth);

  return buildMessage([segment0, segment1]);
}

function buildDoubleFarRootFrame(depth: number): Uint8Array {
  const segment0 = new Uint8Array(WORD_BYTES);
  setWord(segment0, 0, farPointerWord(1, 0, true));

  const segment1 = new Uint8Array(2 * WORD_BYTES);
  setWord(segment1, 0, farPointerWord(2, 0, false));
  setWord(segment1, 1, structPointerWord(0, 0, depth > 1 ? 1 : 0));

  const segment2 = new Uint8Array((depth + 1) * WORD_BYTES);
  if (depth > 1) {
    writeNonNullPointerChain(segment2, 1, depth - 1);
  }

  return buildMessage([segment0, segment1, segment2]);
}

const fragmentedFrame = buildSingleSegmentFrame(0x11);
const fragmentedHead = fragmentedFrame.subarray(0, 5);
const fragmentedTail = fragmentedFrame.subarray(5);

const coalescedFrameA = buildSingleSegmentFrame(0x22);
const coalescedFrameB = buildSingleSegmentFrame(0x33);
const coalescedTwoFrames = concatFrames([coalescedFrameA, coalescedFrameB]);

const limitsValidatedFrame = buildPointerChainFrame(4);
const deepPointerFrame = buildPointerChainFrame(64);
const singleFarFrame = buildSingleFarRootFrame(8);
const doubleFarFrame = buildDoubleFarRootFrame(8);

Deno.bench({
  name: "framer:fragmented_reassembly",
  group: "framer",
  baseline: true,
  n: 80_000,
  warmup: 2_000,
  fn() {
    const framer = new CapnpFrameFramer();
    framer.push(fragmentedHead);
    const partial = framer.popFrame();
    if (partial !== null) throw new Error("unexpected completed frame");
    framer.push(fragmentedTail);
    const out = framer.popFrame();
    if (!out) throw new Error("expected completed frame");
    consumeBytes(out);
  },
});

Deno.bench({
  name: "framer:coalesced_two_frame_split",
  group: "framer",
  n: 80_000,
  warmup: 2_000,
  fn() {
    const framer = new CapnpFrameFramer();
    framer.push(coalescedTwoFrames);
    const outA = framer.popFrame();
    const outB = framer.popFrame();
    if (!outA || !outB) throw new Error("expected two frames");
    consumeBytes(outA);
    consumeBytes(outB);
    if (framer.popFrame() !== null) {
      throw new Error("unexpected extra frame");
    }
  },
});

Deno.bench({
  name: "framer:with_limits_enabled",
  group: "framer",
  n: 40_000,
  warmup: 1_000,
  fn() {
    const framer = new CapnpFrameFramer({
      maxSegmentCount: 8,
      maxFrameBytes: 2048,
      maxBufferedBytes: 2048,
      maxTraversalWords: 128,
      maxNestingDepth: 4,
    });
    framer.push(limitsValidatedFrame);
    const out = framer.popFrame();
    if (!out) throw new Error("expected a frame");
    consumeBytes(out);
  },
});

Deno.bench({
  name: "frame_limits:validate_pointer_chain_depth",
  group: "frame_limits",
  baseline: true,
  n: 12_000,
  warmup: 500,
  fn() {
    validateCapnpFrame(deepPointerFrame, { maxNestingDepth: 64 });
    blackhole ^= 1;
  },
});

Deno.bench({
  name: "frame_limits:validate_single_far_root",
  group: "frame_limits",
  n: 12_000,
  warmup: 500,
  fn() {
    validateCapnpFrame(singleFarFrame, { maxNestingDepth: 8 });
    blackhole ^= 1;
  },
});

Deno.bench({
  name: "frame_limits:validate_double_far_root",
  group: "frame_limits",
  n: 12_000,
  warmup: 500,
  fn() {
    validateCapnpFrame(doubleFarFrame, { maxNestingDepth: 8 });
    blackhole ^= 1;
  },
});
