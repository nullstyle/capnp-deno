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

function deepCopyAnyPointerSubPointer(
  reader: MessageReader,
  srcSegmentId: number,
  srcPointerWord: number,
  builder: MessageBuilder,
  dstPointerWord: number,
): void {
  const word = reader.readWord(srcSegmentId, srcPointerWord);
  const kind = Number(word & 0x3n);
  if (word === 0n) {
    builder.writeWord(dstPointerWord, 0n);
    return;
  }
  if (kind === 2) {
    const resolved = reader.readResolvedPointer(srcSegmentId, srcPointerWord);
    deepCopyAnyPointerPointer(
      reader,
      resolved.segmentId,
      resolved.pointerWord,
      resolved.word,
      builder,
      dstPointerWord,
    );
    return;
  }
  deepCopyAnyPointerPointer(
    reader,
    srcSegmentId,
    srcPointerWord,
    word,
    builder,
    dstPointerWord,
  );
}

function deepCopyAnyPointerPointer(
  reader: MessageReader,
  srcSegmentId: number,
  srcPointerWord: number,
  pointerWord: bigint,
  builder: MessageBuilder,
  dstPointerWord: number,
): void {
  if (pointerWord === 0n) {
    builder.writeWord(dstPointerWord, 0n);
    return;
  }

  const kind = Number(pointerWord & 0x3n);
  if (kind === 3) {
    builder.writeWord(dstPointerWord, pointerWord);
    return;
  }
  if (kind === 2) {
    throw new Error("deep anyPointer copy received unresolved far pointer");
  }

  if (kind === 0) {
    const offsetWords = signed30((pointerWord >> 2n) & MASK_30);
    const dataWordCount = Number((pointerWord >> 32n) & 0xffffn);
    const pointerCount = Number((pointerWord >> 48n) & 0xffffn);
    const srcStartWord = srcPointerWord + 1 + offsetWords;
    const totalWords = dataWordCount + pointerCount;
    const dstStartWord = builder.allocWords(totalWords);
    const dstOffset = dstStartWord - (dstPointerWord + 1);
    const rebased = (pointerWord & ~POINTER_OFFSET_MASK) |
      (encodeSigned30(dstOffset) << 2n);
    builder.writeWord(dstPointerWord, rebased);

    if (dataWordCount > 0) {
      copyWordsForAnyPointer(
        reader,
        srcSegmentId,
        srcStartWord,
        dataWordCount,
        builder,
        dstStartWord,
      );
    }

    for (let i = 0; i < pointerCount; i += 1) {
      deepCopyAnyPointerSubPointer(
        reader,
        srcSegmentId,
        srcStartWord + dataWordCount + i,
        builder,
        dstStartWord + dataWordCount + i,
      );
    }
    return;
  }

  const offsetWords = signed30((pointerWord >> 2n) & MASK_30);
  const elementSize = Number((pointerWord >> 32n) & 0x7n);
  const elementCount = Number((pointerWord >> 35n) & 0x1fff_ffffn);
  const srcListStartWord = srcPointerWord + 1 + offsetWords;

  if (elementSize === 7) {
    const tagWord = reader.readWord(srcSegmentId, srcListStartWord);
    const tagKind = Number(tagWord & 0x3n);
    if (tagKind !== 0) {
      throw new Error(
        "invalid inline composite tag kind for anyPointer copy: " + tagKind,
      );
    }
    const tagElementCount = Number((tagWord >> 2n) & MASK_30);
    const tagDataWordCount = Number((tagWord >> 32n) & 0xffffn);
    const tagPointerCount = Number((tagWord >> 48n) & 0xffffn);
    const stride = tagDataWordCount + tagPointerCount;
    const wordsInElements = tagElementCount * stride;

    const dstListStartWord = builder.allocWords(1 + wordsInElements);
    const dstOffset = dstListStartWord - (dstPointerWord + 1);
    const rebased = 1n |
      (encodeSigned30(dstOffset) << 2n) |
      (BigInt(elementSize) << 32n) |
      (BigInt(elementCount) << 35n);
    builder.writeWord(dstPointerWord, rebased);
    builder.writeWord(dstListStartWord, tagWord);

    for (let i = 0; i < tagElementCount; i += 1) {
      const srcElementStart = srcListStartWord + 1 + (i * stride);
      const dstElementStart = dstListStartWord + 1 + (i * stride);

      if (tagDataWordCount > 0) {
        copyWordsForAnyPointer(
          reader,
          srcSegmentId,
          srcElementStart,
          tagDataWordCount,
          builder,
          dstElementStart,
        );
      }

      for (let j = 0; j < tagPointerCount; j += 1) {
        deepCopyAnyPointerSubPointer(
          reader,
          srcSegmentId,
          srcElementStart + tagDataWordCount + j,
          builder,
          dstElementStart + tagDataWordCount + j,
        );
      }
    }
    return;
  }

  if (elementSize === 6) {
    const dstListStartWord = builder.allocWords(elementCount);
    const dstOffset = dstListStartWord - (dstPointerWord + 1);
    const rebased = 1n |
      (encodeSigned30(dstOffset) << 2n) |
      (BigInt(elementSize) << 32n) |
      (BigInt(elementCount) << 35n);
    builder.writeWord(dstPointerWord, rebased);

    for (let i = 0; i < elementCount; i += 1) {
      deepCopyAnyPointerSubPointer(
        reader,
        srcSegmentId,
        srcListStartWord + i,
        builder,
        dstListStartWord + i,
      );
    }
    return;
  }

  const dataWords = listDataWordsForAnyPointerCopy(elementSize, elementCount);
  const dstListStartWord = builder.allocWords(dataWords);
  const dstOffset = dstListStartWord - (dstPointerWord + 1);
  const rebased = 1n |
    (encodeSigned30(dstOffset) << 2n) |
    (BigInt(elementSize) << 32n) |
    (BigInt(elementCount) << 35n);
  builder.writeWord(dstPointerWord, rebased);
  if (dataWords > 0) {
    copyWordsForAnyPointer(
      reader,
      srcSegmentId,
      srcListStartWord,
      dataWords,
      builder,
      dstListStartWord,
    );
  }
}

export function encodeAnyPointerMessageIntoBuilder(
  builder: {
    allocWords(count: number): number;
    writeWord(wordIndex: number, value: bigint): void;
  },
  pointerWord: number,
  message: Uint8Array,
): void {
  const flatMessage = decodeAnyPointerMessageFromReader(
    new MessageReader(message),
    0,
    0,
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

export function decodeAnyPointerMessageFromReader(
  reader: MessageReader,
  segmentId: number,
  pointerWord: number,
): Uint8Array {
  const resolved = reader.readResolvedPointer(segmentId, pointerWord);
  const builder = new MessageBuilder();
  deepCopyAnyPointerPointer(
    reader,
    resolved.segmentId,
    resolved.pointerWord,
    resolved.word,
    builder,
    0,
  );
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
      if (resolved.word === 0n) return { kind: "null" } as AnyPointerValue;
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
