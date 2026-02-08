import { ProtocolError } from "./errors.ts";

const WORD_BYTES = 8;
const POINTER_HOP_LIMIT = 8;
const MASK_29 = 0x1fff_ffffn;
const MASK_30 = 0x3fff_ffffn;

/**
 * Options for limiting the size and complexity of Cap'n Proto frames.
 *
 * These limits protect against excessively large or deeply nested messages
 * that could cause out-of-memory errors or stack overflows.
 */
export interface CapnpFrameLimitsOptions {
  /** Maximum number of segments allowed in a single frame. */
  maxSegmentCount?: number;
  /** Maximum total frame size in bytes (header + all segments). */
  maxFrameBytes?: number;
  /** Maximum total word count across all segments. */
  maxTraversalWords?: number;
  /** Maximum pointer nesting depth. When set, a full pointer tree walk is performed. */
  maxNestingDepth?: number;
}

interface ParsedCapnpFrame {
  readonly segments: Uint8Array[];
  readonly totalWords: number;
}

interface ResolvedPointer {
  readonly segmentId: number;
  readonly pointerWord: number;
  readonly word: bigint;
}

interface PointerState {
  readonly segmentId: number;
  readonly pointerWord: number;
  readonly depth: number;
}

function asSigned30(raw: bigint): number {
  const value = Number(raw & MASK_30);
  return (value & (1 << 29)) !== 0 ? value - (1 << 30) : value;
}

function assertNonNegativeInteger(
  value: number | undefined,
  name: string,
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new ProtocolError(`${name} must be a non-negative integer`);
  }
}

function wordsForFlatList(elementSize: number, elementCount: number): number {
  switch (elementSize) {
    case 0:
      return 0; // void list
    case 1:
      return Math.ceil(elementCount / 64); // bit list
    case 2:
      return Math.ceil(elementCount / WORD_BYTES); // byte list
    case 3:
      return Math.ceil(elementCount / 4); // two-byte list
    case 4:
      return Math.ceil(elementCount / 2); // four-byte list
    case 5:
      return elementCount; // eight-byte list
    case 6:
      return elementCount; // pointer list
    default:
      throw new ProtocolError(
        `invalid list pointer elementSize=${elementSize}`,
      );
  }
}

function requireWordRange(
  segments: Uint8Array[],
  segmentId: number,
  startWord: number,
  wordCount: number,
  context: string,
): void {
  const segment = segments[segmentId];
  if (!segment) {
    throw new ProtocolError(
      `${context} references missing segment ${segmentId}`,
    );
  }

  if (
    !Number.isInteger(startWord) ||
    !Number.isInteger(wordCount) ||
    startWord < 0 ||
    wordCount < 0
  ) {
    throw new ProtocolError(`${context} has invalid word bounds`);
  }

  const segmentWords = segment.byteLength / WORD_BYTES;
  if (startWord + wordCount > segmentWords) {
    throw new ProtocolError(
      `${context} out of range: segment=${segmentId} start=${startWord} words=${wordCount} segmentWords=${segmentWords}`,
    );
  }
}

function readWordAt(
  segments: Uint8Array[],
  segmentId: number,
  wordIndex: number,
  context: string,
): bigint {
  requireWordRange(segments, segmentId, wordIndex, 1, context);
  const segment = segments[segmentId];
  const byteOffset = wordIndex * WORD_BYTES;
  return new DataView(
    segment.buffer,
    segment.byteOffset,
    segment.byteLength,
  ).getBigUint64(byteOffset, true);
}

function resolvePointer(
  segments: Uint8Array[],
  segmentId: number,
  pointerWord: number,
): ResolvedPointer {
  let currentSegmentId = segmentId;
  let currentPointerWord = pointerWord;
  let word = readWordAt(
    segments,
    currentSegmentId,
    currentPointerWord,
    "pointer word",
  );

  for (let hop = 0; hop < POINTER_HOP_LIMIT; hop += 1) {
    const kind = Number(word & 0x3n);
    if (kind !== 2) {
      return {
        segmentId: currentSegmentId,
        pointerWord: currentPointerWord,
        word,
      };
    }

    const isDoubleFar = ((word >> 2n) & 0x1n) === 1n;
    const landingPadWord = Number((word >> 3n) & MASK_29);
    const landingSegmentId = Number((word >> 32n) & 0xffff_ffffn);

    if (!isDoubleFar) {
      currentSegmentId = landingSegmentId;
      currentPointerWord = landingPadWord;
      word = readWordAt(
        segments,
        currentSegmentId,
        currentPointerWord,
        "single-far landing pointer",
      );
      continue;
    }

    requireWordRange(
      segments,
      landingSegmentId,
      landingPadWord,
      2,
      "double-far landing pad",
    );

    const pad0 = readWordAt(
      segments,
      landingSegmentId,
      landingPadWord,
      "double-far landing pad[0]",
    );
    const pad0Kind = Number(pad0 & 0x3n);
    if (pad0Kind !== 2) {
      throw new ProtocolError(
        `double-far landing pad[0] must be far pointer, got kind=${pad0Kind}`,
      );
    }

    const pad0IsDoubleFar = ((pad0 >> 2n) & 0x1n) === 1n;
    if (pad0IsDoubleFar) {
      throw new ProtocolError(
        "double-far landing pad[0] must be a single-far pointer",
      );
    }

    currentSegmentId = Number((pad0 >> 32n) & 0xffff_ffffn);
    currentPointerWord = Number((pad0 >> 3n) & MASK_29);
    requireWordRange(
      segments,
      currentSegmentId,
      currentPointerWord,
      1,
      "double-far target pointer base",
    );

    word = readWordAt(
      segments,
      landingSegmentId,
      landingPadWord + 1,
      "double-far landing pad[1]",
    );
  }

  throw new ProtocolError("far pointer chain exceeded maximum hop count");
}

function parseFrame(
  frame: Uint8Array,
  limits: CapnpFrameLimitsOptions,
): ParsedCapnpFrame {
  if (frame.byteLength < 4) {
    throw new ProtocolError("capnp frame is too short");
  }

  assertNonNegativeInteger(limits.maxSegmentCount, "maxSegmentCount");
  assertNonNegativeInteger(limits.maxFrameBytes, "maxFrameBytes");
  assertNonNegativeInteger(limits.maxTraversalWords, "maxTraversalWords");
  assertNonNegativeInteger(limits.maxNestingDepth, "maxNestingDepth");

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const segmentCount = view.getUint32(0, true) + 1;
  const maxSegmentCount = limits.maxSegmentCount;
  if (maxSegmentCount !== undefined && segmentCount > maxSegmentCount) {
    throw new ProtocolError(
      `capnp frame segment count ${segmentCount} exceeds configured limit ${maxSegmentCount}`,
    );
  }

  const headerWords = 1 + segmentCount + (segmentCount % 2 === 0 ? 1 : 0);
  const headerBytes = headerWords * 4;
  if (frame.byteLength < headerBytes) {
    throw new ProtocolError("capnp frame header is truncated");
  }

  const segmentWords: number[] = [];
  let totalWords = 0;
  for (let i = 0; i < segmentCount; i += 1) {
    const words = view.getUint32(4 + i * 4, true);
    segmentWords.push(words);
    totalWords += words;
  }

  const maxTraversalWords = limits.maxTraversalWords;
  if (maxTraversalWords !== undefined && totalWords > maxTraversalWords) {
    throw new ProtocolError(
      `capnp frame traversal words ${totalWords} exceeds configured limit ${maxTraversalWords}`,
    );
  }

  const totalBytes = headerBytes + totalWords * WORD_BYTES;
  const maxFrameBytes = limits.maxFrameBytes;
  if (maxFrameBytes !== undefined && totalBytes > maxFrameBytes) {
    throw new ProtocolError(
      `capnp frame size ${totalBytes} exceeds configured limit ${maxFrameBytes}`,
    );
  }

  if (frame.byteLength < totalBytes) {
    throw new ProtocolError("capnp frame payload is truncated");
  }
  if (frame.byteLength > totalBytes) {
    throw new ProtocolError(
      `capnp frame has trailing bytes: declared=${totalBytes} actual=${frame.byteLength}`,
    );
  }

  const segments: Uint8Array[] = [];
  let cursor = headerBytes;
  for (const words of segmentWords) {
    const segmentBytes = words * WORD_BYTES;
    segments.push(frame.subarray(cursor, cursor + segmentBytes));
    cursor += segmentBytes;
  }

  return {
    segments,
    totalWords,
  };
}

function enforceNestingDepth(
  segments: Uint8Array[],
  maxDepth: number,
): void {
  if (segments.length === 0 || segments[0].byteLength < WORD_BYTES) {
    return;
  }

  const pending: PointerState[] = [{ segmentId: 0, pointerWord: 0, depth: 1 }];
  const seen = new Set<string>();

  while (pending.length > 0) {
    const state = pending.pop()!;
    const stateKey = `${state.segmentId}:${state.pointerWord}:${state.depth}`;
    if (seen.has(stateKey)) continue;
    seen.add(stateKey);

    const resolved = resolvePointer(
      segments,
      state.segmentId,
      state.pointerWord,
    );
    const word = resolved.word;
    if (word === 0n) continue;

    if (state.depth > maxDepth) {
      throw new ProtocolError(
        `capnp frame nesting depth ${state.depth} exceeds configured limit ${maxDepth}`,
      );
    }

    const kind = Number(word & 0x3n);
    if (kind === 3) {
      continue;
    }

    if (kind === 0) {
      const offsetWords = asSigned30((word >> 2n) & MASK_30);
      const dataWordCount = Number((word >> 32n) & 0xffffn);
      const pointerCount = Number((word >> 48n) & 0xffffn);
      const startWord = resolved.pointerWord + 1 + offsetWords;
      requireWordRange(
        segments,
        resolved.segmentId,
        startWord,
        dataWordCount + pointerCount,
        "struct pointer target",
      );

      const nextDepth = state.depth + 1;
      for (let i = 0; i < pointerCount; i += 1) {
        pending.push({
          segmentId: resolved.segmentId,
          pointerWord: startWord + dataWordCount + i,
          depth: nextDepth,
        });
      }
      continue;
    }

    if (kind !== 1) {
      throw new ProtocolError(`invalid pointer kind=${kind}`);
    }

    const offsetWords = asSigned30((word >> 2n) & MASK_30);
    const elementSize = Number((word >> 32n) & 0x7n);
    const elementCount = Number((word >> 35n) & 0x1fff_ffffn);
    const startWord = resolved.pointerWord + 1 + offsetWords;

    if (elementSize === 7) {
      requireWordRange(
        segments,
        resolved.segmentId,
        startWord,
        1,
        "inline composite list tag",
      );

      const tag = readWordAt(
        segments,
        resolved.segmentId,
        startWord,
        "inline composite list tag",
      );
      const tagKind = Number(tag & 0x3n);
      if (tagKind !== 0) {
        throw new ProtocolError(
          `invalid inline composite list tag kind=${tagKind}`,
        );
      }

      const inlineElementCount = Number((tag >> 2n) & MASK_30);
      const inlineDataWords = Number((tag >> 32n) & 0xffffn);
      const inlinePointerCount = Number((tag >> 48n) & 0xffffn);
      const strideWords = inlineDataWords + inlinePointerCount;
      const requiredWords = strideWords * inlineElementCount;
      if (requiredWords > elementCount) {
        throw new ProtocolError(
          "inline composite list payload exceeds declared word count",
        );
      }

      requireWordRange(
        segments,
        resolved.segmentId,
        startWord + 1,
        elementCount,
        "inline composite list payload",
      );

      if (inlinePointerCount > 0) {
        const nextDepth = state.depth + 1;
        for (
          let elementIndex = 0;
          elementIndex < inlineElementCount;
          elementIndex += 1
        ) {
          const elementStart = startWord + 1 + elementIndex * strideWords;
          const pointerStart = elementStart + inlineDataWords;
          for (
            let pointerIndex = 0;
            pointerIndex < inlinePointerCount;
            pointerIndex += 1
          ) {
            pending.push({
              segmentId: resolved.segmentId,
              pointerWord: pointerStart + pointerIndex,
              depth: nextDepth,
            });
          }
        }
      }
      continue;
    }

    const wordCount = wordsForFlatList(elementSize, elementCount);
    requireWordRange(
      segments,
      resolved.segmentId,
      startWord,
      wordCount,
      "list pointer target",
    );

    if (elementSize === 6) {
      const nextDepth = state.depth + 1;
      for (let i = 0; i < elementCount; i += 1) {
        pending.push({
          segmentId: resolved.segmentId,
          pointerWord: startWord + i,
          depth: nextDepth,
        });
      }
    }
  }
}

/**
 * Validates a Cap'n Proto frame against the provided size and complexity limits.
 *
 * Parses the frame header, checks segment counts and sizes, and optionally
 * walks the pointer tree to enforce a maximum nesting depth.
 *
 * @param frame - The complete Cap'n Proto frame bytes to validate.
 * @param limits - The limits to enforce. An empty object performs only basic structural validation.
 * @throws {ProtocolError} If any limit is exceeded or the frame is malformed.
 */
export function validateCapnpFrame(
  frame: Uint8Array,
  limits: CapnpFrameLimitsOptions = {},
): void {
  const parsed = parseFrame(frame, limits);
  if (limits.maxNestingDepth !== undefined) {
    enforceNestingDepth(parsed.segments, limits.maxNestingDepth);
  }

  const maxTraversalWords = limits.maxTraversalWords;
  if (
    maxTraversalWords !== undefined && parsed.totalWords > maxTraversalWords
  ) {
    throw new ProtocolError(
      `capnp frame traversal words ${parsed.totalWords} exceeds configured limit ${maxTraversalWords}`,
    );
  }
}
