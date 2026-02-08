import { ProtocolError, validateCapnpFrame } from "../mod.ts";
import { assert, assertThrows } from "./test_utils.ts";

const WORD_BYTES = 8;

function buildMessage(segments: Uint8Array[]): Uint8Array {
  const segmentCount = segments.length;
  const headerWords = 1 + segmentCount + (segmentCount % 2 === 0 ? 1 : 0);
  const headerBytes = headerWords * 4;
  const bodyBytes = segments.reduce(
    (sum, segment) => sum + segment.byteLength,
    0,
  );

  const out = new Uint8Array(headerBytes + bodyBytes);
  const view = new DataView(out.buffer);
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

function listPointerWord(
  offsetWords: number,
  elementSize: number,
  elementCount: number,
): bigint {
  const signed = offsetWords < 0
    ? (offsetWords + (1 << 30)) & 0x3fff_ffff
    : offsetWords & 0x3fff_ffff;
  return 0x1n |
    (BigInt(signed) << 2n) |
    (BigInt(elementSize & 0x7) << 32n) |
    (BigInt(elementCount & 0x1fff_ffff) << 35n);
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
  if (depth < 1) throw new Error("depth must be >= 1");
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
  if (depth < 1) throw new Error("depth must be >= 1");
  const segment = new Uint8Array((depth + 1) * WORD_BYTES);
  writeNonNullPointerChain(segment, 0, depth);

  return buildMessage([segment]);
}

function buildSingleFarRootFrame(depth: number): Uint8Array {
  if (depth < 2) throw new Error("single-far test requires depth >= 2");
  const segment0 = new Uint8Array(WORD_BYTES);
  setWord(segment0, 0, farPointerWord(1, 0, false));

  const segment1 = new Uint8Array((depth + 1) * WORD_BYTES);
  writeNonNullPointerChain(segment1, 0, depth);

  return buildMessage([segment0, segment1]);
}

function buildDoubleFarRootFrame(depth: number): Uint8Array {
  if (depth < 2) throw new Error("double-far test requires depth >= 2");

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

Deno.test("validateCapnpFrame enforces maxTraversalWords", () => {
  const frame = buildPointerChainFrame(3);
  assertThrows(
    () => validateCapnpFrame(frame, { maxTraversalWords: 2 }),
    /traversal words .* exceeds configured limit/i,
  );
});

Deno.test("validateCapnpFrame enforces maxNestingDepth on pointer chains", () => {
  const frame = buildPointerChainFrame(3);
  assertThrows(
    () => validateCapnpFrame(frame, { maxNestingDepth: 2 }),
    /nesting depth .* exceeds configured limit/i,
  );
  validateCapnpFrame(frame, { maxNestingDepth: 3 });
});

Deno.test("validateCapnpFrame resolves single-far roots for depth checks", () => {
  const frame = buildSingleFarRootFrame(2);
  assertThrows(
    () => validateCapnpFrame(frame, { maxNestingDepth: 1 }),
    /nesting depth .* exceeds configured limit/i,
  );
  validateCapnpFrame(frame, { maxNestingDepth: 2 });
});

Deno.test("validateCapnpFrame resolves double-far roots for depth checks", () => {
  const frame = buildDoubleFarRootFrame(3);
  assertThrows(
    () => validateCapnpFrame(frame, { maxNestingDepth: 2 }),
    /nesting depth .* exceeds configured limit/i,
  );
  validateCapnpFrame(frame, { maxNestingDepth: 3 });
});

Deno.test("validateCapnpFrame rejects malformed double-far landing pads", () => {
  const segment0 = new Uint8Array(WORD_BYTES);
  setWord(segment0, 0, farPointerWord(1, 0, true));

  const segment1 = new Uint8Array(2 * WORD_BYTES);
  // pad[0] must be a single-far pointer; write a struct pointer to trigger error.
  setWord(segment1, 0, structPointerWord(0, 0, 0));
  setWord(segment1, 1, structPointerWord(0, 0, 0));

  const segment2 = new Uint8Array(WORD_BYTES);
  const frame = buildMessage([segment0, segment1, segment2]);

  let thrown: unknown;
  try {
    validateCapnpFrame(frame, { maxNestingDepth: 4 });
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof ProtocolError &&
      /double-far landing pad\[0\]/i.test(thrown.message),
    `expected malformed landing pad ProtocolError, got: ${String(thrown)}`,
  );
});

Deno.test("validateCapnpFrame supports deep pointer-chain stress cases", () => {
  const frame = buildPointerChainFrame(64);
  validateCapnpFrame(frame, { maxNestingDepth: 64 });
  assertThrows(
    () => validateCapnpFrame(frame, { maxNestingDepth: 63 }),
    /nesting depth .* exceeds configured limit/i,
  );
});

Deno.test("validateCapnpFrame rejects invalid limit option values", () => {
  const frame = buildPointerChainFrame(1);
  assertThrows(
    () => validateCapnpFrame(frame, { maxSegmentCount: -1 }),
    /maxSegmentCount must be a non-negative integer/i,
  );
  assertThrows(
    () => validateCapnpFrame(frame, { maxFrameBytes: -1 }),
    /maxFrameBytes must be a non-negative integer/i,
  );
  assertThrows(
    () => validateCapnpFrame(frame, { maxTraversalWords: -1 }),
    /maxTraversalWords must be a non-negative integer/i,
  );
  assertThrows(
    () => validateCapnpFrame(frame, { maxNestingDepth: -1 }),
    /maxNestingDepth must be a non-negative integer/i,
  );
});

Deno.test("validateCapnpFrame rejects short and truncated headers", () => {
  assertThrows(
    () => validateCapnpFrame(new Uint8Array([0x00, 0x00, 0x00])),
    /capnp frame is too short/i,
  );

  const truncatedHeader = new Uint8Array(8);
  const view = new DataView(truncatedHeader.buffer);
  view.setUint32(0, 2, true); // segment count = 3; header needs 16 bytes.
  view.setUint32(4, 1, true);
  assertThrows(
    () => validateCapnpFrame(truncatedHeader),
    /capnp frame header is truncated/i,
  );
});

Deno.test("validateCapnpFrame rejects truncated and trailing payloads", () => {
  const truncatedPayload = new Uint8Array(16);
  const truncatedView = new DataView(
    truncatedPayload.buffer,
    truncatedPayload.byteOffset,
    truncatedPayload.byteLength,
  );
  truncatedView.setUint32(0, 0, true); // one segment
  truncatedView.setUint32(4, 2, true); // two words declared (16 bytes payload)
  // actual payload is only 8 bytes due total frame size.
  assertThrows(
    () => validateCapnpFrame(truncatedPayload),
    /capnp frame payload is truncated/i,
  );

  const trailingPayload = new Uint8Array(24);
  const trailingView = new DataView(
    trailingPayload.buffer,
    trailingPayload.byteOffset,
    trailingPayload.byteLength,
  );
  trailingView.setUint32(0, 0, true); // one segment
  trailingView.setUint32(4, 1, true); // one word declared
  // actual payload has two words (8 trailing bytes).
  assertThrows(
    () => validateCapnpFrame(trailingPayload),
    /capnp frame has trailing bytes/i,
  );
});

Deno.test("validateCapnpFrame enforces maxSegmentCount and maxFrameBytes", () => {
  const frame = buildMessage([
    new Uint8Array(WORD_BYTES),
    new Uint8Array(WORD_BYTES),
  ]);

  assertThrows(
    () => validateCapnpFrame(frame, { maxSegmentCount: 1 }),
    /segment count .* exceeds configured limit/i,
  );
  assertThrows(
    () => validateCapnpFrame(frame, { maxFrameBytes: frame.byteLength - 1 }),
    /frame size .* exceeds configured limit/i,
  );
});

Deno.test("validateCapnpFrame rejects far-pointer chains that exceed hop limit", () => {
  const segment = new Uint8Array(WORD_BYTES);
  setWord(segment, 0, farPointerWord(0, 0, false)); // self-referential single-far
  const frame = buildMessage([segment]);

  assertThrows(
    () => validateCapnpFrame(frame, { maxNestingDepth: 4 }),
    /far pointer chain exceeded maximum hop count/i,
  );
});

Deno.test("validateCapnpFrame rejects double-far landing pad with nested far pointer", () => {
  const segment0 = new Uint8Array(WORD_BYTES);
  setWord(segment0, 0, farPointerWord(1, 0, true));

  const segment1 = new Uint8Array(2 * WORD_BYTES);
  setWord(segment1, 0, farPointerWord(2, 0, true)); // invalid: pad[0] must be single-far.
  setWord(segment1, 1, structPointerWord(0, 0, 0));

  const segment2 = new Uint8Array(WORD_BYTES);
  const frame = buildMessage([segment0, segment1, segment2]);

  assertThrows(
    () => validateCapnpFrame(frame, { maxNestingDepth: 4 }),
    /landing pad\[0\] must be a single-far pointer/i,
  );
});

Deno.test("validateCapnpFrame rejects malformed inline composite payload declarations", () => {
  const segment = new Uint8Array(2 * WORD_BYTES);
  setWord(segment, 0, listPointerWord(0, 7, 1));
  setWord(segment, 1, structPointerWord(2, 0, 1)); // requiredWords=2, declared elementCount=1
  const frame = buildMessage([segment]);

  assertThrows(
    () => validateCapnpFrame(frame, { maxNestingDepth: 4 }),
    /inline composite list payload exceeds declared word count/i,
  );
});

Deno.test("validateCapnpFrame rejects out-of-range struct and list targets", () => {
  const structSegment = new Uint8Array(2 * WORD_BYTES);
  setWord(structSegment, 0, structPointerWord(0, 1, 1)); // target requires 2 words starting at word 1
  const structFrame = buildMessage([structSegment]);
  assertThrows(
    () => validateCapnpFrame(structFrame, { maxNestingDepth: 4 }),
    /struct pointer target out of range/i,
  );

  const listSegment = new Uint8Array(2 * WORD_BYTES);
  setWord(listSegment, 0, listPointerWord(0, 5, 3)); // needs 3 words starting at word 1
  const listFrame = buildMessage([listSegment]);
  assertThrows(
    () => validateCapnpFrame(listFrame, { maxNestingDepth: 4 }),
    /list pointer target out of range/i,
  );
});
