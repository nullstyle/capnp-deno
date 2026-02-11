/**
 * Segment table construction and word-level read/write helpers for
 * Cap'n Proto multi-segment frames.
 *
 * @module
 */

import { ProtocolError } from "../../errors.ts";
import type { SegmentTable } from "./types.ts";
import { WORD_BYTES } from "./types.ts";

// ---------------------------------------------------------------------------
// Range checks
// ---------------------------------------------------------------------------

export function ensureRange(
  segment: Uint8Array,
  byteOffset: number,
  len: number,
  context: string,
): void {
  if (byteOffset < 0 || byteOffset + len > segment.byteLength) {
    throw new ProtocolError(
      `${context} out of range: offset=${byteOffset} len=${len} segment=${segment.byteLength}`,
    );
  }
}

export function ensureSegmentRange(
  table: SegmentTable,
  segmentId: number,
  byteOffset: number,
  len: number,
  context: string,
): void {
  if (segmentId < 0 || segmentId >= table.segments.length) {
    throw new ProtocolError(
      `${context} references missing segment ${segmentId}`,
    );
  }
  const seg = table.segments[segmentId];
  if (byteOffset < 0 || byteOffset + len > seg.byteLength) {
    throw new ProtocolError(
      `${context} out of range: segment=${segmentId} offset=${byteOffset} len=${len} segmentSize=${seg.byteLength}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Frame parsing
// ---------------------------------------------------------------------------

export function segmentsFromFrame(frame: Uint8Array): SegmentTable {
  if (frame.byteLength < 8) {
    throw new ProtocolError("rpc frame is too short");
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const segmentCount = view.getUint32(0, true) + 1;

  // Header: (segmentCount + 1) u32 values, padded to 8-byte alignment.
  // First u32 is segmentCount-1, followed by segmentCount u32 word counts.
  const headerU32Count = 1 + segmentCount;
  const headerBytes = Math.ceil((headerU32Count * 4) / WORD_BYTES) * WORD_BYTES;
  if (frame.byteLength < headerBytes) {
    throw new ProtocolError("rpc frame header is truncated");
  }

  const segments: Uint8Array[] = [];
  const views: DataView[] = [];
  let cursor = headerBytes;
  for (let i = 0; i < segmentCount; i += 1) {
    const segmentWords = view.getUint32(4 + i * 4, true);
    const segmentBytes = segmentWords * WORD_BYTES;
    if (cursor + segmentBytes > frame.byteLength) {
      throw new ProtocolError("rpc frame segment payload is truncated");
    }
    const seg = frame.subarray(cursor, cursor + segmentBytes);
    segments.push(seg);
    views.push(new DataView(seg.buffer, seg.byteOffset, seg.byteLength));
    cursor += segmentBytes;
  }

  return { segments, views };
}

/**
 * Legacy single-segment accessor for encoding paths that always produce
 * single-segment messages. Rejects multi-segment input.
 */
export function segmentFromFrame(frame: Uint8Array): Uint8Array {
  const table = segmentsFromFrame(frame);
  if (table.segments.length !== 1) {
    throw new ProtocolError(
      `expected single-segment payload message, got ${table.segments.length}`,
    );
  }
  return table.segments[0];
}

export function frameFromSegment(segment: Uint8Array): Uint8Array {
  if (segment.byteLength % WORD_BYTES !== 0) {
    throw new ProtocolError(
      `segment length must be word-aligned, got ${segment.byteLength}`,
    );
  }
  const words = segment.byteLength / WORD_BYTES;
  const out = new Uint8Array(8 + segment.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, 0, true);
  view.setUint32(4, words, true);
  out.set(segment, 8);
  return out;
}

// ---------------------------------------------------------------------------
// Word-level read / write
// ---------------------------------------------------------------------------

export function readWord(segment: Uint8Array, wordIndex: number): bigint {
  const byteOffset = wordIndex * WORD_BYTES;
  ensureRange(segment, byteOffset, WORD_BYTES, "readWord");
  const view = new DataView(
    segment.buffer,
    segment.byteOffset,
    segment.byteLength,
  );
  return view.getBigUint64(byteOffset, true);
}

export function readWordFromTable(
  table: SegmentTable,
  segmentId: number,
  wordIndex: number,
  context: string,
): bigint {
  ensureSegmentRange(
    table,
    segmentId,
    wordIndex * WORD_BYTES,
    WORD_BYTES,
    context,
  );
  return table.views[segmentId]
    .getBigUint64(wordIndex * WORD_BYTES, true);
}

export function writeWord(
  segment: Uint8Array,
  wordIndex: number,
  value: bigint,
): void {
  const byteOffset = wordIndex * WORD_BYTES;
  ensureRange(segment, byteOffset, WORD_BYTES, "writeWord");
  new DataView(segment.buffer, segment.byteOffset, segment.byteLength)
    .setBigUint64(byteOffset, value, true);
}

// ---------------------------------------------------------------------------
// Struct field readers (table-aware)
// ---------------------------------------------------------------------------

export function readU16InStruct(
  table: SegmentTable,
  structRef: { segmentId: number; startWord: number; dataWordCount: number },
  byteOffset: number,
): number {
  if (
    byteOffset < 0 || byteOffset + 2 > structRef.dataWordCount * WORD_BYTES
  ) {
    throw new ProtocolError(`readU16InStruct out of range: ${byteOffset}`);
  }
  const absolute = structRef.startWord * WORD_BYTES + byteOffset;
  const seg = table.segments[structRef.segmentId];
  ensureRange(seg, absolute, 2, "readU16InStruct");
  return table.views[structRef.segmentId]
    .getUint16(absolute, true);
}

export function readU32InStruct(
  table: SegmentTable,
  structRef: { segmentId: number; startWord: number; dataWordCount: number },
  byteOffset: number,
): number {
  if (
    byteOffset < 0 || byteOffset + 4 > structRef.dataWordCount * WORD_BYTES
  ) {
    throw new ProtocolError(`readU32InStruct out of range: ${byteOffset}`);
  }
  const absolute = structRef.startWord * WORD_BYTES + byteOffset;
  const seg = table.segments[structRef.segmentId];
  ensureRange(seg, absolute, 4, "readU32InStruct");
  return table.views[structRef.segmentId]
    .getUint32(absolute, true);
}

export function readU64InStruct(
  table: SegmentTable,
  structRef: { segmentId: number; startWord: number; dataWordCount: number },
  byteOffset: number,
): bigint {
  if (
    byteOffset < 0 || byteOffset + 8 > structRef.dataWordCount * WORD_BYTES
  ) {
    throw new ProtocolError(`readU64InStruct out of range: ${byteOffset}`);
  }
  const absolute = structRef.startWord * WORD_BYTES + byteOffset;
  const seg = table.segments[structRef.segmentId];
  ensureRange(seg, absolute, 8, "readU64InStruct");
  return table.views[structRef.segmentId]
    .getBigUint64(absolute, true);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function ensureU16(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new ProtocolError(`${name} must be a u16, got ${value}`);
  }
  return value;
}

export function ensureU32(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new ProtocolError(`${name} must be a u32, got ${value}`);
  }
  return value;
}

export function ensureU64(value: bigint, name: string): bigint {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new ProtocolError(`${name} must be a u64, got ${value}`);
  }
  return value;
}

export function signed30(value: bigint): number {
  const raw = Number(value & 0x3fff_ffffn);
  return (raw & (1 << 29)) !== 0 ? raw - (1 << 30) : raw;
}

export function encodeSigned30(value: number): bigint {
  if (
    !Number.isInteger(value) || value < -(1 << 29) || value > (1 << 29) - 1
  ) {
    throw new ProtocolError(`pointer offset out of signed30 range: ${value}`);
  }
  return BigInt(value < 0 ? value + (1 << 30) : value) & 0x3fff_ffffn;
}
