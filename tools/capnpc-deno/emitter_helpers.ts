/**
 * Shared helper functions for the emitter: type mapping, name resolution,
 * formatting, and collection utilities.
 */

import type { FieldModel, NodeModel, TypeModel } from "./model.ts";

export interface EnumInfo {
  readonly id: bigint;
  readonly typeName: string;
  readonly valuesConst: string;
  readonly descriptorConst: string;
  readonly values: string[];
  readonly exported: boolean;
}

export interface StructInfo {
  readonly id: bigint;
  readonly typeName: string;
  readonly descriptorConst: string;
  readonly codecConst: string;
  readonly node: NodeModel;
  readonly exported: boolean;
}

export interface InterfaceInfo {
  readonly id: bigint;
  readonly typeName: string;
  readonly node: NodeModel;
}

export const FIELD_NO_DISCRIMINANT = 0xffff;

export type OutputModuleSuffix = "capnp" | "rpc" | "types" | "meta";

export function toOutputPath(
  filename: string,
  suffix: OutputModuleSuffix,
): string {
  const normalized = filename.replaceAll("\\", "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const withoutExt = base.endsWith(".capnp") ? base.slice(0, -6) : base;
  return `${withoutExt}_${suffix}.ts`;
}

export function formatBigint(value: bigint): string {
  return `0x${value.toString(16)}n`;
}

export function toPascalCase(value: string): string {
  const words = value
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return "GeneratedType";
  return words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join("");
}

export function toCamelCase(value: string): string {
  const pascal = toPascalCase(value);
  if (pascal.length === 0) return "field";
  return `${pascal.charAt(0).toLowerCase()}${pascal.slice(1)}`;
}

export function quoteIfNeeded(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

export function simpleNodeName(node: NodeModel): string {
  if (node.displayNamePrefixLength >= node.displayName.length) {
    return node.displayName;
  }
  return node.displayName.slice(node.displayNamePrefixLength);
}

export function collectLocalTypes(
  fileNode: NodeModel,
  nodeById: Map<bigint, NodeModel>,
): { enumInfos: EnumInfo[]; structInfos: StructInfo[] } {
  const prefix = `${fileNode.displayName}:`;
  const exportedIds = new Set(fileNode.nestedNodes.map((nested) => nested.id));
  const localEnums: NodeModel[] = [];
  const localStructs: NodeModel[] = [];
  const methodStructIds = new Set<bigint>();
  for (const node of nodeById.values()) {
    if (!node.displayName.startsWith(prefix)) continue;
    if (node.kind === "enum" && node.enumNode) localEnums.push(node);
    if (node.kind === "struct" && node.structNode) localStructs.push(node);
    if (node.kind === "interface" && node.interfaceNode) {
      for (const method of node.interfaceNode.methods) {
        methodStructIds.add(method.paramStructTypeId);
        methodStructIds.add(method.resultStructTypeId);
      }
    }
  }
  for (const typeId of methodStructIds) {
    exportedIds.add(typeId);
  }
  localEnums.sort((a, b) => a.displayName.localeCompare(b.displayName));
  localStructs.sort((a, b) => a.displayName.localeCompare(b.displayName));

  const usedTypeNames = new Set<string>();
  const typeNameById = new Map<bigint, string>();
  for (const node of [...localEnums, ...localStructs]) {
    const base = toPascalCase(simpleNodeName(node));
    let candidate = base;
    let suffix = 2;
    while (usedTypeNames.has(candidate)) {
      candidate = `${base}${suffix}`;
      suffix += 1;
    }
    usedTypeNames.add(candidate);
    typeNameById.set(node.id, candidate);
  }

  const enumInfos = localEnums.map((node): EnumInfo => {
    const typeName = typeNameById.get(node.id) ?? "GeneratedEnum";
    const valuesConst = `${typeName}Values`;
    const descriptorConst = `${typeName}Type`;
    const values = node.enumNode!.enumerants
      .slice()
      .sort((a, b) => a.codeOrder - b.codeOrder)
      .map((enumerant) => enumerant.name);
    return {
      id: node.id,
      typeName,
      valuesConst,
      descriptorConst,
      values,
      exported: exportedIds.has(node.id),
    };
  });

  const structInfos = localStructs.map((node): StructInfo => {
    const typeName = typeNameById.get(node.id) ?? "GeneratedStruct";
    return {
      id: node.id,
      typeName,
      descriptorConst: `${typeName}Struct`,
      codecConst: `${typeName}Codec`,
      node,
      exported: exportedIds.has(node.id),
    };
  });

  return { enumInfos, structInfos };
}

export function collectLocalInterfaces(
  fileNode: NodeModel,
  nodeById: Map<bigint, NodeModel>,
): InterfaceInfo[] {
  const prefix = `${fileNode.displayName}:`;
  const localInterfaces = [...nodeById.values()]
    .filter((node) =>
      node.displayName.startsWith(prefix) &&
      node.kind === "interface" &&
      node.interfaceNode !== undefined
    )
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const usedTypeNames = new Set<string>();
  const out: InterfaceInfo[] = [];
  for (const node of localInterfaces) {
    const base = toPascalCase(simpleNodeName(node));
    let candidate = base;
    let suffix = 2;
    while (usedTypeNames.has(candidate)) {
      candidate = `${base}${suffix}`;
      suffix += 1;
    }
    usedTypeNames.add(candidate);
    out.push({
      id: node.id,
      typeName: candidate,
      node,
    });
  }
  return out;
}

export function inferUnionFields(
  fields: FieldModel[],
  discriminantCount: number,
): FieldModel[] {
  if (discriminantCount <= 0) return [];
  const explicit = fields.filter((field) =>
    field.discriminantValue !== FIELD_NO_DISCRIMINANT
  );
  if (explicit.length === discriminantCount) {
    return explicit.slice().sort((a, b) =>
      (a.discriminantValue - b.discriminantValue) ||
      (a.codeOrder - b.codeOrder)
    );
  }

  const byDiscriminant = new Map<number, FieldModel[]>();
  for (const field of explicit) {
    const list = byDiscriminant.get(field.discriminantValue) ?? [];
    list.push(field);
    byDiscriminant.set(field.discriminantValue, list);
  }
  const uniqueByDiscriminant = [...byDiscriminant.values()].filter((list) =>
    list.length === 1
  ).map((list) => list[0]).sort((a, b) =>
    (a.discriminantValue - b.discriminantValue) ||
    (a.codeOrder - b.codeOrder)
  );
  if (uniqueByDiscriminant.length >= discriminantCount) {
    return uniqueByDiscriminant.slice(0, discriminantCount);
  }

  // Fallback for malformed/legacy requests: keep deterministic tail behavior.
  return fields.slice(-discriminantCount);
}

export function typeDescriptorExpression(
  type: TypeModel,
  enumById: Map<bigint, EnumInfo>,
  structById: Map<bigint, StructInfo>,
): string {
  switch (type.kind) {
    case "void":
      return "TYPE_VOID";
    case "bool":
      return "TYPE_BOOL";
    case "int8":
      return "TYPE_INT8";
    case "int16":
      return "TYPE_INT16";
    case "int32":
      return "TYPE_INT32";
    case "int64":
      return "TYPE_INT64";
    case "uint8":
      return "TYPE_UINT8";
    case "uint16":
      return "TYPE_UINT16";
    case "uint32":
      return "TYPE_UINT32";
    case "uint64":
      return "TYPE_UINT64";
    case "float32":
      return "TYPE_FLOAT32";
    case "float64":
      return "TYPE_FLOAT64";
    case "text":
      return "TYPE_TEXT";
    case "data":
      return "TYPE_DATA";
    case "list":
      return `{ kind: "list", element: ${
        typeDescriptorExpression(type.elementType, enumById, structById)
      } }`;
    case "enum": {
      const enumInfo = enumById.get(type.typeId);
      return enumInfo ? enumInfo.descriptorConst : "TYPE_UINT16";
    }
    case "struct": {
      const structInfo = structById.get(type.typeId);
      if (!structInfo) return "TYPE_ANY_POINTER";
      return `{ kind: "struct", get: () => ${structInfo.descriptorConst} }`;
    }
    case "interface":
      return "TYPE_INTERFACE";
    case "anyPointer":
      return "TYPE_ANY_POINTER";
  }
}

export function defaultValueExpression(
  type: TypeModel,
  nodeById: Map<bigint, NodeModel>,
  enumById: Map<bigint, EnumInfo>,
  structById: Map<bigint, StructInfo>,
): string {
  switch (type.kind) {
    case "void":
      return "undefined";
    case "bool":
      return "false";
    case "int8":
    case "int16":
    case "int32":
    case "uint8":
    case "uint16":
    case "uint32":
    case "float32":
    case "float64":
      return "0";
    case "int64":
    case "uint64":
      return "0n";
    case "text":
      return '""';
    case "data":
      return "new Uint8Array(0)";
    case "list":
      return "[]";
    case "enum": {
      const info = enumById.get(type.typeId);
      if (!info || info.values.length === 0) {
        return `undefined as unknown as ${
          typeToTs(type, nodeById, enumById, structById)
        }`;
      }
      return `${info.valuesConst}[0]`;
    }
    case "struct": {
      const info = structById.get(type.typeId);
      if (!info) {
        return `undefined as unknown as ${
          typeToTs(type, nodeById, enumById, structById)
        }`;
      }
      return `${info.descriptorConst}.createDefault()`;
    }
    case "interface":
      return "null";
    case "anyPointer":
      return '{ kind: "null" }';
  }
}

export function typeToTs(
  type: TypeModel,
  nodeById: Map<bigint, NodeModel>,
  enumById: Map<bigint, EnumInfo>,
  structById: Map<bigint, StructInfo>,
): string {
  switch (type.kind) {
    case "void":
      return "undefined";
    case "bool":
      return "boolean";
    case "int8":
    case "int16":
    case "int32":
    case "uint8":
    case "uint16":
    case "uint32":
    case "float32":
    case "float64":
      return "number";
    case "int64":
    case "uint64":
      return "bigint";
    case "text":
      return "string";
    case "data":
      return "Uint8Array";
    case "list":
      return `${typeToTs(type.elementType, nodeById, enumById, structById)}[]`;
    case "enum":
    case "struct":
      return resolveTypeName(type.typeId, nodeById, enumById, structById);
    case "interface":
      return "CapabilityPointer | null";
    case "anyPointer":
      return "AnyPointerValue";
  }
}

export function resolveTypeName(
  id: bigint,
  nodeById: Map<bigint, NodeModel>,
  enumById: Map<bigint, EnumInfo>,
  structById: Map<bigint, StructInfo>,
): string {
  const enumInfo = enumById.get(id);
  if (enumInfo) return enumInfo.typeName;
  const structInfo = structById.get(id);
  if (structInfo) return structInfo.typeName;
  const node = nodeById.get(id);
  if (!node) return "unknown";
  const simple = simpleNodeName(node);
  return toPascalCase(simple);
}
