// Generated-style fixture for CI type-check regression gate.
//
// This file mimics the output of capnpc-deno codegen and exercises the
// shared generated runtime APIs with concrete named properties.
// If the generic constraint on StructDescriptor/FieldDescriptor reverts
// from `object` to `Record<string, unknown>`, this file will fail
// `deno check`.
//
// DO NOT EDIT unless updating to match emitter output patterns.

export * from "../../../src/encoding/runtime.ts";
export type {
  RpcBootstrapClientTransport,
  RpcCallContext,
  RpcCallOptions,
  RpcClientTransport,
  RpcExportCapabilityOptions,
  RpcFinishOptions,
  RpcServerDispatch,
  RpcServerDispatchResult,
  RpcServerRegistry,
} from "../../../src/rpc/server/rpc_runtime.ts";
import type {
  AnyPointerValue,
  CapabilityPointer,
  EnumTypeDescriptor,
  StructCodec,
  StructDescriptor,
} from "../../../src/encoding/runtime.ts";
import {
  decodeStructMessage,
  encodeStructMessage,
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
} from "../../../src/encoding/runtime.ts";

// ---------------------------------------------------------------------------
// Enum: Status
// ---------------------------------------------------------------------------

export const StatusValues = ["active", "inactive", "pending"] as const;
export type Status = typeof StatusValues[number];
const StatusDescriptor: EnumTypeDescriptor<Status> = {
  kind: "enum",
  byOrdinal: StatusValues,
  toOrdinal: {
    "active": 0,
    "inactive": 1,
    "pending": 2,
  },
};

// ---------------------------------------------------------------------------
// Struct: Person (exercises named properties with various field types)
// ---------------------------------------------------------------------------

export interface Person {
  id: bigint;
  name: string;
  age: number;
  isActive: boolean;
  score: number;
  status: Status;
  tags: string[];
  data: Uint8Array;
}

export const PersonDescriptor: StructDescriptor<Person> = {
  kind: "struct",
  name: "Person",
  dataWordCount: 2,
  pointerCount: 3,
  createDefault: () => ({
    id: 0n,
    name: "",
    age: 0,
    isActive: false,
    score: 0,
    status: "active",
    tags: [],
    data: new Uint8Array(0),
  }),
  fields: [
    {
      kind: "slot",
      name: "id",
      offset: 0,
      type: TYPE_UINT64,
    },
    {
      kind: "slot",
      name: "name",
      offset: 0,
      type: TYPE_TEXT,
    },
    {
      kind: "slot",
      name: "age",
      offset: 4,
      type: TYPE_UINT32,
    },
    {
      kind: "slot",
      name: "isActive",
      offset: 32,
      type: TYPE_BOOL,
    },
    {
      kind: "slot",
      name: "score",
      offset: 0,
      type: TYPE_FLOAT64,
    },
    {
      kind: "slot",
      name: "status",
      offset: 6,
      type: StatusDescriptor,
    },
    {
      kind: "slot",
      name: "tags",
      offset: 1,
      type: { kind: "list", element: TYPE_TEXT },
    },
    {
      kind: "slot",
      name: "data",
      offset: 2,
      type: TYPE_DATA,
    },
  ],
};

export const PersonCodec: StructCodec<Person> = {
  encode: (value: Person): Uint8Array =>
    encodeStructMessage(PersonDescriptor, value),
  decode: (bytes: Uint8Array): Person =>
    decodeStructMessage(PersonDescriptor, bytes),
};

// ---------------------------------------------------------------------------
// Struct: Holder (exercises interface/anyPointer field types)
// ---------------------------------------------------------------------------

export interface Holder {
  cap: CapabilityPointer | null;
  dyn: AnyPointerValue;
}

export const HolderDescriptor: StructDescriptor<Holder> = {
  kind: "struct",
  name: "Holder",
  dataWordCount: 0,
  pointerCount: 2,
  createDefault: () => ({
    cap: null,
    dyn: { kind: "null" },
  }),
  fields: [
    {
      kind: "slot",
      name: "cap",
      offset: 0,
      type: TYPE_INTERFACE,
    },
    {
      kind: "slot",
      name: "dyn",
      offset: 1,
      type: TYPE_ANY_POINTER,
    },
  ],
};

export const HolderCodec: StructCodec<Holder> = {
  encode: (value: Holder): Uint8Array =>
    encodeStructMessage(HolderDescriptor, value),
  decode: (bytes: Uint8Array): Holder =>
    decodeStructMessage(HolderDescriptor, bytes),
};

// ---------------------------------------------------------------------------
// Struct: AllPrimitives (exercises every primitive type)
// ---------------------------------------------------------------------------

export interface AllPrimitives {
  voidField: undefined;
  boolField: boolean;
  int8Field: number;
  int16Field: number;
  int32Field: number;
  int64Field: bigint;
  uint8Field: number;
  uint16Field: number;
  uint32Field: number;
  uint64Field: bigint;
  float32Field: number;
  float64Field: number;
  textField: string;
}

export const AllPrimitivesDescriptor: StructDescriptor<AllPrimitives> = {
  kind: "struct",
  name: "AllPrimitives",
  dataWordCount: 6,
  pointerCount: 1,
  createDefault: () => ({
    voidField: undefined,
    boolField: false,
    int8Field: 0,
    int16Field: 0,
    int32Field: 0,
    int64Field: 0n,
    uint8Field: 0,
    uint16Field: 0,
    uint32Field: 0,
    uint64Field: 0n,
    float32Field: 0,
    float64Field: 0,
    textField: "",
  }),
  fields: [
    { kind: "slot", name: "voidField", offset: 0, type: TYPE_VOID },
    { kind: "slot", name: "boolField", offset: 0, type: TYPE_BOOL },
    { kind: "slot", name: "int8Field", offset: 1, type: TYPE_INT8 },
    { kind: "slot", name: "int16Field", offset: 1, type: TYPE_INT16 },
    { kind: "slot", name: "int32Field", offset: 1, type: TYPE_INT32 },
    { kind: "slot", name: "int64Field", offset: 0, type: TYPE_INT64 },
    { kind: "slot", name: "uint8Field", offset: 2, type: TYPE_UINT8 },
    { kind: "slot", name: "uint16Field", offset: 2, type: TYPE_UINT16 },
    { kind: "slot", name: "uint32Field", offset: 2, type: TYPE_UINT32 },
    { kind: "slot", name: "uint64Field", offset: 1, type: TYPE_UINT64 },
    { kind: "slot", name: "float32Field", offset: 3, type: TYPE_FLOAT32 },
    { kind: "slot", name: "float64Field", offset: 2, type: TYPE_FLOAT64 },
    { kind: "slot", name: "textField", offset: 0, type: TYPE_TEXT },
  ],
};

export const AllPrimitivesCodec: StructCodec<AllPrimitives> = {
  encode: (value: AllPrimitives): Uint8Array =>
    encodeStructMessage(AllPrimitivesDescriptor, value),
  decode: (bytes: Uint8Array): AllPrimitives =>
    decodeStructMessage(AllPrimitivesDescriptor, bytes),
};

// ---------------------------------------------------------------------------
// Struct: Container (exercises nested struct and group fields)
// ---------------------------------------------------------------------------

interface Inner {
  value: number;
  label: string;
}

const InnerDescriptor: StructDescriptor<Inner> = {
  kind: "struct",
  name: "Inner",
  dataWordCount: 1,
  pointerCount: 1,
  createDefault: () => ({
    value: 0,
    label: "",
  }),
  fields: [
    { kind: "slot", name: "value", offset: 0, type: TYPE_UINT32 },
    { kind: "slot", name: "label", offset: 0, type: TYPE_TEXT },
  ],
};

interface GroupFields {
  x: number;
  y: number;
}

const GroupFieldsDescriptor: StructDescriptor<GroupFields> = {
  kind: "struct",
  name: "GroupFields",
  dataWordCount: 1,
  pointerCount: 0,
  createDefault: () => ({
    x: 0,
    y: 0,
  }),
  fields: [
    { kind: "slot", name: "x", offset: 0, type: TYPE_UINT16 },
    { kind: "slot", name: "y", offset: 1, type: TYPE_UINT16 },
  ],
};

export interface Container {
  inner: Inner;
  items: Inner[];
  coords: GroupFields;
}

export const ContainerDescriptor: StructDescriptor<Container> = {
  kind: "struct",
  name: "Container",
  dataWordCount: 1,
  pointerCount: 2,
  createDefault: () => ({
    inner: InnerDescriptor.createDefault(),
    items: [],
    coords: GroupFieldsDescriptor.createDefault(),
  }),
  fields: [
    {
      kind: "slot",
      name: "inner",
      offset: 0,
      type: { kind: "struct", get: () => InnerDescriptor },
    },
    {
      kind: "slot",
      name: "items",
      offset: 1,
      type: {
        kind: "list",
        element: { kind: "struct", get: () => InnerDescriptor },
      },
    },
    {
      kind: "group",
      name: "coords",
      type: { kind: "struct", get: () => GroupFieldsDescriptor },
    },
  ],
};

export const ContainerCodec: StructCodec<Container> = {
  encode: (value: Container): Uint8Array =>
    encodeStructMessage(ContainerDescriptor, value),
  decode: (bytes: Uint8Array): Container =>
    decodeStructMessage(ContainerDescriptor, bytes),
};

// ---------------------------------------------------------------------------
// Struct: UnionExample (exercises union/discriminant support)
// ---------------------------------------------------------------------------

export interface UnionExample {
  which?: "text" | "number" | "flag";
  text?: string;
  number?: number;
  flag?: boolean;
}

export const UnionExampleDescriptor: StructDescriptor<UnionExample> = {
  kind: "struct",
  name: "UnionExample",
  dataWordCount: 1,
  pointerCount: 1,
  createDefault: () => ({
    text: "",
    number: 0,
    flag: false,
    which: "text",
  }),
  union: {
    discriminantOffset: 2,
    defaultDiscriminant: 0,
    byName: {
      "text": 0,
      "number": 1,
      "flag": 2,
    },
    byDiscriminant: {
      0: "text",
      1: "number",
      2: "flag",
    },
  },
  fields: [
    {
      kind: "slot",
      name: "text",
      offset: 0,
      type: TYPE_TEXT,
      discriminantValue: 0,
    },
    {
      kind: "slot",
      name: "number",
      offset: 0,
      type: TYPE_UINT32,
      discriminantValue: 1,
    },
    {
      kind: "slot",
      name: "flag",
      offset: 0,
      type: TYPE_BOOL,
      discriminantValue: 2,
    },
  ],
};

export const UnionExampleCodec: StructCodec<UnionExample> = {
  encode: (value: UnionExample): Uint8Array =>
    encodeStructMessage(UnionExampleDescriptor, value),
  decode: (bytes: Uint8Array): UnionExample =>
    decodeStructMessage(UnionExampleDescriptor, bytes),
};

// ---------------------------------------------------------------------------
// Struct: PingParams / PingResults (exercises empty RPC param/result structs)
// ---------------------------------------------------------------------------

// deno-lint-ignore no-empty-interface
export interface PingParams {
}

export const PingParamsDescriptor: StructDescriptor<PingParams> = {
  kind: "struct",
  name: "PingParams",
  dataWordCount: 0,
  pointerCount: 0,
  createDefault: () => ({}),
  fields: [],
};

export const PingParamsCodec: StructCodec<PingParams> = {
  encode: (value: PingParams): Uint8Array =>
    encodeStructMessage(PingParamsDescriptor, value),
  decode: (bytes: Uint8Array): PingParams =>
    decodeStructMessage(PingParamsDescriptor, bytes),
};

// deno-lint-ignore no-empty-interface
export interface PingResults {
}

export const PingResultsDescriptor: StructDescriptor<PingResults> = {
  kind: "struct",
  name: "PingResults",
  dataWordCount: 0,
  pointerCount: 0,
  createDefault: () => ({}),
  fields: [],
};

export const PingResultsCodec: StructCodec<PingResults> = {
  encode: (value: PingResults): Uint8Array =>
    encodeStructMessage(PingResultsDescriptor, value),
  decode: (bytes: Uint8Array): PingResults =>
    decodeStructMessage(PingResultsDescriptor, bytes),
};
