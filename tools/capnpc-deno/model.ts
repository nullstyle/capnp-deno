export type NodeKind =
  | "file"
  | "struct"
  | "enum"
  | "interface"
  | "const"
  | "annotation";

export interface CodeGeneratorRequestModel {
  nodes: NodeModel[];
  requestedFiles: RequestedFileModel[];
}

export interface RequestedFileModel {
  id: bigint;
  filename: string;
  imports: ImportModel[];
}

export interface ImportModel {
  id: bigint;
  name: string;
}

export interface NodeModel {
  id: bigint;
  displayName: string;
  displayNamePrefixLength: number;
  scopeId: bigint;
  nestedNodes: NestedNodeModel[];
  kind: NodeKind;
  structNode?: StructNodeModel;
  enumNode?: EnumNodeModel;
  interfaceNode?: InterfaceNodeModel;
}

export interface NestedNodeModel {
  name: string;
  id: bigint;
}

export interface StructNodeModel {
  dataWordCount: number;
  pointerCount: number;
  isGroup: boolean;
  discriminantCount: number;
  discriminantOffset: number;
  fields: FieldModel[];
}

export interface EnumNodeModel {
  enumerants: EnumerantModel[];
}

export interface EnumerantModel {
  name: string;
  codeOrder: number;
}

export interface InterfaceNodeModel {
  methods: InterfaceMethodModel[];
  superclasses?: bigint[];
}

export interface InterfaceMethodModel {
  name: string;
  codeOrder: number;
  paramStructTypeId: bigint;
  resultStructTypeId: bigint;
}

export interface FieldModel {
  name: string;
  codeOrder: number;
  discriminantValue: number;
  slot?: FieldSlotModel;
  group?: FieldGroupModel;
}

export interface FieldSlotModel {
  offset: number;
  type: TypeModel;
}

export interface FieldGroupModel {
  typeId: bigint;
}

export type TypeModel =
  | { kind: "void" }
  | { kind: "bool" }
  | { kind: "int8" }
  | { kind: "int16" }
  | { kind: "int32" }
  | { kind: "int64" }
  | { kind: "uint8" }
  | { kind: "uint16" }
  | { kind: "uint32" }
  | { kind: "uint64" }
  | { kind: "float32" }
  | { kind: "float64" }
  | { kind: "text" }
  | { kind: "data" }
  | { kind: "list"; elementType: TypeModel }
  | { kind: "enum"; typeId: bigint }
  | { kind: "struct"; typeId: bigint }
  | { kind: "interface"; typeId: bigint }
  | { kind: "anyPointer" };
