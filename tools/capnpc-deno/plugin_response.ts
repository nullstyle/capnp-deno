const WORD_BYTES = 8;
const MASK_30 = 0x3fff_ffffn;
const TEXT_ENCODER = new TextEncoder();

export interface PluginResponseFile {
  id?: bigint | number;
  filename: string;
  content: string;
}

export function encodeCodeGeneratorResponse(
  files: readonly PluginResponseFile[],
): Uint8Array {
  const builder = new MessageBuilder();
  const rootWord = builder.allocWords(1);
  builder.setStructPointer(0, rootWord, 0, 1);

  if (files.length > 0) {
    const elementDataWords = 1;
    const elementPointerCount = 2;
    const elementStrideWords = elementDataWords + elementPointerCount;
    const elementsWords = files.length * elementStrideWords;
    const listWord = builder.allocWords(1 + elementsWords);
    builder.setListPointer(rootWord, listWord, 7, elementsWords);

    // Inline-composite tag word: kind=struct, offset=element count.
    const tagWord = (BigInt(files.length) << 2n) |
      (BigInt(elementDataWords) << 32n) |
      (BigInt(elementPointerCount) << 48n);
    builder.writeWord(listWord, tagWord);

    for (let i = 0; i < files.length; i += 1) {
      const elementWord = listWord + 1 + (i * elementStrideWords);
      const file = files[i];
      builder.writeBigUint64(elementWord, normalizeId(file.id));
      builder.writeTextPointer(elementWord + 1, file.filename);
      builder.writeTextPointer(elementWord + 2, file.content);
    }
  }

  return builder.toMessageBytes();
}

function normalizeId(id: PluginResponseFile["id"]): bigint {
  if (id === undefined) return 0n;
  if (typeof id === "bigint") {
    if (id < 0n || id > 0xffff_ffff_ffff_ffffn) {
      throw new Error(`response file id is out of u64 range: ${id}`);
    }
    return id;
  }
  if (!Number.isInteger(id) || id < 0 || id > Number.MAX_SAFE_INTEGER) {
    throw new Error(`response file id must be a non-negative safe integer: ${id}`);
  }
  return BigInt(id);
}

function bytesToWords(bytes: number): number {
  return Math.ceil(bytes / WORD_BYTES);
}

function encodeSigned30(value: number): bigint {
  if (!Number.isInteger(value) || value < -(1 << 29) || value > (1 << 29) - 1) {
    throw new Error(`pointer offset is out of signed 30-bit range: ${value}`);
  }
  return BigInt(value < 0 ? value + (1 << 30) : value) & MASK_30;
}

class MessageBuilder {
  private bytes: Uint8Array;
  private words: number;

  constructor() {
    this.bytes = new Uint8Array(WORD_BYTES);
    this.words = 1;
  }

  allocWords(count: number): number {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`allocWords requires non-negative integer, got: ${count}`);
    }
    const start = this.words;
    this.words += count;
    this.ensureCapacity(this.words * WORD_BYTES);
    return start;
  }

  writeWord(wordIndex: number, value: bigint): void {
    this.requireWordRange(wordIndex, 1, "writeWord");
    this.view().setBigUint64(wordIndex * WORD_BYTES, value, true);
  }

  writeBigUint64(byteWordIndex: number, value: bigint): void {
    this.requireWordRange(byteWordIndex, 1, "writeBigUint64");
    this.view().setBigUint64(byteWordIndex * WORD_BYTES, value, true);
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
    const bytesWithNul = encoded.byteLength + 1;
    const targetWord = this.allocWords(bytesToWords(bytesWithNul));
    const startByte = targetWord * WORD_BYTES;
    this.requireByteRange(startByte, bytesWithNul, "writeTextPointer");
    this.bytes.set(encoded, startByte);
    this.bytes[startByte + encoded.byteLength] = 0;
    this.setListPointer(pointerWord, targetWord, 2, bytesWithNul);
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
    return new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  private requireWordRange(wordIndex: number, count: number, context: string): void {
    if (wordIndex < 0 || count < 0 || wordIndex + count > this.words) {
      throw new Error(
        `${context} out of range: word=${wordIndex} count=${count} words=${this.words}`,
      );
    }
  }

  private requireByteRange(offset: number, len: number, context: string): void {
    const max = this.words * WORD_BYTES;
    if (offset < 0 || len < 0 || offset + len > max) {
      throw new Error(
        `${context} out of range: offset=${offset} len=${len} max=${max}`,
      );
    }
  }
}
