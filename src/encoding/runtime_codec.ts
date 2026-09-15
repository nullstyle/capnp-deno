/**
 * Struct, pointer, list, and anyPointer codec helpers for the encoding runtime.
 *
 * @module
 */

import {
  asAnyPointerValue,
  asArray,
  asBigInt,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  asUint8Array,
  bytesToWords,
  capabilityIndexFrom,
  dataByteOffset,
  decodeCapabilityPointerWord,
  encodeCapabilityPointerWord,
  encodeSigned30,
  enumOrdinal,
  enumValue,
  isDataType,
  isPointerType,
  listElementSize,
  MASK_30,
  POINTER_OFFSET_MASK,
  resolveActiveDiscriminant,
  signed30,
  WORD_BYTES,
} from "./runtime_model.ts";
import type {
  AnyPointerValue,
  StructDescriptor,
  TypeDescriptor,
} from "./runtime_model.ts";
import { MessageBuilder, MessageReader } from "./runtime_message.ts";
import type { StructRef } from "./runtime_message.ts";
import { ProtocolError } from "../errors.ts";

/**
 * Encode a struct value as a complete framed Cap'n Proto message with the
 * struct as the message root.
 *
 * Generated `encode*` codec helpers delegate to this function with their
 * schema's generated {@link StructDescriptor}.
 *
 * @typeParam T - The TypeScript shape described by the descriptor.
 * @param descriptor - Generated struct descriptor describing layout and fields.
 * @param value - The struct value to encode.
 * @returns The framed message bytes (segment table plus segment payload).
 * @example
 * ```ts
 * // PersonStruct is the generated StructDescriptor from person_types.ts.
 * const bytes = encodeStructMessage(PersonStruct, { name: "Ada", age: 36 });
 * ```
 */
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

/**
 * Decode the root struct of a framed Cap'n Proto message.
 *
 * Returns the descriptor's default value when the root pointer is null.
 * Generated `decode*` codec helpers delegate to this function with their
 * schema's generated {@link StructDescriptor}.
 *
 * @typeParam T - The TypeScript shape described by the descriptor.
 * @param descriptor - Generated struct descriptor describing layout and fields.
 * @param bytes - The complete framed message to decode.
 * @returns The decoded struct value.
 * @example
 * ```ts
 * // PersonStruct is the generated StructDescriptor from person_types.ts.
 * const person = decodeStructMessage(PersonStruct, bytes);
 * console.log(person.name);
 * ```
 */
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
    // Zero-initialized scalar storage and null pointers encode schema defaults.
    if (fieldValue === undefined) continue;
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
        field.defaultMask,
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
    ? descriptor.union.discriminantOffset * 2 + 2 >
        structRef.dataWordCount * WORD_BYTES
      ? 0
      : reader.readUint16InStruct(
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
      const byteOffset = field.type.kind === "bool"
        ? Math.floor(field.offset / 8)
        : dataByteOffset(field.type, field.offset);
      const byteWidth = field.type.kind === "void"
        ? 0
        : dataByteOffset(field.type, 1);
      if (byteOffset + byteWidth > structRef.dataWordCount * WORD_BYTES) {
        continue;
      }
      record[field.name] = decodeDataField(
        reader,
        structRef,
        field.offset,
        field.type,
        field.defaultMask,
      );
      continue;
    }
    // Older layouts omit newly added slots. Null pointers also select the
    // schema default; a present malformed pointer must still be resolved.
    if (field.offset >= structRef.pointerCount) continue;
    const pointerWord = reader.pointerWordIndex(structRef, field.offset);
    if (
      reader.readResolvedPointerWord(structRef.segmentId, pointerWord) === 0n
    ) continue;
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
  defaultMask = 0n,
): void {
  if (defaultMask !== 0n) {
    encodeDataWithDefault(
      builder,
      structWord,
      offset,
      type,
      value,
      defaultMask,
    );
    return;
  }
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
  defaultMask = 0n,
): unknown {
  if (defaultMask !== 0n) {
    return decodeDataWithDefault(reader, structRef, offset, type, defaultMask);
  }
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

// Cap'n Proto stores scalars XORed with their schema default. Work on the
// unsigned bit representation so signed values, floats and enums all preserve
// the exact wire mask: https://capnproto.org/encoding.html#default-values
function encodeDataWithDefault(
  builder: MessageBuilder,
  structWord: number,
  offset: number,
  type: TypeDescriptor,
  value: unknown,
  mask: bigint,
): void {
  const base = structWord * WORD_BYTES;
  if (type.kind === "bool") {
    builder.setBool(
      base + Math.floor(offset / 8),
      offset % 8,
      asBoolean(value) !== (mask !== 0n),
    );
    return;
  }
  const width = dataByteOffset(type, 1);
  const at = base + dataByteOffset(type, offset);
  let bits: bigint;
  if (type.kind === "float32" || type.kind === "float64") {
    const view = new DataView(new ArrayBuffer(8));
    const numeric = typeof value === "number" ? value : 0;
    if (type.kind === "float32") view.setFloat32(0, numeric, true);
    else view.setFloat64(0, numeric, true);
    bits = view.getBigUint64(0, true);
  } else {
    bits = type.kind === "enum"
      ? BigInt(enumOrdinal(type, value))
      : type.kind === "int64" || type.kind === "uint64"
      ? asBigInt(value)
      : BigInt(asNumber(value));
  }
  bits = BigInt.asUintN(width * 8, bits) ^ mask;
  switch (width) {
    case 1:
      builder.writeUint8(at, Number(bits));
      return;
    case 2:
      builder.writeUint16(at, Number(bits));
      return;
    case 4:
      builder.writeUint32(at, Number(bits));
      return;
    case 8:
      builder.writeBigUint64(at, bits);
      return;
    default:
      throw new ProtocolError("invalid scalar default type: " + type.kind);
  }
}

function decodeDataWithDefault(
  reader: MessageReader,
  ref: StructRef,
  offset: number,
  type: TypeDescriptor,
  mask: bigint,
): unknown {
  if (type.kind === "bool") {
    return reader.readBool(ref, offset) !== (mask !== 0n);
  }
  const width = dataByteOffset(type, 1);
  const at = dataByteOffset(type, offset);
  let bits: bigint;
  switch (width) {
    case 1:
      bits = BigInt(reader.readUint8InStruct(ref, at));
      break;
    case 2:
      bits = BigInt(reader.readUint16InStruct(ref, at));
      break;
    case 4:
      bits = BigInt(reader.readUint32InStruct(ref, at));
      break;
    case 8:
      bits = reader.readBigUint64InStruct(ref, at);
      break;
    default:
      throw new ProtocolError("invalid scalar default type: " + type.kind);
  }
  bits ^= mask;
  if (type.kind === "enum") return enumValue(type, Number(bits));
  if (type.kind === "float32" || type.kind === "float64") {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, bits, true);
    return type.kind === "float32"
      ? view.getFloat32(0, true)
      : view.getFloat64(0, true);
  }
  if (type.kind.startsWith("int")) bits = BigInt.asIntN(width * 8, bits);
  return width === 8 ? bits : Number(bits);
}

function listDataWordsForAnyPointerCopy(
  elementSize: number,
  elementCount: number,
): number {
  switch (elementSize) {
    case 0:
      return 0;
    case 1:
      return Math.ceil(elementCount / 64);
    case 2:
      return bytesToWords(elementCount);
    case 3:
      return bytesToWords(elementCount * 2);
    case 4:
      return bytesToWords(elementCount * 4);
    case 5:
    case 6:
      return elementCount;
    default:
      throw new Error(
        "unsupported list element size for anyPointer copy: " + elementSize,
      );
  }
}

function copyWordsForAnyPointer(
  reader: MessageReader,
  srcSegmentId: number,
  srcStartWord: number,
  wordCount: number,
  builder: MessageBuilder,
  dstStartWord: number,
): void {
  for (let i = 0; i < wordCount; i += 1) {
    builder.writeWord(
      dstStartWord + i,
      reader.readWord(srcSegmentId, srcStartWord + i),
    );
  }
}

/** Limits on expanded wire copying, including repeated references to shared targets. */
export interface AnyPointerCopyOptions {
  /** Pointer visits, copied words, and logical list elements. Default: 8 Mi units. */
  maxWork?: number;
  /** Copied segment words including its root pointer. Default: 8 Mi words. */
  maxOutputWords?: number;
  /** Maximum nested pointer depth. Default: 64. */
  maxDepth?: number;
}

class AnyPointerCopyBudget {
  work: number;
  outputWords: number;
  readonly maxDepth: number;

  constructor(options: AnyPointerCopyOptions) {
    this.work = options.maxWork ?? 8 * 1024 * 1024;
    this.outputWords = options.maxOutputWords ?? 8 * 1024 * 1024;
    this.maxDepth = options.maxDepth ?? 64;
    for (
      const [name, value] of Object.entries({
        maxWork: this.work,
        maxOutputWords: this.outputWords,
        maxDepth: this.maxDepth,
      })
    ) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new ProtocolError(
          `AnyPointer copy ${name} must be a non-negative safe integer`,
        );
      }
    }
    this.chargeOutput(1); // Every copied message owns its root slot.
  }

  chargeWork(amount: number): void {
    if (amount > this.work) {
      throw new ProtocolError("AnyPointer copy work limit exceeded");
    }
    this.work -= amount;
  }

  chargeOutput(amount: number): void {
    if (amount > this.outputWords) {
      throw new ProtocolError("AnyPointer copy output word limit exceeded");
    }
    this.outputWords -= amount;
  }
}

function deepCopyAnyPointer(
  reader: MessageReader,
  srcSegmentId: number,
  srcPointerWord: number,
  builder: MessageBuilder,
  dstPointerWord: number,
  budget: AnyPointerCopyBudget,
  depth: number,
): void {
  if (depth > budget.maxDepth) {
    throw new ProtocolError("AnyPointer copy nesting depth limit exceeded");
  }
  budget.chargeWork(1);
  const resolved = reader.readResolvedPointer(srcSegmentId, srcPointerWord);
  if (resolved.word === 0n && resolved.contentWord === undefined) {
    builder.writeWord(dstPointerWord, 0n);
    return;
  }
  const kind = Number(resolved.word & 3n);
  if (kind === 3) {
    // These indices remain in the caller's capability-table domain. A wire
    // copy never acquires leases or transfers capabilities between tables.
    builder.writeWord(dstPointerWord, resolved.word);
    return;
  }
  if (kind === 0) {
    const ref = reader.readStructPointer(srcSegmentId, srcPointerWord)!;
    budget.chargeWork(ref.dataWordCount);
    budget.chargeOutput(ref.dataWordCount + ref.pointerCount);
    const start = builder.allocWords(ref.dataWordCount + ref.pointerCount);
    builder.setStructPointer(
      dstPointerWord,
      start,
      ref.dataWordCount,
      ref.pointerCount,
    );
    copyWordsForAnyPointer(
      reader,
      ref.segmentId,
      ref.startWord,
      ref.dataWordCount,
      builder,
      start,
    );
    for (let i = 0; i < ref.pointerCount; i++) {
      deepCopyAnyPointer(
        reader,
        ref.segmentId,
        ref.startWord + ref.dataWordCount + i,
        builder,
        start + ref.dataWordCount + i,
        budget,
        depth + 1,
      );
    }
    return;
  }
  if (kind !== 1) {
    throw new ProtocolError("AnyPointer copy received unresolved far pointer");
  }
  // Resolve and bounds-check the full declared payload before allocating.
  const list = reader.readListPointer(srcSegmentId, srcPointerWord)!;
  budget.chargeWork(list.elementCount);
  if (list.kind === "inlineComposite") {
    budget.chargeWork(list.wordsInElements);
    budget.chargeOutput(1 + list.wordsInElements);
    const start = builder.allocWords(1 + list.wordsInElements);
    builder.setListPointer(dstPointerWord, start, 7, list.wordsInElements);
    copyWordsForAnyPointer(
      reader,
      list.segmentId,
      list.tagWord,
      1 + list.wordsInElements,
      builder,
      start,
    );
    const stride = list.dataWordCount + list.pointerCount;
    if (list.pointerCount !== 0) {
      for (let i = 0; i < list.elementCount; i++) {
        for (let j = 0; j < list.pointerCount; j++) {
          const offset = 1 + i * stride + list.dataWordCount + j;
          deepCopyAnyPointer(
            reader,
            list.segmentId,
            list.tagWord + offset,
            builder,
            start + offset,
            budget,
            depth + 1,
          );
        }
      }
    }
    return;
  }
  const words = listDataWordsForAnyPointerCopy(
    list.elementSize,
    list.elementCount,
  );
  budget.chargeWork(words);
  budget.chargeOutput(words);
  const start = builder.allocWords(words);
  builder.setListPointer(
    dstPointerWord,
    start,
    list.elementSize,
    list.elementCount,
  );
  if (list.elementSize === 6) {
    for (let i = 0; i < list.elementCount; i++) {
      deepCopyAnyPointer(
        reader,
        list.segmentId,
        list.startWord + i,
        builder,
        start + i,
        budget,
        depth + 1,
      );
    }
  } else {
    copyWordsForAnyPointer(
      reader,
      list.segmentId,
      list.startWord,
      words,
      builder,
      start,
    );
  }
}

/**
 * Copy a complete wire message into a builder pointer with bounded expansion.
 * The source is validated/copied before destination allocation, so malformed
 * input and copy-limit failures leave the destination pointer unchanged.
 * Capability indices stay in the source table's domain; this does not remap
 * or retain capabilities. Options bound the temporary copied segment, not the
 * caller's complete builder or total temporary backing memory.
 *
 * @param builder - Destination builder.
 * @param pointerWord - Destination pointer slot.
 * @param message - Framed source whose root should be copied.
 * @param options - Expanded copy work, output, and depth ceilings.
 * @returns Nothing.
 * @example
 * ```ts
 * encodeAnyPointerMessageIntoBuilder(builder, pointerSlot, payload, { maxOutputWords: 8192 });
 * ```
 */
export function encodeAnyPointerMessageIntoBuilder(
  builder: {
    allocWords(count: number): number;
    writeWord(wordIndex: number, value: bigint): void;
  },
  pointerWord: number,
  message: Uint8Array,
  options: AnyPointerCopyOptions = {},
): void {
  const flatMessage = decodeAnyPointerMessageFromReader(
    new MessageReader(message),
    0,
    0,
    options,
  );
  const flatSegment = flatMessage.subarray(8);
  const segmentWordCount = Math.floor(flatSegment.byteLength / WORD_BYTES);
  if (segmentWordCount === 0) {
    builder.writeWord(pointerWord, 0n);
    return;
  }
  const segmentView = new DataView(
    flatSegment.buffer,
    flatSegment.byteOffset,
    flatSegment.byteLength,
  );
  const sourceRootPointer = segmentView.getBigUint64(0, true);
  if (sourceRootPointer === 0n) {
    builder.writeWord(pointerWord, 0n);
    return;
  }
  const copiedStartWord = builder.allocWords(segmentWordCount);
  for (let i = 0; i < segmentWordCount; i += 1) {
    builder.writeWord(
      copiedStartWord + i,
      segmentView.getBigUint64(i * WORD_BYTES, true),
    );
  }
  builder.writeWord(
    pointerWord,
    rebaseCopiedAnyPointerRootPointer(
      sourceRootPointer,
      copiedStartWord,
      pointerWord,
    ),
  );
}

/**
 * Deep-copy a pointer into an independent, single-segment framed message.
 * Expanded references are charged separately. Capabilities retain their table
 * indices; the caller still owns their reference/lease lifetime.
 *
 * @param reader - Source message reader.
 * @param segmentId - Segment containing the source pointer.
 * @param pointerWord - Word offset of that pointer.
 * @param options - Work, output-word, and nesting limits.
 * @returns Independently owned framed bytes.
 * @example
 * ```ts
 * const copy = decodeAnyPointerMessageFromReader(reader, 0, 0, { maxDepth: 32 });
 * ```
 */
export function decodeAnyPointerMessageFromReader(
  reader: MessageReader,
  segmentId: number,
  pointerWord: number,
  options: AnyPointerCopyOptions = {},
): Uint8Array {
  const budget = new AnyPointerCopyBudget(options);
  const builder = new MessageBuilder();
  deepCopyAnyPointer(reader, segmentId, pointerWord, builder, 0, budget, 0);
  return builder.toMessageBytes();
}

function rebaseCopiedAnyPointerRootPointer(
  sourceRootPointer: bigint,
  copiedStartWord: number,
  destinationPointerWord: number,
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
    throw new Error(
      "anyPointer message encoding does not support far-pointer roots",
    );
  }
  return sourceRootPointer;
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
      if (pointer.kind === "interface") {
        builder.writeWord(
          pointerWord,
          encodeCapabilityPointerWord(pointer.capabilityIndex),
        );
        return;
      }
      encodeAnyPointerMessageIntoBuilder(builder, pointerWord, pointer.message);
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
      const resolved = reader.readResolvedPointer(segmentId, pointerWord);
      if (resolved.word === 0n && resolved.contentWord === undefined) {
        return { kind: "null" } as AnyPointerValue;
      }
      const kind = Number(resolved.word & 0x3n);
      if (kind === 3) {
        const cap = decodeCapabilityPointerWord(resolved.word);
        return {
          kind: "interface",
          capabilityIndex: cap.capabilityIndex,
        } as AnyPointerValue;
      }
      return {
        kind: "message",
        message: decodeAnyPointerMessageFromReader(
          reader,
          segmentId,
          pointerWord,
        ),
      } as AnyPointerValue;
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
    const stride = list.dataWordCount + list.pointerCount;
    const values: unknown[] = [];
    const startWord = list.tagWord + 1;
    for (let i = 0; i < list.elementCount; i += 1) {
      const elementStart = startWord + (i * stride);
      values.push(
        decodeStructAt(reader, descriptor, {
          segmentId: list.segmentId,
          startWord: elementStart,
          dataWordCount: list.dataWordCount,
          pointerCount: list.pointerCount,
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
