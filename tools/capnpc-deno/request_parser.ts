import { CapnpReader, type StructReader } from "./capnp_reader.ts";
import type {
  CodeGeneratorRequestModel,
  EnumNodeModel,
  FieldModel,
  InterfaceNodeModel,
  NodeKind,
  NodeModel,
  RequestedFileModel,
  StructNodeModel,
  TypeModel,
} from "./model.ts";

const NODE_KIND_BY_TAG: Record<number, NodeKind> = {
  0: "file",
  1: "struct",
  2: "enum",
  3: "interface",
  4: "const",
  5: "annotation",
};

const FIELD_NO_DISCRIMINANT = 0xffff;

export function parseCodeGeneratorRequest(
  bytes: Uint8Array,
): CodeGeneratorRequestModel {
  const reader = new CapnpReader(bytes);
  const root = reader.root();
  return {
    nodes: parseNodes(root),
    requestedFiles: parseRequestedFiles(root),
  };
}

function parseNodes(root: StructReader): NodeModel[] {
  const list = root.readStructList(0);
  if (!list) return [];

  const out: NodeModel[] = [];
  for (let i = 0; i < list.len(); i += 1) {
    out.push(parseNode(list.get(i)));
  }
  return out;
}

function parseNode(reader: StructReader): NodeModel {
  const kindTag = reader.readU16(12);
  const kind = NODE_KIND_BY_TAG[kindTag];
  if (!kind) throw new Error(`unsupported node kind tag: ${kindTag}`);

  const model: NodeModel = {
    id: reader.readU64(0),
    displayName: reader.readText(0) ?? "",
    displayNamePrefixLength: reader.readU32(8),
    scopeId: reader.readU64(16),
    nestedNodes: parseNestedNodes(reader),
    kind,
  };

  if (kind === "struct") {
    model.structNode = parseStructNode(reader);
  } else if (kind === "enum") {
    model.enumNode = parseEnumNode(reader);
  } else if (kind === "interface") {
    model.interfaceNode = parseInterfaceNode(reader);
  }

  return model;
}

function parseNestedNodes(reader: StructReader): NodeModel["nestedNodes"] {
  const list = reader.readStructList(1);
  if (!list) return [];

  const out: NodeModel["nestedNodes"] = [];
  for (let i = 0; i < list.len(); i += 1) {
    const item = list.get(i);
    out.push({
      name: item.readText(0) ?? "",
      id: item.readU64(0),
    });
  }
  return out;
}

function parseStructNode(reader: StructReader): StructNodeModel {
  return {
    dataWordCount: reader.readU16(14),
    pointerCount: reader.readU16(24),
    isGroup: reader.readBool(28, 0),
    discriminantCount: reader.readU16(30),
    discriminantOffset: reader.readU32(32),
    fields: parseFields(reader),
  };
}

function parseEnumNode(reader: StructReader): EnumNodeModel {
  const list = reader.readStructList(3);
  if (!list) return { enumerants: [] };

  const enumerants: EnumNodeModel["enumerants"] = [];
  for (let i = 0; i < list.len(); i += 1) {
    const item = list.get(i);
    enumerants.push({
      name: item.readText(0) ?? "",
      codeOrder: item.readU16(0),
    });
  }
  return { enumerants };
}

function parseFields(reader: StructReader): FieldModel[] {
  const list = reader.readStructList(3);
  if (!list) return [];

  const fields: FieldModel[] = [];
  for (let i = 0; i < list.len(); i += 1) {
    fields.push(parseField(list.get(i)));
  }
  return fields;
}

function parseInterfaceNode(reader: StructReader): InterfaceNodeModel {
  const list = reader.readStructList(3);
  if (!list) return { methods: [] };

  const methods: InterfaceNodeModel["methods"] = [];
  for (let i = 0; i < list.len(); i += 1) {
    const item = list.get(i);
    methods.push({
      name: item.readText(0) ?? "",
      codeOrder: item.readU16(0),
      paramStructTypeId: item.readU64(8),
      resultStructTypeId: item.readU64(16),
    });
  }
  return { methods };
}

function parseField(reader: StructReader): FieldModel {
  const field: FieldModel = {
    name: reader.readText(0) ?? "",
    codeOrder: reader.readU16(0),
    // Field.discriminantValue has default 0xffff and is encoded xor-default.
    discriminantValue: reader.readU16(2) ^ FIELD_NO_DISCRIMINANT,
  };

  const which = reader.readU16(8);
  if (which === 0) {
    const typeReader = reader.readStruct(2);
    if (!typeReader) throw new Error("field slot missing type");
    field.slot = {
      offset: reader.readU32(4),
      type: parseType(typeReader),
    };
  } else if (which === 1) {
    field.group = {
      typeId: reader.readU64(16),
    };
  } else {
    throw new Error(`unsupported field kind tag: ${which}`);
  }

  return field;
}

function parseType(reader: StructReader): TypeModel {
  const which = reader.readU16(0);
  switch (which) {
    case 0:
      return { kind: "void" };
    case 1:
      return { kind: "bool" };
    case 2:
      return { kind: "int8" };
    case 3:
      return { kind: "int16" };
    case 4:
      return { kind: "int32" };
    case 5:
      return { kind: "int64" };
    case 6:
      return { kind: "uint8" };
    case 7:
      return { kind: "uint16" };
    case 8:
      return { kind: "uint32" };
    case 9:
      return { kind: "uint64" };
    case 10:
      return { kind: "float32" };
    case 11:
      return { kind: "float64" };
    case 12:
      return { kind: "text" };
    case 13:
      return { kind: "data" };
    case 14: {
      const elementReader = reader.readStruct(0);
      if (!elementReader) throw new Error("list type missing element type");
      return {
        kind: "list",
        elementType: parseType(elementReader),
      };
    }
    case 15:
      return { kind: "enum", typeId: reader.readU64(8) };
    case 16:
      return { kind: "struct", typeId: reader.readU64(8) };
    case 17:
      return { kind: "interface", typeId: reader.readU64(8) };
    case 18:
      return { kind: "anyPointer" };
    default:
      throw new Error(`unsupported type kind tag: ${which}`);
  }
}

function parseRequestedFiles(root: StructReader): RequestedFileModel[] {
  const list = root.readStructList(1);
  if (!list) return [];

  const out: RequestedFileModel[] = [];
  for (let i = 0; i < list.len(); i += 1) {
    const file = list.get(i);
    out.push({
      id: file.readU64(0),
      filename: file.readText(0) ?? "",
      imports: parseImports(file),
    });
  }
  return out;
}

function parseImports(reader: StructReader): RequestedFileModel["imports"] {
  const list = reader.readStructList(1);
  if (!list) return [];

  const out: RequestedFileModel["imports"] = [];
  for (let i = 0; i < list.len(); i += 1) {
    const item = list.get(i);
    out.push({
      id: item.readU64(0),
      name: item.readText(0) ?? "",
    });
  }
  return out;
}
