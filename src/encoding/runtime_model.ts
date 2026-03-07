/**
 * Descriptor model and scalar helpers for the Cap'n Proto encoding runtime.
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

export type AnyPointerValue =
  | { kind: "null" }
  | { kind: "interface"; capabilityIndex: number }
  | { kind: "message"; message: Uint8Array };

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
export const POINTER_OFFSET_MASK = MASK_30 << 2n;
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
  if (value instanceof Uint8Array) {
    return { kind: "message", message: value };
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (record.kind === "null") return { kind: "null" };
    if (record.kind === "interface") {
      const index = capabilityIndexFrom(record.capabilityIndex);
      if (index === null) return { kind: "null" };
      return { kind: "interface", capabilityIndex: index };
    }
    if (record.kind === "message") {
      const message = record.message;
      if (!(message instanceof Uint8Array)) {
        throw new Error("invalid anyPointer message payload");
      }
      return { kind: "message", message };
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
