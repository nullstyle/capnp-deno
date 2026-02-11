/**
 * Shared runtime for generated Cap'n Proto _capnp.ts modules.
 *
 * @module
 */

export interface StructCodec<T> {
  encode(value: T): Uint8Array;
  decode(bytes: Uint8Array): T;
}

export interface CapabilityPointer {
  capabilityIndex: number;
}

/**
 * Shared RPC `finish` options used by generated client transports.
 */
export type AnyPointerValue =
  | { kind: "null" }
  | { kind: "interface"; capabilityIndex: number };

export type PrimitiveTypeKind =
  | "void"
  | "bool"
  | "int8"
  | "int16"
  | "int32"
  | "int64"
  | "uint8"
  | "uint16"
  | "uint32"
  | "uint64"
  | "float32"
  | "float64";

export interface PrimitiveTypeDescriptor {
  kind: PrimitiveTypeKind;
}

export interface EnumTypeDescriptor<T extends string = string> {
  kind: "enum";
  byOrdinal: readonly T[];
  toOrdinal: Readonly<Record<T, number>>;
}

export interface StructTypeDescriptor {
  kind: "struct";
  // deno-lint-ignore no-explicit-any
  get: () => StructDescriptor<any>;
}

export interface ListTypeDescriptor {
  kind: "list";
  element: TypeDescriptor;
}

export interface TextTypeDescriptor {
  kind: "text";
}

export interface DataTypeDescriptor {
  kind: "data";
}

export interface InterfaceTypeDescriptor {
  kind: "interface";
}

export interface AnyPointerTypeDescriptor {
  kind: "anyPointer";
}

export type TypeDescriptor =
  | PrimitiveTypeDescriptor
  | EnumTypeDescriptor
  | StructTypeDescriptor
  | ListTypeDescriptor
  | TextTypeDescriptor
  | DataTypeDescriptor
  | InterfaceTypeDescriptor
  | AnyPointerTypeDescriptor;

export interface SlotFieldDescriptor<T extends object> {
  kind: "slot";
  name: keyof T & string;
  offset: number;
  type: TypeDescriptor;
  discriminantValue?: number;
}

export interface GroupFieldDescriptor<T extends object> {
  kind: "group";
  name: keyof T & string;
  type: StructTypeDescriptor;
  discriminantValue?: number;
}

export type FieldDescriptor<T extends object> =
  | SlotFieldDescriptor<T>
  | GroupFieldDescriptor<T>;

export interface StructUnionDescriptor<T extends object> {
  discriminantOffset: number;
  defaultDiscriminant: number;
  byName: Readonly<Partial<Record<keyof T & string, number>>>;
  byDiscriminant: Readonly<Record<number, keyof T & string>>;
}

export interface StructDescriptor<T extends object> {
  kind: "struct";
  name: string;
  dataWordCount: number;
  pointerCount: number;
  fields: readonly FieldDescriptor<T>[];
  createDefault: () => T;
  union?: StructUnionDescriptor<T>;
}

export const TYPE_VOID: PrimitiveTypeDescriptor = { kind: "void" };
export const TYPE_BOOL: PrimitiveTypeDescriptor = { kind: "bool" };
export const TYPE_INT8: PrimitiveTypeDescriptor = { kind: "int8" };
export const TYPE_INT16: PrimitiveTypeDescriptor = { kind: "int16" };
export const TYPE_INT32: PrimitiveTypeDescriptor = { kind: "int32" };
export const TYPE_INT64: PrimitiveTypeDescriptor = { kind: "int64" };
export const TYPE_UINT8: PrimitiveTypeDescriptor = { kind: "uint8" };
export const TYPE_UINT16: PrimitiveTypeDescriptor = { kind: "uint16" };
export const TYPE_UINT32: PrimitiveTypeDescriptor = { kind: "uint32" };
export const TYPE_UINT64: PrimitiveTypeDescriptor = { kind: "uint64" };
export const TYPE_FLOAT32: PrimitiveTypeDescriptor = { kind: "float32" };
export const TYPE_FLOAT64: PrimitiveTypeDescriptor = { kind: "float64" };
export const TYPE_TEXT: TextTypeDescriptor = { kind: "text" };
export const TYPE_DATA: DataTypeDescriptor = { kind: "data" };
export const TYPE_INTERFACE: InterfaceTypeDescriptor = { kind: "interface" };
export const TYPE_ANY_POINTER: AnyPointerTypeDescriptor = {
  kind: "anyPointer",
};

export const WORD_BYTES = 8;
export const MASK_30 = 0x3fff_ffffn;
export const MASK_29 = 0x1fff_ffffn;
export const TEXT_ENCODER: TextEncoder = new TextEncoder();
export const TEXT_DECODER: TextDecoder = new TextDecoder();

export function bytesToWords(bytes: number): number {
  return Math.ceil(bytes / WORD_BYTES);
}

export function signed30(raw: bigint): number {
  const value = Number(raw & MASK_30);
  return (value & (1 << 29)) !== 0 ? value - (1 << 30) : value;
}

export function encodeSigned30(value: number): bigint {
  if (!Number.isInteger(value) || value < -(1 << 29) || value > (1 << 29) - 1) {
    throw new Error("pointer offset is out of signed 30-bit range: " + value);
  }
  return BigInt(value < 0 ? value + (1 << 30) : value) & MASK_30;
}

export function isDataType(type: TypeDescriptor): boolean {
  switch (type.kind) {
    case "void":
    case "bool":
    case "int8":
    case "int16":
    case "int32":
    case "int64":
    case "uint8":
    case "uint16":
    case "uint32":
    case "uint64":
    case "float32":
    case "float64":
    case "enum":
      return true;
    default:
      return false;
  }
}

export function isPointerType(type: TypeDescriptor): boolean {
  return !isDataType(type);
}

export function dataByteOffset(type: TypeDescriptor, offset: number): number {
  switch (type.kind) {
    case "int8":
    case "uint8":
      return offset;
    case "int16":
    case "uint16":
    case "enum":
      return offset * 2;
    case "int32":
    case "uint32":
    case "float32":
      return offset * 4;
    case "int64":
    case "uint64":
    case "float64":
      return offset * 8;
    default:
      return offset;
  }
}

export function listElementSize(type: TypeDescriptor): number {
  switch (type.kind) {
    case "void":
      return 0;
    case "bool":
      return 1;
    case "int8":
    case "uint8":
      return 2;
    case "int16":
    case "uint16":
    case "enum":
      return 3;
    case "int32":
    case "uint32":
    case "float32":
      return 4;
    case "int64":
    case "uint64":
    case "float64":
      return 5;
    case "text":
    case "data":
    case "list":
    case "interface":
    case "anyPointer":
      return 6;
    case "struct":
      return 7;
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

export function asBoolean(value: unknown): boolean {
  return value === true;
}

export function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function asBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && value.length > 0) {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asUint8Array(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(0);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function capabilityIndexFrom(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const index = record.capabilityIndex;
    if (typeof index === "number" && Number.isInteger(index) && index >= 0) {
      return index;
    }
  }
  throw new Error("invalid capability pointer value");
}

export function asAnyPointerValue(value: unknown): AnyPointerValue {
  if (value === null || value === undefined) {
    return { kind: "null" };
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (record.kind === "null") return { kind: "null" };
    if (record.kind === "interface") {
      const index = capabilityIndexFrom(record.capabilityIndex);
      if (index === null) return { kind: "null" };
      return { kind: "interface", capabilityIndex: index };
    }
  }
  const index = capabilityIndexFrom(value);
  if (index === null) return { kind: "null" };
  return { kind: "interface", capabilityIndex: index };
}

export function encodeCapabilityPointerWord(capabilityIndex: number): bigint {
  if (!Number.isInteger(capabilityIndex) || capabilityIndex < 0) {
    throw new Error("capabilityIndex must be a non-negative integer");
  }
  if (capabilityIndex > 0xffff_ffff) {
    throw new Error("capabilityIndex is out of 32-bit range");
  }
  return 0x3n | (BigInt(capabilityIndex) << 32n);
}

export function decodeCapabilityPointerWord(word: bigint): CapabilityPointer {
  const kind = Number(word & 0x3n);
  if (kind !== 3) throw new Error("expected capability pointer kind=3");
  const capabilityIndex = Number((word >> 32n) & 0xffff_ffffn);
  return { capabilityIndex };
}

export function defaultValueForType(type: TypeDescriptor): unknown {
  switch (type.kind) {
    case "void":
      return undefined;
    case "bool":
      return false;
    case "int8":
    case "int16":
    case "int32":
    case "uint8":
    case "uint16":
    case "uint32":
    case "float32":
    case "float64":
      return 0;
    case "int64":
    case "uint64":
      return 0n;
    case "enum":
      return type.byOrdinal[0];
    case "text":
      return "";
    case "data":
      return new Uint8Array(0);
    case "list":
      return [];
    case "struct":
      return type.get().createDefault();
    case "interface":
      return null;
    case "anyPointer":
      return { kind: "null" };
  }
}

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
    return this.resolvePointer(segmentId, pointerWord).word;
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

      currentSegmentId = pad0SegmentId;
      currentPointerWord = pad0Offset;
      word = this.readWord(landingSegmentId, landingPadWord + 1);
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

export function enumOrdinal(type: EnumTypeDescriptor, value: unknown): number {
  if (typeof value !== "string") return 0;
  const ordinal = (type.toOrdinal as Record<string, number>)[value];
  return typeof ordinal === "number" ? ordinal : 0;
}

export function enumValue(type: EnumTypeDescriptor, ordinal: number): string {
  if (ordinal >= 0 && ordinal < type.byOrdinal.length) {
    return type.byOrdinal[ordinal];
  }
  return type.byOrdinal[0] ?? "";
}

export function isPresentField(
  record: Record<string, unknown>,
  name: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(record, name) &&
    record[name] !== undefined;
}

export function resolveActiveDiscriminant<T extends object>(
  descriptor: StructDescriptor<T>,
  record: Record<string, unknown>,
): number | undefined {
  const union = descriptor.union;
  if (!union) return undefined;

  const which = record["which"];
  if (typeof which === "string") {
    const mapped = (union.byName as Record<string, number>)[which];
    if (typeof mapped === "number") return mapped;
  }

  for (const field of descriptor.fields) {
    if (field.discriminantValue === undefined) continue;
    if (isPresentField(record, field.name)) return field.discriminantValue;
  }
  return union.defaultDiscriminant;
}

export function encodeStructMessage<T extends object>(
  descriptor: StructDescriptor<T>,
  value: T,
): Uint8Array {
  const builder = new MessageBuilder();
  const structWord = builder.allocWords(
    descriptor.dataWordCount + descriptor.pointerCount,
  );
  builder.setStructPointer(
    0,
    structWord,
    descriptor.dataWordCount,
    descriptor.pointerCount,
  );
  encodeStructAt(builder, descriptor, structWord, value);
  return builder.toMessageBytes();
}

export function decodeStructMessage<T extends object>(
  descriptor: StructDescriptor<T>,
  bytes: Uint8Array,
): T {
  const reader = new MessageReader(bytes);
  const root = reader.readStructPointer(0, 0);
  if (!root) {
    return descriptor.createDefault();
  }
  return decodeStructAt(reader, descriptor, root);
}

export function encodeStructAt<T extends object>(
  builder: MessageBuilder,
  descriptor: StructDescriptor<T>,
  structWord: number,
  value: T,
): void {
  const record = asRecord(value);
  const activeDiscriminant = resolveActiveDiscriminant(descriptor, record);
  if (descriptor.union && activeDiscriminant !== undefined) {
    const byteOffset = (structWord * WORD_BYTES) +
      (descriptor.union.discriminantOffset * 2);
    builder.writeUint16(byteOffset, activeDiscriminant);
  }

  for (const field of descriptor.fields) {
    if (
      field.discriminantValue !== undefined &&
      activeDiscriminant !== undefined &&
      field.discriminantValue !== activeDiscriminant
    ) {
      continue;
    }

    const fieldValue = record[field.name];
    if (field.kind === "group") {
      encodeStructAt(
        builder,
        field.type.get(),
        structWord,
        asRecord(fieldValue),
      );
      continue;
    }

    if (isDataType(field.type)) {
      encodeDataField(
        builder,
        structWord,
        field.offset,
        field.type,
        fieldValue,
      );
      continue;
    }
    const pointerWord = builder.pointerWordIndex(
      structWord,
      descriptor.dataWordCount,
      field.offset,
    );
    encodePointerField(builder, pointerWord, field.type, fieldValue);
  }
}

export function decodeStructAt<T extends object>(
  reader: MessageReader,
  descriptor: StructDescriptor<T>,
  structRef: StructRef,
): T {
  const out = descriptor.createDefault();
  const record = out as Record<string, unknown>;
  const activeDiscriminant = descriptor.union
    ? reader.readUint16InStruct(
      structRef,
      descriptor.union.discriminantOffset * 2,
    )
    : undefined;

  if (descriptor.union && activeDiscriminant !== undefined) {
    const tag = (descriptor.union.byDiscriminant as Record<number, string>)[
      activeDiscriminant
    ];
    if (typeof tag === "string") record["which"] = tag;
  }

  for (const field of descriptor.fields) {
    if (
      field.discriminantValue !== undefined &&
      activeDiscriminant !== undefined &&
      field.discriminantValue !== activeDiscriminant
    ) {
      continue;
    }

    if (field.kind === "group") {
      record[field.name] = decodeStructAt(reader, field.type.get(), structRef);
      continue;
    }

    if (isDataType(field.type)) {
      record[field.name] = decodeDataField(
        reader,
        structRef,
        field.offset,
        field.type,
      );
      continue;
    }
    const pointerWord = reader.pointerWordIndex(structRef, field.offset);
    record[field.name] = decodePointerField(
      reader,
      structRef.segmentId,
      pointerWord,
      field.type,
    );
  }
  return out;
}

export function encodeDataField(
  builder: MessageBuilder,
  structWord: number,
  offset: number,
  type: TypeDescriptor,
  value: unknown,
): void {
  const base = structWord * WORD_BYTES;
  switch (type.kind) {
    case "void":
      return;
    case "bool": {
      const byteOffset = base + Math.floor(offset / 8);
      const bitOffset = offset % 8;
      builder.setBool(byteOffset, bitOffset, asBoolean(value));
      return;
    }
    case "int8":
      builder.writeInt8(base + dataByteOffset(type, offset), asNumber(value));
      return;
    case "int16":
      builder.writeInt16(base + dataByteOffset(type, offset), asNumber(value));
      return;
    case "int32":
      builder.writeInt32(base + dataByteOffset(type, offset), asNumber(value));
      return;
    case "int64":
      builder.writeBigInt64(
        base + dataByteOffset(type, offset),
        asBigInt(value),
      );
      return;
    case "uint8":
      builder.writeUint8(base + dataByteOffset(type, offset), asNumber(value));
      return;
    case "uint16":
      builder.writeUint16(base + dataByteOffset(type, offset), asNumber(value));
      return;
    case "uint32":
      builder.writeUint32(base + dataByteOffset(type, offset), asNumber(value));
      return;
    case "uint64":
      builder.writeBigUint64(
        base + dataByteOffset(type, offset),
        asBigInt(value),
      );
      return;
    case "float32":
      builder.writeFloat32(
        base + dataByteOffset(type, offset),
        asNumber(value),
      );
      return;
    case "float64":
      builder.writeFloat64(
        base + dataByteOffset(type, offset),
        asNumber(value),
      );
      return;
    case "enum":
      builder.writeUint16(
        base + dataByteOffset(type, offset),
        enumOrdinal(type, value),
      );
      return;
    default:
      throw new Error("unexpected pointer type in data field: " + type.kind);
  }
}

export function decodeDataField(
  reader: MessageReader,
  structRef: StructRef,
  offset: number,
  type: TypeDescriptor,
): unknown {
  switch (type.kind) {
    case "void":
      return undefined;
    case "bool":
      return reader.readBool(structRef, offset);
    case "int8":
      return reader.readInt8InStruct(structRef, dataByteOffset(type, offset));
    case "int16":
      return reader.readInt16InStruct(structRef, dataByteOffset(type, offset));
    case "int32":
      return reader.readInt32InStruct(structRef, dataByteOffset(type, offset));
    case "int64":
      return reader.readBigInt64InStruct(
        structRef,
        dataByteOffset(type, offset),
      );
    case "uint8":
      return reader.readUint8InStruct(structRef, dataByteOffset(type, offset));
    case "uint16":
      return reader.readUint16InStruct(structRef, dataByteOffset(type, offset));
    case "uint32":
      return reader.readUint32InStruct(structRef, dataByteOffset(type, offset));
    case "uint64":
      return reader.readBigUint64InStruct(
        structRef,
        dataByteOffset(type, offset),
      );
    case "float32":
      return reader.readFloat32InStruct(
        structRef,
        dataByteOffset(type, offset),
      );
    case "float64":
      return reader.readFloat64InStruct(
        structRef,
        dataByteOffset(type, offset),
      );
    case "enum": {
      const ordinal = reader.readUint16InStruct(
        structRef,
        dataByteOffset(type, offset),
      );
      return enumValue(type, ordinal);
    }
    default:
      throw new Error("unexpected pointer type in data field: " + type.kind);
  }
}

export function encodePointerField(
  builder: MessageBuilder,
  pointerWord: number,
  type: TypeDescriptor,
  value: unknown,
): void {
  if (value === undefined || value === null) {
    builder.writeWord(pointerWord, 0n);
    return;
  }

  switch (type.kind) {
    case "text":
      builder.writeTextPointer(pointerWord, asString(value));
      return;
    case "data":
      builder.writeDataPointer(pointerWord, asUint8Array(value));
      return;
    case "struct": {
      const descriptor = type.get();
      const structWord = builder.allocWords(
        descriptor.dataWordCount + descriptor.pointerCount,
      );
      builder.setStructPointer(
        pointerWord,
        structWord,
        descriptor.dataWordCount,
        descriptor.pointerCount,
      );
      encodeStructAt(
        builder,
        descriptor,
        structWord,
        value as Record<string, unknown>,
      );
      return;
    }
    case "list":
      encodeListField(builder, pointerWord, type.element, asArray(value));
      return;
    case "interface": {
      const capabilityIndex = capabilityIndexFrom(value);
      if (capabilityIndex === null) {
        builder.writeWord(pointerWord, 0n);
        return;
      }
      builder.writeWord(
        pointerWord,
        encodeCapabilityPointerWord(capabilityIndex),
      );
      return;
    }
    case "anyPointer": {
      const pointer = asAnyPointerValue(value);
      if (pointer.kind === "null") {
        builder.writeWord(pointerWord, 0n);
        return;
      }
      builder.writeWord(
        pointerWord,
        encodeCapabilityPointerWord(pointer.capabilityIndex),
      );
      return;
    }
    default:
      throw new Error("unexpected data type in pointer field: " + type.kind);
  }
}

export function decodePointerField(
  reader: MessageReader,
  segmentId: number,
  pointerWord: number,
  type: TypeDescriptor,
): unknown {
  switch (type.kind) {
    case "text":
      return reader.readTextPointer(segmentId, pointerWord) ?? "";
    case "data":
      return reader.readDataPointer(segmentId, pointerWord) ??
        new Uint8Array(0);
    case "struct": {
      const ref = reader.readStructPointer(segmentId, pointerWord);
      if (!ref) return type.get().createDefault();
      return decodeStructAt(reader, type.get(), ref);
    }
    case "list":
      return decodeListField(reader, segmentId, pointerWord, type.element);
    case "interface": {
      const word = reader.readResolvedPointerWord(segmentId, pointerWord);
      if (word === 0n) return null;
      return decodeCapabilityPointerWord(word);
    }
    case "anyPointer": {
      const word = reader.readResolvedPointerWord(segmentId, pointerWord);
      if (word === 0n) return { kind: "null" } as AnyPointerValue;
      const kind = Number(word & 0x3n);
      if (kind === 3) {
        const cap = decodeCapabilityPointerWord(word);
        return {
          kind: "interface",
          capabilityIndex: cap.capabilityIndex,
        } as AnyPointerValue;
      }
      throw new Error(
        "anyPointer decode currently supports null or interface pointers only",
      );
    }
    default:
      throw new Error("unexpected data type in pointer field: " + type.kind);
  }
}

export function encodeListField(
  builder: MessageBuilder,
  pointerWord: number,
  elementType: TypeDescriptor,
  values: unknown[],
): void {
  if (elementType.kind === "void") {
    builder.setListPointer(pointerWord, pointerWord + 1, 0, values.length);
    return;
  }
  if (elementType.kind === "struct") {
    const descriptor = elementType.get();
    const stride = descriptor.dataWordCount + descriptor.pointerCount;
    const wordsInElements = stride * values.length;
    const startWord = builder.allocWords(1 + wordsInElements);
    const tag = (BigInt(values.length) << 2n) |
      (BigInt(descriptor.dataWordCount) << 32n) |
      (BigInt(descriptor.pointerCount) << 48n);
    builder.writeWord(startWord, tag);
    for (let i = 0; i < values.length; i += 1) {
      const elementWord = startWord + 1 + (i * stride);
      encodeStructAt(
        builder,
        descriptor,
        elementWord,
        values[i] as Record<string, unknown>,
      );
    }
    builder.setListPointer(pointerWord, startWord, 7, wordsInElements);
    return;
  }
  if (isPointerType(elementType)) {
    const startWord = builder.allocWords(values.length);
    for (let i = 0; i < values.length; i += 1) {
      encodePointerField(builder, startWord + i, elementType, values[i]);
    }
    builder.setListPointer(pointerWord, startWord, 6, values.length);
    return;
  }

  const elementSize = listElementSize(elementType);
  switch (elementSize) {
    case 1: {
      const startWord = builder.allocWords(Math.ceil(values.length / 64));
      const baseByte = startWord * WORD_BYTES;
      for (let i = 0; i < values.length; i += 1) {
        const byteOffset = baseByte + Math.floor(i / 8);
        const bitOffset = i % 8;
        builder.setBool(byteOffset, bitOffset, asBoolean(values[i]));
      }
      builder.setListPointer(pointerWord, startWord, 1, values.length);
      return;
    }
    case 2: {
      const startWord = builder.allocWords(bytesToWords(values.length));
      const baseByte = startWord * WORD_BYTES;
      for (let i = 0; i < values.length; i += 1) {
        const byteOffset = baseByte + i;
        if (elementType.kind === "int8") {
          builder.writeInt8(byteOffset, asNumber(values[i]));
        } else {
          builder.writeUint8(byteOffset, asNumber(values[i]));
        }
      }
      builder.setListPointer(pointerWord, startWord, 2, values.length);
      return;
    }
    case 3: {
      const startWord = builder.allocWords(bytesToWords(values.length * 2));
      const baseByte = startWord * WORD_BYTES;
      for (let i = 0; i < values.length; i += 1) {
        const byteOffset = baseByte + (i * 2);
        if (elementType.kind === "int16") {
          builder.writeInt16(byteOffset, asNumber(values[i]));
        } else if (elementType.kind === "enum") {
          builder.writeUint16(byteOffset, enumOrdinal(elementType, values[i]));
        } else {
          builder.writeUint16(byteOffset, asNumber(values[i]));
        }
      }
      builder.setListPointer(pointerWord, startWord, 3, values.length);
      return;
    }
    case 4: {
      const startWord = builder.allocWords(bytesToWords(values.length * 4));
      const baseByte = startWord * WORD_BYTES;
      for (let i = 0; i < values.length; i += 1) {
        const byteOffset = baseByte + (i * 4);
        if (elementType.kind === "int32") {
          builder.writeInt32(byteOffset, asNumber(values[i]));
        } else if (elementType.kind === "float32") {
          builder.writeFloat32(byteOffset, asNumber(values[i]));
        } else {
          builder.writeUint32(byteOffset, asNumber(values[i]));
        }
      }
      builder.setListPointer(pointerWord, startWord, 4, values.length);
      return;
    }
    case 5: {
      const startWord = builder.allocWords(values.length);
      const baseByte = startWord * WORD_BYTES;
      for (let i = 0; i < values.length; i += 1) {
        const byteOffset = baseByte + (i * 8);
        if (elementType.kind === "int64") {
          builder.writeBigInt64(byteOffset, asBigInt(values[i]));
        } else if (elementType.kind === "float64") {
          builder.writeFloat64(byteOffset, asNumber(values[i]));
        } else {
          builder.writeBigUint64(byteOffset, asBigInt(values[i]));
        }
      }
      builder.setListPointer(pointerWord, startWord, 5, values.length);
      return;
    }
    default:
      throw new Error(
        "unsupported list element size for encode: " + elementSize,
      );
  }
}

export function decodeListField(
  reader: MessageReader,
  segmentId: number,
  pointerWord: number,
  elementType: TypeDescriptor,
): unknown[] {
  const list = reader.readListPointer(segmentId, pointerWord);
  if (!list) return [];

  if (elementType.kind === "struct") {
    if (list.kind !== "inlineComposite") {
      throw new Error("expected inline composite list for struct element type");
    }
    const descriptor = elementType.get();
    const stride = descriptor.dataWordCount + descriptor.pointerCount;
    const values: unknown[] = [];
    const startWord = list.tagWord + 1;
    for (let i = 0; i < list.elementCount; i += 1) {
      const elementStart = startWord + (i * stride);
      values.push(
        decodeStructAt(reader, descriptor, {
          segmentId: list.segmentId,
          startWord: elementStart,
          dataWordCount: descriptor.dataWordCount,
          pointerCount: descriptor.pointerCount,
        }),
      );
    }
    return values;
  }

  if (isPointerType(elementType)) {
    if (list.kind !== "flat" || list.elementSize !== 6) {
      throw new Error("expected pointer list for pointer element type");
    }
    const values: unknown[] = [];
    for (let i = 0; i < list.elementCount; i += 1) {
      values.push(
        decodePointerField(
          reader,
          list.segmentId,
          list.startWord + i,
          elementType,
        ),
      );
    }
    return values;
  }

  const expectedSize = listElementSize(elementType);
  if (list.kind !== "flat" || list.elementSize !== expectedSize) {
    throw new Error(
      "list element size mismatch: expected=" + expectedSize + " actual=" +
        (list.kind === "flat" ? list.elementSize : 7),
    );
  }

  switch (expectedSize) {
    case 0:
      return new Array(list.elementCount).fill(undefined);
    case 1: {
      const out: boolean[] = [];
      const baseByte = list.startWord * WORD_BYTES;
      for (let i = 0; i < list.elementCount; i += 1) {
        const byte = reader.readUint8At(
          list.segmentId,
          baseByte + Math.floor(i / 8),
          Number.MAX_SAFE_INTEGER,
          "decode bool list",
        );
        out.push((byte & (1 << (i % 8))) !== 0);
      }
      return out;
    }
    case 2: {
      const out: number[] = [];
      const baseByte = list.startWord * WORD_BYTES;
      for (let i = 0; i < list.elementCount; i += 1) {
        const byteOffset = baseByte + i;
        if (elementType.kind === "int8") {
          out.push(
            reader.readInt8At(
              list.segmentId,
              byteOffset,
              Number.MAX_SAFE_INTEGER,
              "decode int8 list",
            ),
          );
        } else {
          out.push(
            reader.readUint8At(
              list.segmentId,
              byteOffset,
              Number.MAX_SAFE_INTEGER,
              "decode uint8 list",
            ),
          );
        }
      }
      return out;
    }
    case 3: {
      const out: unknown[] = [];
      const baseByte = list.startWord * WORD_BYTES;
      for (let i = 0; i < list.elementCount; i += 1) {
        const byteOffset = baseByte + (i * 2);
        if (elementType.kind === "int16") {
          out.push(
            reader.readInt16At(
              list.segmentId,
              byteOffset,
              Number.MAX_SAFE_INTEGER,
              "decode int16 list",
            ),
          );
        } else if (elementType.kind === "enum") {
          out.push(
            enumValue(
              elementType,
              reader.readUint16At(
                list.segmentId,
                byteOffset,
                Number.MAX_SAFE_INTEGER,
                "decode enum list",
              ),
            ),
          );
        } else {
          out.push(
            reader.readUint16At(
              list.segmentId,
              byteOffset,
              Number.MAX_SAFE_INTEGER,
              "decode uint16 list",
            ),
          );
        }
      }
      return out;
    }
    case 4: {
      const out: number[] = [];
      const baseByte = list.startWord * WORD_BYTES;
      for (let i = 0; i < list.elementCount; i += 1) {
        const byteOffset = baseByte + (i * 4);
        if (elementType.kind === "int32") {
          out.push(
            reader.readInt32At(
              list.segmentId,
              byteOffset,
              Number.MAX_SAFE_INTEGER,
              "decode int32 list",
            ),
          );
        } else if (elementType.kind === "float32") {
          out.push(
            reader.readFloat32At(
              list.segmentId,
              byteOffset,
              Number.MAX_SAFE_INTEGER,
              "decode float32 list",
            ),
          );
        } else {
          out.push(
            reader.readUint32At(
              list.segmentId,
              byteOffset,
              Number.MAX_SAFE_INTEGER,
              "decode uint32 list",
            ),
          );
        }
      }
      return out;
    }
    case 5: {
      const out: unknown[] = [];
      const baseByte = list.startWord * WORD_BYTES;
      for (let i = 0; i < list.elementCount; i += 1) {
        const byteOffset = baseByte + (i * 8);
        if (elementType.kind === "int64") {
          out.push(
            reader.readBigInt64At(
              list.segmentId,
              byteOffset,
              Number.MAX_SAFE_INTEGER,
              "decode int64 list",
            ),
          );
        } else if (elementType.kind === "float64") {
          out.push(
            reader.readFloat64At(
              list.segmentId,
              byteOffset,
              Number.MAX_SAFE_INTEGER,
              "decode float64 list",
            ),
          );
        } else {
          out.push(
            reader.readBigUint64At(
              list.segmentId,
              byteOffset,
              Number.MAX_SAFE_INTEGER,
              "decode uint64 list",
            ),
          );
        }
      }
      return out;
    }
    default:
      throw new Error(
        "unsupported list element size for decode: " + expectedSize,
      );
  }
}

// ---------------------------------------------------------------------------
// Cap table helpers for RPC integration (GAP-05)
// ---------------------------------------------------------------------------

/**
 * A capability descriptor in the Cap'n Proto RPC cap table.
 * Defined inline so the preamble remains self-contained.
 */
export interface PreambleCapDescriptor {
  tag: number;
  id: number;
}

/** Tag value for a sender-hosted capability descriptor. */
export const CAP_DESCRIPTOR_TAG_SENDER_HOSTED = 1;

/** Result of encoding a struct message with cap table information. */
export interface EncodeWithCapsResult {
  content: Uint8Array;
  capTable: PreambleCapDescriptor[];
}

/**
 * Collected capability entry returned by collectCapabilityPointersFromStruct.
 * fieldPath is a dot-separated path useful for debugging.
 */
export interface CollectedCapability {
  fieldPath: string;
  capabilityIndex: number;
}

/**
 * Collect all CapabilityPointer values from a struct value by walking
 * its descriptor.  Returns an array of { fieldPath, capabilityIndex }
 * entries in the order they appear in the struct fields.
 */
export function collectCapabilityPointersFromStruct<
  T extends object,
>(
  descriptor: StructDescriptor<T>,
  value: T,
  prefix: string,
): CollectedCapability[] {
  const result: CollectedCapability[] = [];
  const record = asRecord(value);
  const activeDiscriminant = resolveActiveDiscriminant(descriptor, record);

  for (const field of descriptor.fields) {
    if (
      field.discriminantValue !== undefined &&
      activeDiscriminant !== undefined &&
      field.discriminantValue !== activeDiscriminant
    ) {
      continue;
    }

    const fieldPath = prefix ? prefix + "." + field.name : field.name;
    const fieldValue = record[field.name];

    if (field.kind === "group") {
      const groupDescriptor = field.type.get();
      result.push(
        ...collectCapabilityPointersFromStruct(
          groupDescriptor,
          asRecord(fieldValue),
          fieldPath,
        ),
      );
      continue;
    }

    if (field.type.kind === "interface") {
      const index = capabilityIndexFrom(fieldValue);
      if (index !== null) {
        result.push({ fieldPath, capabilityIndex: index });
      }
      continue;
    }

    if (field.type.kind === "anyPointer") {
      const pointer = asAnyPointerValue(fieldValue);
      if (pointer.kind === "interface") {
        result.push({ fieldPath, capabilityIndex: pointer.capabilityIndex });
      }
      continue;
    }

    if (field.type.kind === "list" && field.type.element.kind === "interface") {
      const items = asArray(fieldValue);
      for (let i = 0; i < items.length; i += 1) {
        const index = capabilityIndexFrom(items[i]);
        if (index !== null) {
          result.push({
            fieldPath: fieldPath + "[" + i + "]",
            capabilityIndex: index,
          });
        }
      }
      continue;
    }

    if (
      field.type.kind === "list" && field.type.element.kind === "anyPointer"
    ) {
      const items = asArray(fieldValue);
      for (let i = 0; i < items.length; i += 1) {
        const pointer = asAnyPointerValue(items[i]);
        if (pointer.kind === "interface") {
          result.push({
            fieldPath: fieldPath + "[" + i + "]",
            capabilityIndex: pointer.capabilityIndex,
          });
        }
      }
      continue;
    }

    if (field.type.kind === "list" && field.type.element.kind === "struct") {
      const items = asArray(fieldValue);
      const elemDescriptor = field.type.element.get();
      for (let i = 0; i < items.length; i += 1) {
        result.push(
          ...collectCapabilityPointersFromStruct(
            elemDescriptor,
            asRecord(items[i]),
            fieldPath + "[" + i + "]",
          ),
        );
      }
      continue;
    }

    if (field.type.kind === "struct") {
      const nestedDescriptor = field.type.get();
      result.push(
        ...collectCapabilityPointersFromStruct(
          nestedDescriptor,
          asRecord(fieldValue),
          fieldPath,
        ),
      );
      continue;
    }
  }

  return result;
}

/**
 * Encode a struct message and produce a cap table from any capability
 * pointer fields found in the value.
 *
 * Each capability pointer in the encoded struct references an index in the
 * returned cap table.  The cap table entries use
 * CAP_DESCRIPTOR_TAG_SENDER_HOSTED with the original capabilityIndex
 * as the descriptor ID.
 */
export function encodeStructMessageWithCaps<T extends object>(
  descriptor: StructDescriptor<T>,
  value: T,
): EncodeWithCapsResult {
  const collected = collectCapabilityPointersFromStruct(descriptor, value, "");

  // Build a mapping from original capabilityIndex to cap table position.
  // If the same capabilityIndex appears more than once we reuse the same
  // cap table slot.
  const capTableMap = new Map<number, number>();
  const capTable: PreambleCapDescriptor[] = [];
  for (const entry of collected) {
    if (!capTableMap.has(entry.capabilityIndex)) {
      capTableMap.set(entry.capabilityIndex, capTable.length);
      capTable.push({
        tag: CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
        id: entry.capabilityIndex,
      });
    }
  }

  // If no capabilities, encode normally.
  if (capTable.length === 0) {
    return { content: encodeStructMessage(descriptor, value), capTable: [] };
  }

  // Remap the capability indices in the value so that they reference
  // cap table positions (0, 1, 2, ...) rather than the original export
  // IDs.  We create a shallow-remapped copy to avoid mutating the input.
  const remapped = remapCapabilityIndices(descriptor, value, capTableMap);
  return { content: encodeStructMessage(descriptor, remapped), capTable };
}

/**
 * Create a shallow copy of a struct value with capability indices remapped
 * according to the provided mapping (original index -> cap table position).
 */
export function remapCapabilityIndices<T extends object>(
  descriptor: StructDescriptor<T>,
  value: T,
  mapping: Map<number, number>,
): T {
  const record = asRecord(value);
  const activeDiscriminant = resolveActiveDiscriminant(descriptor, record);
  const out = { ...record };

  for (const field of descriptor.fields) {
    if (
      field.discriminantValue !== undefined &&
      activeDiscriminant !== undefined &&
      field.discriminantValue !== activeDiscriminant
    ) {
      continue;
    }

    const fieldValue = record[field.name];

    if (field.kind === "group") {
      const groupDescriptor = field.type.get();
      out[field.name] = remapCapabilityIndices(
        groupDescriptor,
        asRecord(fieldValue),
        mapping,
      );
      continue;
    }

    if (field.type.kind === "interface") {
      const index = capabilityIndexFrom(fieldValue);
      if (index !== null) {
        const mapped = mapping.get(index);
        if (mapped !== undefined) {
          out[field.name] = { capabilityIndex: mapped };
        }
      }
      continue;
    }

    if (field.type.kind === "anyPointer") {
      const pointer = asAnyPointerValue(fieldValue);
      if (pointer.kind === "interface") {
        const mapped = mapping.get(pointer.capabilityIndex);
        if (mapped !== undefined) {
          out[field.name] = { kind: "interface", capabilityIndex: mapped };
        }
      }
      continue;
    }

    if (field.type.kind === "list" && field.type.element.kind === "interface") {
      const items = asArray(fieldValue);
      out[field.name] = items.map((item) => {
        const index = capabilityIndexFrom(item);
        if (index !== null) {
          const mapped = mapping.get(index);
          if (mapped !== undefined) {
            return { capabilityIndex: mapped };
          }
        }
        return item;
      });
      continue;
    }

    if (
      field.type.kind === "list" && field.type.element.kind === "anyPointer"
    ) {
      const items = asArray(fieldValue);
      out[field.name] = items.map((item) => {
        const pointer = asAnyPointerValue(item);
        if (pointer.kind === "interface") {
          const mapped = mapping.get(pointer.capabilityIndex);
          if (mapped !== undefined) {
            return { kind: "interface", capabilityIndex: mapped };
          }
        }
        return item;
      });
      continue;
    }

    if (field.type.kind === "list" && field.type.element.kind === "struct") {
      const items = asArray(fieldValue);
      const elemDescriptor = field.type.element.get();
      out[field.name] = items.map((item) =>
        remapCapabilityIndices(elemDescriptor, asRecord(item), mapping)
      );
      continue;
    }

    if (field.type.kind === "struct") {
      const nestedDescriptor = field.type.get();
      out[field.name] = remapCapabilityIndices(
        nestedDescriptor,
        asRecord(fieldValue),
        mapping,
      );
      continue;
    }
  }

  return out as T;
}

/**
 * Decode a struct message and resolve capability indices through a cap table.
 *
 * The cap table entries from the RPC message are used to map the capability
 * indices in the decoded struct back to their original export/import IDs.
 * Capability pointer fields in the returned struct will have their
 * capabilityIndex set to the id from the corresponding cap table entry.
 */
export function decodeStructMessageWithCaps<T extends object>(
  descriptor: StructDescriptor<T>,
  bytes: Uint8Array,
  capTable: PreambleCapDescriptor[],
): T {
  const decoded = decodeStructMessage(descriptor, bytes);

  // If no cap table, return as-is.
  if (capTable.length === 0) {
    return decoded;
  }

  // Build a mapping from cap table index to the descriptor's ID.
  const indexToId = new Map<number, number>();
  for (let i = 0; i < capTable.length; i += 1) {
    indexToId.set(i, capTable[i].id);
  }

  return resolveDecodedCapabilities(descriptor, decoded, indexToId);
}

/**
 * Walk a decoded struct and replace capability indices with their resolved
 * IDs from the cap table mapping (cap table index -> export/import ID).
 */
export function resolveDecodedCapabilities<T extends object>(
  descriptor: StructDescriptor<T>,
  value: T,
  mapping: Map<number, number>,
): T {
  const record = asRecord(value);
  const activeDiscriminant = resolveActiveDiscriminant(descriptor, record);
  const out = { ...record };

  for (const field of descriptor.fields) {
    if (
      field.discriminantValue !== undefined &&
      activeDiscriminant !== undefined &&
      field.discriminantValue !== activeDiscriminant
    ) {
      continue;
    }

    const fieldValue = record[field.name];

    if (field.kind === "group") {
      const groupDescriptor = field.type.get();
      out[field.name] = resolveDecodedCapabilities(
        groupDescriptor,
        asRecord(fieldValue),
        mapping,
      );
      continue;
    }

    if (field.type.kind === "interface") {
      if (fieldValue !== null && fieldValue !== undefined) {
        const cap = fieldValue as CapabilityPointer;
        const resolved = mapping.get(cap.capabilityIndex);
        if (resolved !== undefined) {
          out[field.name] = { capabilityIndex: resolved };
        }
      }
      continue;
    }

    if (field.type.kind === "anyPointer") {
      const pointer = asAnyPointerValue(fieldValue);
      if (pointer.kind === "interface") {
        const resolved = mapping.get(pointer.capabilityIndex);
        if (resolved !== undefined) {
          out[field.name] = { kind: "interface", capabilityIndex: resolved };
        }
      }
      continue;
    }

    if (field.type.kind === "list" && field.type.element.kind === "interface") {
      const items = asArray(fieldValue);
      out[field.name] = items.map((item) => {
        if (item === null || item === undefined) return item;
        const cap = item as CapabilityPointer;
        const resolved = mapping.get(cap.capabilityIndex);
        if (resolved !== undefined) {
          return { capabilityIndex: resolved };
        }
        return item;
      });
      continue;
    }

    if (
      field.type.kind === "list" && field.type.element.kind === "anyPointer"
    ) {
      const items = asArray(fieldValue);
      out[field.name] = items.map((item) => {
        if (item === null || item === undefined) return item;
        const pointer = asAnyPointerValue(item);
        if (pointer.kind === "interface") {
          const resolved = mapping.get(pointer.capabilityIndex);
          if (resolved !== undefined) {
            return { kind: "interface", capabilityIndex: resolved };
          }
        }
        return item;
      });
      continue;
    }

    if (field.type.kind === "list" && field.type.element.kind === "struct") {
      const items = asArray(fieldValue);
      const elemDescriptor = field.type.element.get();
      out[field.name] = items.map((item) =>
        resolveDecodedCapabilities(elemDescriptor, asRecord(item), mapping)
      );
      continue;
    }

    if (field.type.kind === "struct") {
      const nestedDescriptor = field.type.get();
      out[field.name] = resolveDecodedCapabilities(
        nestedDescriptor,
        asRecord(fieldValue),
        mapping,
      );
      continue;
    }
  }

  return out as T;
}
