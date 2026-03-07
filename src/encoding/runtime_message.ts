/**
 * Message builder and reader primitives for the Cap'n Proto encoding runtime.
 *
 * @module
 */

import {
  bytesToWords,
  encodeSigned30,
  MASK_29,
  MASK_30,
  signed30,
  TEXT_DECODER,
  TEXT_ENCODER,
  WORD_BYTES,
} from "./runtime_model.ts";

export class MessageBuilder {
  private bytes: Uint8Array;
  private words: number;

  constructor() {
    this.bytes = new Uint8Array(WORD_BYTES);
    this.words = 1;
  }

  allocWords(count: number): number {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error("allocWords requires a non-negative integer");
    }
    const start = this.words;
    this.words += count;
    this.ensureCapacity(this.words * WORD_BYTES);
    return start;
  }

  pointerWordIndex(
    structWord: number,
    dataWordCount: number,
    pointerOffset: number,
  ): number {
    return structWord + dataWordCount + pointerOffset;
  }

  writeWord(wordIndex: number, word: bigint): void {
    this.requireWordRange(wordIndex, 1, "writeWord");
    this.view().setBigUint64(wordIndex * WORD_BYTES, word, true);
  }

  writeUint8(byteOffset: number, value: number): void {
    this.requireByteRange(byteOffset, 1, "writeUint8");
    this.view().setUint8(byteOffset, value & 0xff);
  }

  writeInt8(byteOffset: number, value: number): void {
    this.requireByteRange(byteOffset, 1, "writeInt8");
    this.view().setInt8(byteOffset, value | 0);
  }

  writeUint16(byteOffset: number, value: number): void {
    this.requireByteRange(byteOffset, 2, "writeUint16");
    this.view().setUint16(byteOffset, value & 0xffff, true);
  }

  writeInt16(byteOffset: number, value: number): void {
    this.requireByteRange(byteOffset, 2, "writeInt16");
    this.view().setInt16(byteOffset, value | 0, true);
  }

  writeUint32(byteOffset: number, value: number): void {
    this.requireByteRange(byteOffset, 4, "writeUint32");
    this.view().setUint32(byteOffset, value >>> 0, true);
  }

  writeInt32(byteOffset: number, value: number): void {
    this.requireByteRange(byteOffset, 4, "writeInt32");
    this.view().setInt32(byteOffset, value | 0, true);
  }

  writeBigUint64(byteOffset: number, value: bigint): void {
    this.requireByteRange(byteOffset, 8, "writeBigUint64");
    this.view().setBigUint64(byteOffset, value, true);
  }

  writeBigInt64(byteOffset: number, value: bigint): void {
    this.requireByteRange(byteOffset, 8, "writeBigInt64");
    this.view().setBigInt64(byteOffset, value, true);
  }

  writeFloat32(byteOffset: number, value: number): void {
    this.requireByteRange(byteOffset, 4, "writeFloat32");
    this.view().setFloat32(byteOffset, value, true);
  }

  writeFloat64(byteOffset: number, value: number): void {
    this.requireByteRange(byteOffset, 8, "writeFloat64");
    this.view().setFloat64(byteOffset, value, true);
  }

  setBool(byteOffset: number, bitOffset: number, value: boolean): void {
    this.requireByteRange(byteOffset, 1, "setBool");
    const bit = 1 << bitOffset;
    const current = this.view().getUint8(byteOffset);
    this.view().setUint8(
      byteOffset,
      value ? (current | bit) : (current & ~bit),
    );
  }

  setStructPointer(
    pointerWord: number,
    targetWord: number,
    dataWordCount: number,
    pointerCount: number,
  ): void {
    const offset = targetWord - (pointerWord + 1);
    let word = 0n;
    word |= encodeSigned30(offset) << 2n;
    word |= BigInt(dataWordCount & 0xffff) << 32n;
    word |= BigInt(pointerCount & 0xffff) << 48n;
    this.writeWord(pointerWord, word);
  }

  setListPointer(
    pointerWord: number,
    targetWord: number,
    elementSize: number,
    count: number,
  ): void {
    const offset = targetWord - (pointerWord + 1);
    let word = 1n;
    word |= encodeSigned30(offset) << 2n;
    word |= BigInt(elementSize & 0x7) << 32n;
    word |= BigInt(count & 0x1fff_ffff) << 35n;
    this.writeWord(pointerWord, word);
  }

  writeTextPointer(pointerWord: number, value: string): void {
    const encoded = TEXT_ENCODER.encode(value);
    const byteCount = encoded.byteLength + 1;
    const targetWord = this.allocWords(bytesToWords(byteCount));
    const startByte = targetWord * WORD_BYTES;
    this.requireByteRange(startByte, byteCount, "writeTextPointer");
    this.bytes.set(encoded, startByte);
    this.bytes[startByte + encoded.byteLength] = 0;
    this.setListPointer(pointerWord, targetWord, 2, byteCount);
  }

  writeDataPointer(pointerWord: number, value: Uint8Array): void {
    const targetWord = this.allocWords(bytesToWords(value.byteLength));
    const startByte = targetWord * WORD_BYTES;
    this.requireByteRange(startByte, value.byteLength, "writeDataPointer");
    this.bytes.set(value, startByte);
    this.setListPointer(pointerWord, targetWord, 2, value.byteLength);
  }

  toMessageBytes(): Uint8Array {
    const segmentBytes = this.words * WORD_BYTES;
    const out = new Uint8Array(8 + segmentBytes);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0, true);
    view.setUint32(4, this.words, true);
    out.set(this.bytes.subarray(0, segmentBytes), 8);
    return out;
  }

  private ensureCapacity(requiredBytes: number): void {
    if (this.bytes.byteLength >= requiredBytes) return;
    let next = this.bytes.byteLength;
    while (next < requiredBytes) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.bytes);
    this.bytes = grown;
  }

  private view(): DataView {
    return new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    );
  }

  private requireWordRange(
    wordIndex: number,
    count: number,
    context: string,
  ): void {
    if (wordIndex < 0 || count < 0 || wordIndex + count > this.words) {
      throw new Error(
        context + " out of range: word=" + wordIndex + " count=" + count +
          " words=" + this.words,
      );
    }
  }

  private requireByteRange(
    byteOffset: number,
    length: number,
    context: string,
  ): void {
    const max = this.words * WORD_BYTES;
    if (byteOffset < 0 || length < 0 || byteOffset + length > max) {
      throw new Error(
        context + " out of range: offset=" + byteOffset + " len=" + length +
          " max=" + max,
      );
    }
  }
}

export interface StructRef {
  segmentId: number;
  startWord: number;
  dataWordCount: number;
  pointerCount: number;
}

export interface FlatListRef {
  kind: "flat";
  segmentId: number;
  startWord: number;
  elementSize: number;
  elementCount: number;
}

export interface InlineCompositeListRef {
  kind: "inlineComposite";
  segmentId: number;
  tagWord: number;
  elementCount: number;
  dataWordCount: number;
  pointerCount: number;
  wordsInElements: number;
}

export type ListRef = FlatListRef | InlineCompositeListRef;

export interface ResolvedPointer {
  segmentId: number;
  pointerWord: number;
  word: bigint;
}

export class MessageReader {
  private readonly segments: Uint8Array[];

  constructor(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 8) {
      throw new Error("message is too short");
    }
    const segmentCount = view.getUint32(0, true) + 1;
    const headerWords = 1 + segmentCount + (segmentCount % 2 === 0 ? 1 : 0);
    const headerBytes = headerWords * 4;
    if (bytes.byteLength < headerBytes) {
      throw new Error("segment table is truncated");
    }

    const sizes: number[] = [];
    for (let i = 0; i < segmentCount; i += 1) {
      sizes.push(view.getUint32(4 + i * 4, true));
    }

    const segments: Uint8Array[] = [];
    let cursor = headerBytes;
    for (const sizeWords of sizes) {
      const segmentBytes = sizeWords * WORD_BYTES;
      if (cursor + segmentBytes > bytes.byteLength) {
        throw new Error("segment payload is truncated");
      }
      segments.push(bytes.subarray(cursor, cursor + segmentBytes));
      cursor += segmentBytes;
    }
    this.segments = segments;
  }

  readRootStruct(): StructRef {
    const root = this.readStructPointer(0, 0);
    if (!root) throw new Error("root pointer is null");
    return root;
  }

  readStructPointer(segmentId: number, pointerWord: number): StructRef | null {
    const resolved = this.resolvePointer(segmentId, pointerWord);
    const word = resolved.word;
    if (word === 0n) return null;
    const kind = Number(word & 0x3n);
    if (kind !== 0) {
      throw new Error("expected struct pointer, got kind " + kind);
    }
    const offsetWords = signed30((word >> 2n) & MASK_30);
    const dataWordCount = Number((word >> 32n) & 0xffffn);
    const pointerCount = Number((word >> 48n) & 0xffffn);
    const targetWord = resolved.pointerWord + 1 + offsetWords;
    this.requireWordRange(
      resolved.segmentId,
      targetWord,
      dataWordCount + pointerCount,
      "struct pointer target",
    );
    return {
      segmentId: resolved.segmentId,
      startWord: targetWord,
      dataWordCount,
      pointerCount,
    };
  }

  readListPointer(segmentId: number, pointerWord: number): ListRef | null {
    const resolved = this.resolvePointer(segmentId, pointerWord);
    const word = resolved.word;
    if (word === 0n) return null;
    const kind = Number(word & 0x3n);
    if (kind !== 1) {
      throw new Error("expected list pointer, got kind " + kind);
    }
    const offsetWords = signed30((word >> 2n) & MASK_30);
    const elementSize = Number((word >> 32n) & 0x7n);
    const count = Number((word >> 35n) & 0x1fff_ffffn);
    const targetWord = resolved.pointerWord + 1 + offsetWords;
    if (elementSize === 7) {
      this.requireWordRange(
        resolved.segmentId,
        targetWord,
        1,
        "inline composite tag",
      );
      const tag = this.readWord(resolved.segmentId, targetWord);
      const tagKind = Number(tag & 0x3n);
      if (tagKind !== 0) {
        throw new Error("invalid inline composite tag kind " + tagKind);
      }
      const elementCount = Number((tag >> 2n) & MASK_30);
      const dataWordCount = Number((tag >> 32n) & 0xffffn);
      const pointerCount = Number((tag >> 48n) & 0xffffn);
      const stride = dataWordCount + pointerCount;
      if (stride * elementCount > count) {
        throw new Error("inline composite payload exceeds declared word count");
      }
      this.requireWordRange(
        resolved.segmentId,
        targetWord + 1,
        count,
        "inline composite payload",
      );
      return {
        kind: "inlineComposite",
        segmentId: resolved.segmentId,
        tagWord: targetWord,
        elementCount,
        dataWordCount,
        pointerCount,
        wordsInElements: count,
      };
    }

    const words = this.flatListWords(elementSize, count);
    this.requireWordRange(
      resolved.segmentId,
      targetWord,
      words,
      "list payload",
    );
    return {
      kind: "flat",
      segmentId: resolved.segmentId,
      startWord: targetWord,
      elementSize,
      elementCount: count,
    };
  }

  readResolvedPointerWord(segmentId: number, pointerWord: number): bigint {
    return this.readResolvedPointer(segmentId, pointerWord).word;
  }

  readResolvedPointer(segmentId: number, pointerWord: number): ResolvedPointer {
    return this.resolvePointer(segmentId, pointerWord);
  }

  pointerWordIndex(structRef: StructRef, pointerOffset: number): number {
    if (pointerOffset < 0 || pointerOffset >= structRef.pointerCount) {
      throw new Error("pointer offset out of range: " + pointerOffset);
    }
    return structRef.startWord + structRef.dataWordCount + pointerOffset;
  }

  readBool(structRef: StructRef, bitOffset: number): boolean {
    const byteOffset = Math.floor(bitOffset / 8);
    const bit = bitOffset % 8;
    const value = this.readUint8InStruct(structRef, byteOffset);
    return (value & (1 << bit)) !== 0;
  }

  readUint8InStruct(structRef: StructRef, byteOffset: number): number {
    return this.readUint8At(
      structRef.segmentId,
      structRef.startWord * WORD_BYTES + byteOffset,
      structRef.dataWordCount * WORD_BYTES,
      "readUint8InStruct",
    );
  }

  readInt8InStruct(structRef: StructRef, byteOffset: number): number {
    return this.readInt8At(
      structRef.segmentId,
      structRef.startWord * WORD_BYTES + byteOffset,
      structRef.dataWordCount * WORD_BYTES,
      "readInt8InStruct",
    );
  }

  readUint16InStruct(structRef: StructRef, byteOffset: number): number {
    return this.readUint16At(
      structRef.segmentId,
      structRef.startWord * WORD_BYTES + byteOffset,
      structRef.dataWordCount * WORD_BYTES,
      "readUint16InStruct",
    );
  }

  readInt16InStruct(structRef: StructRef, byteOffset: number): number {
    return this.readInt16At(
      structRef.segmentId,
      structRef.startWord * WORD_BYTES + byteOffset,
      structRef.dataWordCount * WORD_BYTES,
      "readInt16InStruct",
    );
  }

  readUint32InStruct(structRef: StructRef, byteOffset: number): number {
    return this.readUint32At(
      structRef.segmentId,
      structRef.startWord * WORD_BYTES + byteOffset,
      structRef.dataWordCount * WORD_BYTES,
      "readUint32InStruct",
    );
  }

  readInt32InStruct(structRef: StructRef, byteOffset: number): number {
    return this.readInt32At(
      structRef.segmentId,
      structRef.startWord * WORD_BYTES + byteOffset,
      structRef.dataWordCount * WORD_BYTES,
      "readInt32InStruct",
    );
  }

  readBigUint64InStruct(structRef: StructRef, byteOffset: number): bigint {
    return this.readBigUint64At(
      structRef.segmentId,
      structRef.startWord * WORD_BYTES + byteOffset,
      structRef.dataWordCount * WORD_BYTES,
      "readBigUint64InStruct",
    );
  }

  readBigInt64InStruct(structRef: StructRef, byteOffset: number): bigint {
    return this.readBigInt64At(
      structRef.segmentId,
      structRef.startWord * WORD_BYTES + byteOffset,
      structRef.dataWordCount * WORD_BYTES,
      "readBigInt64InStruct",
    );
  }

  readFloat32InStruct(structRef: StructRef, byteOffset: number): number {
    return this.readFloat32At(
      structRef.segmentId,
      structRef.startWord * WORD_BYTES + byteOffset,
      structRef.dataWordCount * WORD_BYTES,
      "readFloat32InStruct",
    );
  }

  readFloat64InStruct(structRef: StructRef, byteOffset: number): number {
    return this.readFloat64At(
      structRef.segmentId,
      structRef.startWord * WORD_BYTES + byteOffset,
      structRef.dataWordCount * WORD_BYTES,
      "readFloat64InStruct",
    );
  }

  readTextPointer(segmentId: number, pointerWord: number): string | null {
    const list = this.readListPointer(segmentId, pointerWord);
    if (!list) return null;
    if (list.kind !== "flat" || list.elementSize !== 2) {
      throw new Error("expected byte list pointer for text");
    }
    const bytes = this.readBytes(
      list.segmentId,
      list.startWord * WORD_BYTES,
      list.elementCount,
    );
    if (bytes.byteLength === 0) return "";
    const withoutNul = bytes[bytes.byteLength - 1] === 0
      ? bytes.subarray(0, bytes.byteLength - 1)
      : bytes;
    return TEXT_DECODER.decode(withoutNul);
  }

  readDataPointer(segmentId: number, pointerWord: number): Uint8Array | null {
    const list = this.readListPointer(segmentId, pointerWord);
    if (!list) return null;
    if (list.kind !== "flat" || list.elementSize !== 2) {
      throw new Error("expected byte list pointer for data");
    }
    return this.readBytes(
      list.segmentId,
      list.startWord * WORD_BYTES,
      list.elementCount,
    );
  }

  readWord(segmentId: number, wordIndex: number): bigint {
    this.requireWordRange(segmentId, wordIndex, 1, "readWord");
    return this.segmentView(segmentId).getBigUint64(
      wordIndex * WORD_BYTES,
      true,
    );
  }

  private resolvePointer(
    segmentId: number,
    pointerWord: number,
  ): ResolvedPointer {
    let currentSegmentId = segmentId;
    let currentPointerWord = pointerWord;
    let word = this.readWord(currentSegmentId, currentPointerWord);

    for (let hops = 0; hops < 8; hops += 1) {
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
        word = this.readWord(currentSegmentId, currentPointerWord);
        continue;
      }

      this.requireWordRange(
        landingSegmentId,
        landingPadWord,
        2,
        "double-far landing pad",
      );
      const pad0 = this.readWord(landingSegmentId, landingPadWord);
      const pad0Kind = Number(pad0 & 0x3n);
      if (pad0Kind !== 2) {
        throw new Error(
          "double-far landing pad[0] must be far pointer, got kind " + pad0Kind,
        );
      }
      const pad0IsDoubleFar = ((pad0 >> 2n) & 0x1n) === 1n;
      if (pad0IsDoubleFar) {
        throw new Error("double-far landing pad[0] must be single-far pointer");
      }
      const pad0Offset = Number((pad0 >> 3n) & MASK_29);
      const pad0SegmentId = Number((pad0 >> 32n) & 0xffff_ffffn);

      return {
        segmentId: pad0SegmentId,
        pointerWord: pad0Offset - 1,
        word: this.readWord(landingSegmentId, landingPadWord + 1),
      };
    }

    throw new Error("far pointer chain exceeded maximum hop count");
  }

  readUint8At(
    segmentId: number,
    byteOffset: number,
    maxLen: number,
    context: string,
  ): number {
    this.requireDataByteRange(segmentId, byteOffset, 1, maxLen, context);
    return this.segmentView(segmentId).getUint8(byteOffset);
  }

  readInt8At(
    segmentId: number,
    byteOffset: number,
    maxLen: number,
    context: string,
  ): number {
    this.requireDataByteRange(segmentId, byteOffset, 1, maxLen, context);
    return this.segmentView(segmentId).getInt8(byteOffset);
  }

  readUint16At(
    segmentId: number,
    byteOffset: number,
    maxLen: number,
    context: string,
  ): number {
    this.requireDataByteRange(segmentId, byteOffset, 2, maxLen, context);
    return this.segmentView(segmentId).getUint16(byteOffset, true);
  }

  readInt16At(
    segmentId: number,
    byteOffset: number,
    maxLen: number,
    context: string,
  ): number {
    this.requireDataByteRange(segmentId, byteOffset, 2, maxLen, context);
    return this.segmentView(segmentId).getInt16(byteOffset, true);
  }

  readUint32At(
    segmentId: number,
    byteOffset: number,
    maxLen: number,
    context: string,
  ): number {
    this.requireDataByteRange(segmentId, byteOffset, 4, maxLen, context);
    return this.segmentView(segmentId).getUint32(byteOffset, true);
  }

  readInt32At(
    segmentId: number,
    byteOffset: number,
    maxLen: number,
    context: string,
  ): number {
    this.requireDataByteRange(segmentId, byteOffset, 4, maxLen, context);
    return this.segmentView(segmentId).getInt32(byteOffset, true);
  }

  readBigUint64At(
    segmentId: number,
    byteOffset: number,
    maxLen: number,
    context: string,
  ): bigint {
    this.requireDataByteRange(segmentId, byteOffset, 8, maxLen, context);
    return this.segmentView(segmentId).getBigUint64(byteOffset, true);
  }

  readBigInt64At(
    segmentId: number,
    byteOffset: number,
    maxLen: number,
    context: string,
  ): bigint {
    this.requireDataByteRange(segmentId, byteOffset, 8, maxLen, context);
    return this.segmentView(segmentId).getBigInt64(byteOffset, true);
  }

  readFloat32At(
    segmentId: number,
    byteOffset: number,
    maxLen: number,
    context: string,
  ): number {
    this.requireDataByteRange(segmentId, byteOffset, 4, maxLen, context);
    return this.segmentView(segmentId).getFloat32(byteOffset, true);
  }

  readFloat64At(
    segmentId: number,
    byteOffset: number,
    maxLen: number,
    context: string,
  ): number {
    this.requireDataByteRange(segmentId, byteOffset, 8, maxLen, context);
    return this.segmentView(segmentId).getFloat64(byteOffset, true);
  }

  readBytes(segmentId: number, byteOffset: number, len: number): Uint8Array {
    const segment = this.segment(segmentId);
    if (byteOffset < 0 || len < 0 || byteOffset + len > segment.byteLength) {
      throw new Error(
        "readBytes out of range: segment=" + segmentId + " offset=" +
          byteOffset + " len=" + len,
      );
    }
    return segment.subarray(byteOffset, byteOffset + len);
  }

  private requireWordRange(
    segmentId: number,
    wordIndex: number,
    count: number,
    context: string,
  ): void {
    const segmentWords = this.segment(segmentId).byteLength / WORD_BYTES;
    if (wordIndex < 0 || count < 0 || wordIndex + count > segmentWords) {
      throw new Error(
        context + " out of range: segment=" + segmentId + " word=" + wordIndex +
          " count=" +
          count + " words=" + segmentWords,
      );
    }
  }

  private requireDataByteRange(
    segmentId: number,
    byteOffset: number,
    len: number,
    maxLen: number,
    context: string,
  ): void {
    const segment = this.segment(segmentId);
    if (byteOffset < 0 || len < 0 || byteOffset + len > segment.byteLength) {
      throw new Error(
        context + " segment range error: segment=" + segmentId + " offset=" +
          byteOffset +
          " len=" + len + " segmentBytes=" + segment.byteLength,
      );
    }
    if (
      byteOffset + len >
        (Math.floor(byteOffset / WORD_BYTES) * WORD_BYTES + maxLen)
    ) {
      throw new Error(context + " struct/list bounds exceeded");
    }
  }

  private flatListWords(elementSize: number, count: number): number {
    switch (elementSize) {
      case 0:
        return 0;
      case 1:
        return Math.ceil(count / 64);
      case 2:
        return bytesToWords(count);
      case 3:
        return bytesToWords(count * 2);
      case 4:
        return bytesToWords(count * 4);
      case 5:
      case 6:
        return count;
      default:
        throw new Error("unsupported list element size: " + elementSize);
    }
  }

  private segment(segmentId: number): Uint8Array {
    const segment = this.segments[segmentId];
    if (!segment) throw new Error("missing segment " + segmentId);
    return segment;
  }

  private segmentView(segmentId: number): DataView {
    const segment = this.segment(segmentId);
    return new DataView(segment.buffer, segment.byteOffset, segment.byteLength);
  }
}
