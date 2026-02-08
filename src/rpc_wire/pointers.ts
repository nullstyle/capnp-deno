/**
 * Pointer resolution and decoding for Cap'n Proto struct, list, and far
 * pointers within a {@link SegmentTable}.
 *
 * @module
 */

import { ProtocolError } from "../errors.ts";
import type {
  ByteListRef,
  PointerLocation,
  ResolvedPointer,
  SegmentTable,
  StructListRef,
  StructRef,
} from "./types.ts";
import {
  EMPTY_STRUCT_MESSAGE,
  FAR_POINTER_HOP_LIMIT,
  MASK_29,
  MASK_30,
  POINTER_OFFSET_MASK,
  WORD_BYTES,
} from "./types.ts";
import {
  encodeSigned30,
  ensureRange,
  ensureSegmentRange,
  frameFromSegment,
  readWordFromTable,
  signed30,
} from "./segments.ts";

// ---------------------------------------------------------------------------
// Far pointer resolution
// ---------------------------------------------------------------------------

export function resolvePointer(
  table: SegmentTable,
  segmentId: number,
  pointerWord: number,
): ResolvedPointer {
  let curSegment = segmentId;
  let curWord = pointerWord;
  let word = readWordFromTable(table, curSegment, curWord, "resolvePointer");

  for (let hop = 0; hop < FAR_POINTER_HOP_LIMIT; hop += 1) {
    const kind = Number(word & 0x3n);
    if (kind !== 2) {
      return { segmentId: curSegment, pointerWord: curWord, word };
    }

    const isDoubleFar = ((word >> 2n) & 0x1n) === 1n;
    const landingPadWord = Number((word >> 3n) & MASK_29);
    const landingSegmentId = Number((word >> 32n) & 0xffff_ffffn);

    if (!isDoubleFar) {
      // Single-far: the landing pad is an ordinary (non-far) pointer in the
      // target segment. Its offset field is relative to the landing pad word.
      curSegment = landingSegmentId;
      curWord = landingPadWord;
      word = readWordFromTable(
        table,
        curSegment,
        curWord,
        "single-far landing pointer",
      );
      continue;
    }

    // Double-far: two words in the landing segment.
    // pad[0] is a far pointer to the actual data (segment + offset).
    // pad[1] is a tag word (struct or list pointer with offset=0).
    ensureSegmentRange(
      table,
      landingSegmentId,
      landingPadWord * WORD_BYTES,
      2 * WORD_BYTES,
      "double-far landing pad",
    );

    const pad0 = readWordFromTable(
      table,
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

    const targetSegment = Number((pad0 >> 32n) & 0xffff_ffffn);
    const targetWord = Number((pad0 >> 3n) & MASK_29);
    ensureSegmentRange(
      table,
      targetSegment,
      targetWord * WORD_BYTES,
      WORD_BYTES,
      "double-far target word",
    );

    const tagWord = readWordFromTable(
      table,
      landingSegmentId,
      landingPadWord + 1,
      "double-far landing pad[1]",
    );

    // The tag word is a struct/list pointer whose offset field is
    // interpreted as 0 (relative to targetWord). We synthesize a
    // ResolvedPointer where `pointerWord` is (targetWord - 1) so
    // that the standard `pointerWord + 1 + offset` arithmetic
    // resolves to `targetWord` (since offset in the tag is 0).
    return {
      segmentId: targetSegment,
      pointerWord: targetWord - 1,
      word: tagWord,
    };
  }

  throw new ProtocolError("far pointer chain exceeded maximum hop count");
}

// ---------------------------------------------------------------------------
// Pointer word manipulation
// ---------------------------------------------------------------------------

export function rebasePointerWord(
  pointerWord: bigint,
  fromPointerWord: number,
  toPointerWord: number,
  context: string,
): bigint {
  if (pointerWord === 0n) return 0n;
  const kind = Number(pointerWord & 0x3n);
  if (kind === 0 || kind === 1) {
    const offset = signed30((pointerWord >> 2n) & MASK_30);
    const targetWord = fromPointerWord + 1 + offset;
    const rebasedOffset = targetWord - (toPointerWord + 1);
    return (pointerWord & ~POINTER_OFFSET_MASK) |
      (encodeSigned30(rebasedOffset) << 2n);
  }
  if (kind === 2) {
    throw new ProtocolError(`${context} does not support far pointers yet`);
  }
  return pointerWord;
}

export function rebaseCopiedRootPointer(
  sourceRootPointer: bigint,
  copiedStartWord: number,
  destinationPointerWord: number,
  context: string,
): bigint {
  if (sourceRootPointer === 0n) return 0n;
  const kind = Number(sourceRootPointer & 0x3n);
  if (kind === 0 || kind === 1) {
    const sourceOffset = signed30((sourceRootPointer >> 2n) & MASK_30);
    const sourceTargetWord = 1 + sourceOffset;
    const destinationTargetWord = copiedStartWord + sourceTargetWord;
    const destinationOffset = destinationTargetWord -
      (destinationPointerWord + 1);
    return (sourceRootPointer & ~POINTER_OFFSET_MASK) |
      (encodeSigned30(destinationOffset) << 2n);
  }
  if (kind === 2) {
    throw new ProtocolError(`${context} does not support far pointers yet`);
  }
  return sourceRootPointer;
}

// ---------------------------------------------------------------------------
// Struct / list pointer word index helpers
// ---------------------------------------------------------------------------

export function pointerWordIndex(
  structRef: StructRef,
  pointerOffset: number,
): PointerLocation {
  if (pointerOffset < 0 || pointerOffset >= structRef.pointerCount) {
    throw new ProtocolError(`pointer offset out of range: ${pointerOffset}`);
  }
  return {
    segmentId: structRef.segmentId,
    wordIndex: structRef.startWord + structRef.dataWordCount + pointerOffset,
  };
}

// ---------------------------------------------------------------------------
// Pointer decoders
// ---------------------------------------------------------------------------

export function decodeStructPointer(
  table: SegmentTable,
  loc: PointerLocation,
): StructRef | null {
  const resolved = resolvePointer(table, loc.segmentId, loc.wordIndex);
  if (resolved.word === 0n) return null;
  const kind = Number(resolved.word & 0x3n);
  if (kind !== 0) {
    throw new ProtocolError(`expected struct pointer, got kind=${kind}`);
  }
  const offsetWords = signed30((resolved.word >> 2n) & MASK_30);
  const dataWordCount = Number((resolved.word >> 32n) & 0xffffn);
  const pointerCount = Number((resolved.word >> 48n) & 0xffffn);
  const startWord = resolved.pointerWord + 1 + offsetWords;
  const words = dataWordCount + pointerCount;
  const seg = table.segments[resolved.segmentId];
  if (
    !seg || startWord < 0 || (startWord + words) * WORD_BYTES > seg.byteLength
  ) {
    throw new ProtocolError("struct pointer target out of range");
  }
  return {
    segmentId: resolved.segmentId,
    startWord,
    dataWordCount,
    pointerCount,
  };
}

export function decodeByteListPointer(
  table: SegmentTable,
  loc: PointerLocation,
): ByteListRef | null {
  const resolved = resolvePointer(table, loc.segmentId, loc.wordIndex);
  if (resolved.word === 0n) return null;
  const kind = Number(resolved.word & 0x3n);
  if (kind !== 1) {
    throw new ProtocolError(`expected list pointer, got kind=${kind}`);
  }
  const offsetWords = signed30((resolved.word >> 2n) & MASK_30);
  const elementSize = Number((resolved.word >> 32n) & 0x7n);
  const elementCount = Number((resolved.word >> 35n) & 0x1fff_ffffn);
  if (elementSize !== 2) {
    throw new ProtocolError(
      `expected byte list element size, got ${elementSize}`,
    );
  }
  const startWord = resolved.pointerWord + 1 + offsetWords;
  const wordCount = Math.ceil(elementCount / WORD_BYTES);
  const seg = table.segments[resolved.segmentId];
  if (
    !seg || startWord < 0 ||
    (startWord + wordCount) * WORD_BYTES > seg.byteLength
  ) {
    throw new ProtocolError("byte list pointer target out of range");
  }
  return {
    segmentId: resolved.segmentId,
    startWord,
    elementCount,
  };
}

export function decodeStructListPointer(
  table: SegmentTable,
  loc: PointerLocation,
): StructListRef | null {
  const resolved = resolvePointer(table, loc.segmentId, loc.wordIndex);
  if (resolved.word === 0n) return null;
  const kind = Number(resolved.word & 0x3n);
  if (kind !== 1) {
    throw new ProtocolError(`expected list pointer, got kind=${kind}`);
  }
  const offsetWords = signed30((resolved.word >> 2n) & MASK_30);
  const elementSize = Number((resolved.word >> 32n) & 0x7n);
  if (elementSize !== 7) {
    throw new ProtocolError(
      `expected inline composite list pointer, got elementSize=${elementSize}`,
    );
  }
  const tagWord = resolved.pointerWord + 1 + offsetWords;
  const tag = readWordFromTable(
    table,
    resolved.segmentId,
    tagWord,
    "inline composite tag",
  );
  const tagKind = Number(tag & 0x3n);
  if (tagKind !== 0) {
    throw new ProtocolError(`invalid inline composite tag kind=${tagKind}`);
  }
  const elementCount = Number((tag >> 2n) & MASK_30);
  const dataWordCount = Number((tag >> 32n) & 0xffffn);
  const pointerCount = Number((tag >> 48n) & 0xffffn);
  return {
    segmentId: resolved.segmentId,
    elementsStartWord: tagWord + 1,
    elementCount,
    dataWordCount,
    pointerCount,
  };
}

// ---------------------------------------------------------------------------
// Deep-copy flattener
// ---------------------------------------------------------------------------

/**
 * Growable word buffer used by the deep-copy flattener to build a single
 * contiguous segment from potentially multi-segment pointer content.
 */
class WordBuffer {
  private bytes: Uint8Array;
  private _words: number;
  #view: DataView;

  constructor(initialWords: number) {
    this._words = initialWords;
    this.bytes = new Uint8Array(initialWords * WORD_BYTES);
    this.#view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    );
  }

  get words(): number {
    return this._words;
  }

  allocWords(count: number): number {
    const start = this._words;
    this._words += count;
    this.ensureCapacity(this._words * WORD_BYTES);
    return start;
  }

  writeWord(wordIndex: number, value: bigint): void {
    this.#view.setBigUint64(wordIndex * WORD_BYTES, value, true);
  }

  copyFromSegment(
    dstWord: number,
    src: Uint8Array,
    srcWordOffset: number,
    wordCount: number,
  ): void {
    const srcStart = srcWordOffset * WORD_BYTES;
    const dstStart = dstWord * WORD_BYTES;
    this.bytes.set(
      src.subarray(srcStart, srcStart + wordCount * WORD_BYTES),
      dstStart,
    );
  }

  toUint8Array(): Uint8Array {
    return this.bytes.subarray(0, this._words * WORD_BYTES);
  }

  private ensureCapacity(requiredBytes: number): void {
    if (requiredBytes <= this.bytes.byteLength) return;
    let next = this.bytes.byteLength;
    while (next < requiredBytes) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.bytes);
    this.bytes = grown;
    this.#view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    );
  }
}

/**
 * Compute the number of words a list pointer's data occupies, given the
 * element size code and element count from the pointer word.
 */
function listDataWords(elementSize: number, elementCount: number): number {
  switch (elementSize) {
    case 0: // void
      return 0;
    case 1: // bit
      return Math.ceil(elementCount / 64);
    case 2: // byte
      return Math.ceil(elementCount / WORD_BYTES);
    case 3: // two bytes
      return Math.ceil((elementCount * 2) / WORD_BYTES);
    case 4: // four bytes
      return Math.ceil((elementCount * 4) / WORD_BYTES);
    case 5: // eight bytes (one word)
      return elementCount;
    case 6: // pointer (one word each)
      return elementCount;
    case 7: // inline composite -- handled separately by caller
      return 0;
    default:
      throw new ProtocolError(`unknown list element size: ${elementSize}`);
  }
}

/**
 * Deep-copy a single sub-pointer from the source table into the output
 * buffer.  Handles null, capability, far, and direct pointers.
 */
function deepCopySubPointer(
  table: SegmentTable,
  srcSegment: number,
  srcPtrWord: number,
  buf: WordBuffer,
  dstPtrWord: number,
): void {
  const subWord = readWordFromTable(
    table,
    srcSegment,
    srcPtrWord,
    "deepCopy sub-pointer",
  );
  const subKind = Number(subWord & 0x3n);
  if (subWord === 0n || subKind === 3) {
    buf.writeWord(dstPtrWord, subWord);
  } else if (subKind === 2) {
    const resolved = resolvePointer(table, srcSegment, srcPtrWord);
    deepCopyPointer(
      table,
      resolved.segmentId,
      resolved.pointerWord,
      resolved.word,
      buf,
      dstPtrWord,
    );
  } else {
    deepCopyPointer(
      table,
      srcSegment,
      srcPtrWord,
      subWord,
      buf,
      dstPtrWord,
    );
  }
}

/**
 * Deep-copy a single resolved (non-far) pointer and all data it references
 * from a potentially multi-segment SegmentTable into a flat WordBuffer.
 *
 * `srcSegment` / `srcPointerWord` describe where the pointer word lives in
 * the source table.  `word` is the already-read (and already-resolved, i.e.
 * non-far) 64-bit pointer value.  `dstPointerWord` is the word index in `buf`
 * where the rebased pointer should be written.
 */
function deepCopyPointer(
  table: SegmentTable,
  srcSegment: number,
  srcPointerWord: number,
  word: bigint,
  buf: WordBuffer,
  dstPointerWord: number,
): void {
  if (word === 0n) {
    buf.writeWord(dstPointerWord, 0n);
    return;
  }

  const kind = Number(word & 0x3n);

  // Capability pointer (kind=3): copy as-is, no referenced data.
  if (kind === 3) {
    buf.writeWord(dstPointerWord, word);
    return;
  }

  if (kind === 0) {
    // Struct pointer
    const offset = signed30((word >> 2n) & MASK_30);
    const dataWordCount = Number((word >> 32n) & 0xffffn);
    const pointerCount = Number((word >> 48n) & 0xffffn);
    const srcStart = srcPointerWord + 1 + offset;
    const totalWords = dataWordCount + pointerCount;

    const dstStart = buf.allocWords(totalWords);

    // Write the struct pointer with offset from dstPointerWord to dstStart
    const dstOffset = dstStart - (dstPointerWord + 1);
    const newPtr = (word & ~POINTER_OFFSET_MASK) |
      (encodeSigned30(dstOffset) << 2n);
    buf.writeWord(dstPointerWord, newPtr);

    // Copy data section verbatim
    if (dataWordCount > 0) {
      const seg = table.segments[srcSegment];
      buf.copyFromSegment(dstStart, seg, srcStart, dataWordCount);
    }

    // Deep-copy each pointer in the pointer section
    for (let i = 0; i < pointerCount; i += 1) {
      deepCopySubPointer(
        table,
        srcSegment,
        srcStart + dataWordCount + i,
        buf,
        dstStart + dataWordCount + i,
      );
    }
    return;
  }

  if (kind === 1) {
    // List pointer
    const offset = signed30((word >> 2n) & MASK_30);
    const elementSize = Number((word >> 32n) & 0x7n);
    const elementCount = Number((word >> 35n) & 0x1fff_ffffn);
    const srcListStart = srcPointerWord + 1 + offset;

    if (elementSize === 7) {
      // Inline composite list: has a tag word followed by element data.
      const tagWord = readWordFromTable(
        table,
        srcSegment,
        srcListStart,
        "deepCopy inline composite tag",
      );
      const tagDataWords = Number((tagWord >> 32n) & 0xffffn);
      const tagPtrCount = Number((tagWord >> 48n) & 0xffffn);
      const tagElementCount = Number((tagWord >> 2n) & MASK_30);
      const stride = tagDataWords + tagPtrCount;
      const totalDataWords = tagElementCount * stride;

      const dstListStart = buf.allocWords(1 + totalDataWords);

      // Write the list pointer
      const dstOffset = dstListStart - (dstPointerWord + 1);
      const newPtr = 1n |
        (encodeSigned30(dstOffset) << 2n) |
        (BigInt(elementSize) << 32n) |
        (BigInt(elementCount) << 35n);
      buf.writeWord(dstPointerWord, newPtr);

      // Copy the tag word
      buf.writeWord(dstListStart, tagWord);

      // Copy each element
      for (let i = 0; i < tagElementCount; i += 1) {
        const srcElemStart = srcListStart + 1 + (i * stride);
        const dstElemStart = dstListStart + 1 + (i * stride);

        if (tagDataWords > 0) {
          const seg = table.segments[srcSegment];
          buf.copyFromSegment(dstElemStart, seg, srcElemStart, tagDataWords);
        }

        for (let j = 0; j < tagPtrCount; j += 1) {
          deepCopySubPointer(
            table,
            srcSegment,
            srcElemStart + tagDataWords + j,
            buf,
            dstElemStart + tagDataWords + j,
          );
        }
      }
      return;
    }

    if (elementSize === 6) {
      // List of pointers: each element is one pointer word.
      const dstListStart = buf.allocWords(elementCount);

      const dstOffset = dstListStart - (dstPointerWord + 1);
      const newPtr = 1n |
        (encodeSigned30(dstOffset) << 2n) |
        (BigInt(elementSize) << 32n) |
        (BigInt(elementCount) << 35n);
      buf.writeWord(dstPointerWord, newPtr);

      for (let i = 0; i < elementCount; i += 1) {
        deepCopySubPointer(
          table,
          srcSegment,
          srcListStart + i,
          buf,
          dstListStart + i,
        );
      }
      return;
    }

    // Primitive list (elementSize 0-5): no nested pointers, just raw data.
    const dataWords = listDataWords(elementSize, elementCount);
    const dstListStart = buf.allocWords(dataWords);

    const dstOffset = dstListStart - (dstPointerWord + 1);
    const newPtr = 1n |
      (encodeSigned30(dstOffset) << 2n) |
      (BigInt(elementSize) << 32n) |
      (BigInt(elementCount) << 35n);
    buf.writeWord(dstPointerWord, newPtr);

    if (dataWords > 0) {
      const seg = table.segments[srcSegment];
      buf.copyFromSegment(dstListStart, seg, srcListStart, dataWords);
    }
    return;
  }

  // kind === 2 should not happen here (caller should resolve first)
  throw new ProtocolError(
    "deepCopyPointer received an unresolved far pointer (kind=2)",
  );
}

// ---------------------------------------------------------------------------
// Composite helpers
// ---------------------------------------------------------------------------

export function extractPointerContentAsMessage(
  table: SegmentTable,
  loc: PointerLocation,
  _context: string,
): Uint8Array {
  const resolved = resolvePointer(table, loc.segmentId, loc.wordIndex);
  if (resolved.word === 0n) {
    return new Uint8Array(EMPTY_STRUCT_MESSAGE);
  }

  // Deep-copy the pointer and all referenced data into a flat single-segment
  // message.  Word 0 is the root pointer; the data follows.
  const buf = new WordBuffer(1); // start with 1 word for the root pointer
  deepCopyPointer(
    table,
    resolved.segmentId,
    resolved.pointerWord,
    resolved.word,
    buf,
    0, // write the root pointer at word 0
  );

  return frameFromSegment(buf.toUint8Array());
}

export function readTextFromPointer(
  table: SegmentTable,
  loc: PointerLocation,
): string | null {
  const list = decodeByteListPointer(table, loc);
  if (!list) return null;
  const seg = table.segments[list.segmentId];
  const start = list.startWord * WORD_BYTES;
  const end = start + list.elementCount;
  ensureRange(seg, start, list.elementCount, "readTextFromPointer");
  const bytes = seg.subarray(start, end);
  const payload = bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 0
    ? bytes.subarray(0, bytes.byteLength - 1)
    : bytes;
  return new TextDecoder().decode(payload);
}
