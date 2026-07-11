/**
 * Encoding-focused Cap'n Proto modules (schema/serde).
 *
 * This namespace intentionally excludes RPC session/transport/runtime logic.
 *
 * Exports are curated by name: internal helpers (bit masks, shared text
 * encoder/decoder singletons, unknown-coercion utilities, and word-offset
 * arithmetic) intentionally stay private to keep the published surface
 * stable. Generated `*_types.ts` modules re-export this entrypoint, so every
 * identifier generated code references must remain listed here.
 *
 * @module
 */

// runtime_model: type descriptors + struct/field descriptor machinery -------
export {
  decodeCapabilityPointerWord,
  defaultValueForType,
  encodeCapabilityPointerWord,
  enumOrdinal,
  enumValue,
  isDataType,
  isPointerType,
  isPresentField,
  resolveActiveDiscriminant,
  TYPE_ANY_POINTER,
  TYPE_BOOL,
  TYPE_DATA,
  TYPE_FLOAT32,
  TYPE_FLOAT64,
  TYPE_INT16,
  TYPE_INT32,
  TYPE_INT64,
  TYPE_INT8,
  TYPE_INTERFACE,
  TYPE_TEXT,
  TYPE_UINT16,
  TYPE_UINT32,
  TYPE_UINT64,
  TYPE_UINT8,
  TYPE_VOID,
  WORD_BYTES,
} from "./runtime_model.ts";
export type {
  AnyPointerTypeDescriptor,
  AnyPointerValue,
  CapabilityPointer,
  DataTypeDescriptor,
  EnumTypeDescriptor,
  FieldDescriptor,
  GroupFieldDescriptor,
  InterfaceTypeDescriptor,
  ListTypeDescriptor,
  PrimitiveTypeDescriptor,
  PrimitiveTypeKind,
  SlotFieldDescriptor,
  StructCodec,
  StructDescriptor,
  StructTypeDescriptor,
  StructUnionDescriptor,
  TextTypeDescriptor,
  TypeDescriptor,
} from "./runtime_model.ts";

// runtime_message: message builder/reader ----------------------------------
export { MessageBuilder, MessageReader } from "./runtime_message.ts";
export type {
  FlatListRef,
  InlineCompositeListRef,
  ListRef,
  ResolvedPointer,
  StructRef,
} from "./runtime_message.ts";

// runtime_codec: schema-driven struct/list/pointer codecs ------------------
export {
  decodeAnyPointerMessageFromReader,
  decodeDataField,
  decodeListField,
  decodePointerField,
  decodeStructAt,
  decodeStructMessage,
  encodeAnyPointerMessageIntoBuilder,
  encodeDataField,
  encodeListField,
  encodePointerField,
  encodeStructAt,
  encodeStructMessage,
} from "./runtime_codec.ts";

// runtime_caps: capability table collection/remapping ----------------------
export {
  CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
  collectCapabilityPointersFromStruct,
  decodeStructMessageWithCaps,
  encodeStructMessageWithCaps,
  remapCapabilityIndices,
  resolveDecodedCapabilities,
} from "./runtime_caps.ts";
export type {
  CollectedCapability,
  EncodeWithCapsResult,
  PreambleCapDescriptor,
} from "./runtime_caps.ts";

// serde: JSON bridge serde over the WASM runtime ---------------------------
export { WasmSerde } from "./serde.ts";
export type {
  JsonSerdeCodec,
  JsonSerdeCodecLookupOptions,
  JsonSerdeCodecOptions,
  JsonSerdeExportBinding,
} from "./serde.ts";
