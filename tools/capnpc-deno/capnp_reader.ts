const WORD_BYTES = 8;
const MASK_29 = 0x1fff_ffffn;

function signed30(value: bigint): number {
  const raw = Number(value & 0x3fff_ffffn);
  return (raw & (1 << 29)) !== 0 ? raw - (1 << 30) : raw;
}

function requireRange(
  segment: Uint8Array,
  byteOffset: number,
  length: number,
  context: string,
): void {
  if (byteOffset < 0 || byteOffset + length > segment.byteLength) {
    throw new Error(
      `${context} out of bounds: offset=${byteOffset} len=${length} segment=${segment.byteLength}`,
    );
  }
}

function readWord(segment: Uint8Array, byteOffset: number): bigint {
  requireRange(segment, byteOffset, WORD_BYTES, "readWord");
  const view = new DataView(
    segment.buffer,
    segment.byteOffset,
    segment.byteLength,
  );
  const lo = view.getUint32(byteOffset, true);
  const hi = view.getUint32(byteOffset + 4, true);
  return (BigInt(hi) << 32n) | BigInt(lo);
}

interface ResolvedPointer {
  segmentId: number;
  pointerByteOffset: number;
  word: bigint;
}

export class CapnpReader {
  readonly segments: Uint8Array[];

  constructor(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 8) {
      throw new Error("capnp message too short");
    }

    const segmentCount = view.getUint32(0, true) + 1;
    const headerWords = 1 + segmentCount + (segmentCount % 2 === 0 ? 1 : 0);
    const headerBytes = headerWords * 4;
    if (bytes.byteLength < headerBytes) {
      throw new Error("capnp message header truncated");
    }

    const sizes: number[] = [];
    for (let i = 0; i < segmentCount; i += 1) {
      sizes.push(view.getUint32(4 + i * 4, true));
    }

    let cursor = headerBytes;
    const segments: Uint8Array[] = [];
    for (const sizeWords of sizes) {
      const segBytes = sizeWords * WORD_BYTES;
      if (cursor + segBytes > bytes.byteLength) {
        throw new Error("capnp message segment truncated");
      }
      segments.push(bytes.subarray(cursor, cursor + segBytes));
      cursor += segBytes;
    }
    this.segments = segments;
  }

  root(): StructReader {
    if (this.segments.length === 0 || this.segments[0].byteLength < WORD_BYTES) {
      throw new Error("capnp message missing root segment");
    }
    return this.readStructPointer(0, 0);
  }

  readStructPointer(segmentId: number, pointerByteOffset: number): StructReader {
    const resolved = this.resolvePointer(segmentId, pointerByteOffset);
    const word = resolved.word;
    if (word === 0n) {
      throw new Error("null struct pointer");
    }

    const kind = Number(word & 0x3n);
    if (kind !== 0) {
      throw new Error(`expected struct pointer, got kind=${kind}`);
    }

    const offsetWords = signed30((word >> 2n) & 0x3fff_ffffn);
    const dataWordCount = Number((word >> 32n) & 0xffffn);
    const pointerCount = Number((word >> 48n) & 0xffffn);
    const targetWord = (resolved.pointerByteOffset / WORD_BYTES) + 1 + offsetWords;
    const targetByteOffset = targetWord * WORD_BYTES;

    return new StructReader(
      this,
      resolved.segmentId,
      targetByteOffset,
      dataWordCount,
      pointerCount,
    );
  }

  resolvePointer(
    segmentId: number,
    pointerByteOffset: number,
  ): ResolvedPointer {
    let currentSegmentId = segmentId;
    let currentPointerByteOffset = pointerByteOffset;
    let word = this.readWordAt(currentSegmentId, currentPointerByteOffset);

    for (let hops = 0; hops < 8; hops += 1) {
      const kind = Number(word & 0x3n);
      if (kind !== 2) {
        return {
          segmentId: currentSegmentId,
          pointerByteOffset: currentPointerByteOffset,
          word,
        };
      }

      const isDoubleFar = ((word >> 2n) & 0x1n) === 1n;
      const landingPadWord = Number((word >> 3n) & MASK_29);
      const landingSegmentId = Number((word >> 32n) & 0xffff_ffffn);
      const landingPadByteOffset = landingPadWord * WORD_BYTES;

      if (!isDoubleFar) {
        currentSegmentId = landingSegmentId;
        currentPointerByteOffset = landingPadByteOffset;
        word = this.readWordAt(currentSegmentId, currentPointerByteOffset);
        continue;
      }

      const pad0 = this.readWordAt(landingSegmentId, landingPadByteOffset);
      const pad0Kind = Number(pad0 & 0x3n);
      if (pad0Kind !== 2) {
        throw new Error(`double-far landing pad[0] must be far pointer, got kind=${pad0Kind}`);
      }
      const pad0IsDoubleFar = ((pad0 >> 2n) & 0x1n) === 1n;
      if (pad0IsDoubleFar) {
        throw new Error("double-far landing pad[0] must be single-far pointer");
      }
      const pad0OffsetWords = Number((pad0 >> 3n) & MASK_29);
      const pad0SegmentId = Number((pad0 >> 32n) & 0xffff_ffffn);

      currentSegmentId = pad0SegmentId;
      currentPointerByteOffset = pad0OffsetWords * WORD_BYTES;
      word = this.readWordAt(landingSegmentId, landingPadByteOffset + WORD_BYTES);
    }

    throw new Error("far pointer chain exceeded maximum hop count");
  }

  readWordAt(segmentId: number, byteOffset: number): bigint {
    const segment = this.segments[segmentId];
    if (!segment) throw new Error(`missing segment ${segmentId}`);
    return readWord(segment, byteOffset);
  }

  readBytesAt(segmentId: number, byteOffset: number, len: number): Uint8Array {
    const segment = this.segments[segmentId];
    if (!segment) throw new Error(`missing segment ${segmentId}`);
    requireRange(segment, byteOffset, len, "readBytesAt");
    return segment.subarray(byteOffset, byteOffset + len);
  }

  viewFor(segmentId: number): DataView {
    const segment = this.segments[segmentId];
    if (!segment) throw new Error(`missing segment ${segmentId}`);
    return new DataView(
      segment.buffer,
      segment.byteOffset,
      segment.byteLength,
    );
  }
}

export class StructListReader {
  readonly #reader: CapnpReader;
  readonly #segmentId: number;
  readonly #elementsByteOffset: number;
  readonly #elementCount: number;
  readonly #dataWordCount: number;
  readonly #pointerCount: number;

  constructor(
    reader: CapnpReader,
    segmentId: number,
    elementsByteOffset: number,
    elementCount: number,
    dataWordCount: number,
    pointerCount: number,
  ) {
    this.#reader = reader;
    this.#segmentId = segmentId;
    this.#elementsByteOffset = elementsByteOffset;
    this.#elementCount = elementCount;
    this.#dataWordCount = dataWordCount;
    this.#pointerCount = pointerCount;
  }

  len(): number {
    return this.#elementCount;
  }

  get(index: number): StructReader {
    if (index < 0 || index >= this.#elementCount) {
      throw new Error(`struct list index out of range: ${index}`);
    }
    const strideWords = this.#dataWordCount + this.#pointerCount;
    const offset = this.#elementsByteOffset + (index * strideWords * WORD_BYTES);
    return new StructReader(
      this.#reader,
      this.#segmentId,
      offset,
      this.#dataWordCount,
      this.#pointerCount,
    );
  }
}

export class StructReader {
  readonly #reader: CapnpReader;
  readonly #segmentId: number;
  readonly #dataByteOffset: number;
  readonly #dataWordCount: number;
  readonly #pointerCount: number;

  constructor(
    reader: CapnpReader,
    segmentId: number,
    dataByteOffset: number,
    dataWordCount: number,
    pointerCount: number,
  ) {
    this.#reader = reader;
    this.#segmentId = segmentId;
    this.#dataByteOffset = dataByteOffset;
    this.#dataWordCount = dataWordCount;
    this.#pointerCount = pointerCount;
  }

  readU8(byteOffset: number): number {
    const view = this.#reader.viewFor(this.#segmentId);
    const absolute = this.#dataByteOffset + byteOffset;
    return view.getUint8(absolute);
  }

  readU16(byteOffset: number): number {
    const view = this.#reader.viewFor(this.#segmentId);
    const absolute = this.#dataByteOffset + byteOffset;
    return view.getUint16(absolute, true);
  }

  readU32(byteOffset: number): number {
    const view = this.#reader.viewFor(this.#segmentId);
    const absolute = this.#dataByteOffset + byteOffset;
    return view.getUint32(absolute, true);
  }

  readU64(byteOffset: number): bigint {
    const lo = this.readU32(byteOffset);
    const hi = this.readU32(byteOffset + 4);
    return (BigInt(hi) << 32n) | BigInt(lo);
  }

  readBool(byteOffset: number, bitOffset: number): boolean {
    const byte = this.readU8(byteOffset);
    return (byte & (1 << bitOffset)) !== 0;
  }

  readStruct(pointerIndex: number): StructReader | null {
    const pointerByteOffset = this.pointerByteOffset(pointerIndex);
    const resolved = this.#reader.resolvePointer(this.#segmentId, pointerByteOffset);
    const word = resolved.word;
    if (word === 0n) return null;

    const kind = Number(word & 0x3n);
    if (kind !== 0) {
      throw new Error(`expected struct pointer in pointer slot, got kind=${kind}`);
    }

    const offsetWords = signed30((word >> 2n) & 0x3fff_ffffn);
    const dataWordCount = Number((word >> 32n) & 0xffffn);
    const pointerCount = Number((word >> 48n) & 0xffffn);

    const targetWord = (resolved.pointerByteOffset / WORD_BYTES) + 1 + offsetWords;
    const targetByteOffset = targetWord * WORD_BYTES;

    return new StructReader(
      this.#reader,
      resolved.segmentId,
      targetByteOffset,
      dataWordCount,
      pointerCount,
    );
  }

  readStructList(pointerIndex: number): StructListReader | null {
    const pointerByteOffset = this.pointerByteOffset(pointerIndex);
    const resolved = this.#reader.resolvePointer(this.#segmentId, pointerByteOffset);
    const word = resolved.word;
    if (word === 0n) return null;

    const kind = Number(word & 0x3n);
    if (kind !== 1) {
      throw new Error(`expected list pointer in pointer slot, got kind=${kind}`);
    }

    const offsetWords = signed30((word >> 2n) & 0x3fff_ffffn);
    const elementSize = Number((word >> 32n) & 0x7n);
    const elementCountOrWords = Number((word >> 35n) & 0x1fff_ffffn);
    const targetWord = (resolved.pointerByteOffset / WORD_BYTES) + 1 + offsetWords;
    const targetByteOffset = targetWord * WORD_BYTES;

    if (elementSize !== 7) {
      throw new Error(
        `expected inline-composite struct list (size=7), got elementSize=${elementSize}`,
      );
    }

    const tag = this.#reader.readWordAt(resolved.segmentId, targetByteOffset);
    const tagKind = Number(tag & 0x3n);
    if (tagKind !== 0) {
      throw new Error(`inline-composite tag is not a struct pointer: kind=${tagKind}`);
    }
    const elementCount = Number((tag >> 2n) & 0x3fff_ffffn);
    const dataWordCount = Number((tag >> 32n) & 0xffffn);
    const pointerCount = Number((tag >> 48n) & 0xffffn);
    const elementsByteOffset = targetByteOffset + WORD_BYTES;

    const strideWords = dataWordCount + pointerCount;
    const totalBytes = strideWords * WORD_BYTES * elementCount;
    const declaredBytes = elementCountOrWords * WORD_BYTES;
    if (totalBytes > declaredBytes) {
      throw new Error("inline-composite list size exceeds declared word count");
    }

    return new StructListReader(
      this.#reader,
      resolved.segmentId,
      elementsByteOffset,
      elementCount,
      dataWordCount,
      pointerCount,
    );
  }

  readText(pointerIndex: number): string | null {
    const bytes = this.readByteList(pointerIndex, true);
    if (bytes === null) return null;
    return new TextDecoder().decode(bytes);
  }

  readData(pointerIndex: number): Uint8Array | null {
    return this.readByteList(pointerIndex, false);
  }

  private readByteList(
    pointerIndex: number,
    trimNul: boolean,
  ): Uint8Array | null {
    const pointerByteOffset = this.pointerByteOffset(pointerIndex);
    const resolved = this.#reader.resolvePointer(this.#segmentId, pointerByteOffset);
    const word = resolved.word;
    if (word === 0n) return null;

    const kind = Number(word & 0x3n);
    if (kind !== 1) {
      throw new Error(`expected byte-list pointer, got kind=${kind}`);
    }

    const offsetWords = signed30((word >> 2n) & 0x3fff_ffffn);
    const elementSize = Number((word >> 32n) & 0x7n);
    if (elementSize !== 2) {
      throw new Error(`expected byte-list element size 2, got ${elementSize}`);
    }
    const elementCount = Number((word >> 35n) & 0x1fff_ffffn);
    const targetWord = (resolved.pointerByteOffset / WORD_BYTES) + 1 + offsetWords;
    const targetByteOffset = targetWord * WORD_BYTES;

    const bytes = this.#reader.readBytesAt(
      resolved.segmentId,
      targetByteOffset,
      elementCount,
    );
    if (!trimNul) return bytes;
    if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 0x00) {
      return bytes.subarray(0, bytes.byteLength - 1);
    }
    return bytes;
  }

  private pointerByteOffset(pointerIndex: number): number {
    if (pointerIndex < 0 || pointerIndex >= this.#pointerCount) {
      throw new Error(`pointer index out of range: ${pointerIndex}`);
    }
    const pointerSection = this.#dataByteOffset + (this.#dataWordCount * WORD_BYTES);
    return pointerSection + (pointerIndex * WORD_BYTES);
  }

  private readPointerWord(pointerIndex: number): bigint {
    return this.#reader.readWordAt(
      this.#segmentId,
      this.pointerByteOffset(pointerIndex),
    );
  }
}
