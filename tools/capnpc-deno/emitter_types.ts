/**
 * Struct, enum, and union type emission functions.
 */

import type { NodeModel } from "./model.ts";
import type { EnumInfo, StructInfo } from "./emitter_helpers.ts";
import {
  defaultValueExpression,
  inferUnionFields,
  quoteIfNeeded,
  resolveTypeName,
  toCamelCase,
  typeDescriptorExpression,
  typeToTs,
} from "./emitter_helpers.ts";

export function emitEnum(out: string[], info: EnumInfo): void {
  const valuesLiteral = info.values.map((value) => JSON.stringify(value)).join(", ");
  const exportPrefix = info.exported ? "export " : "";
  out.push(`${exportPrefix}const ${info.valuesConst} = [${valuesLiteral}] as const;`);
  out.push(`${exportPrefix}type ${info.typeName} = typeof ${info.valuesConst}[number];`);
  out.push(`const ${info.descriptorConst}: EnumTypeDescriptor<${info.typeName}> = {`);
  out.push('  kind: "enum",');
  out.push(`  byOrdinal: ${info.valuesConst},`);
  out.push("  toOrdinal: {");
  for (let i = 0; i < info.values.length; i += 1) {
    out.push(`    ${JSON.stringify(info.values[i])}: ${i},`);
  }
  out.push("  },");
  out.push("};");
  out.push("");
}

export function emitStructInterface(
  out: string[],
  structInfo: StructInfo,
  nodeById: Map<bigint, NodeModel>,
  enumById: Map<bigint, EnumInfo>,
  structById: Map<bigint, StructInfo>,
): void {
  const structNode = structInfo.node.structNode;
  if (!structNode) return;

  const exportPrefix = structInfo.exported ? "export " : "";
  out.push(`${exportPrefix}interface ${structInfo.typeName} {`);
  const fields = structNode.fields.slice().sort((a, b) => a.codeOrder - b.codeOrder)
    .filter((field) => field.slot !== undefined || field.group !== undefined);
  const unionFields = inferUnionFields(fields, structNode.discriminantCount);
  const unionFieldNames = new Set(unionFields.map((field) => toCamelCase(field.name)));

  if (unionFields.length > 0) {
    const unionType = unionFields.map((field) => JSON.stringify(toCamelCase(field.name)))
      .join(" | ");
    out.push(`  which?: ${unionType};`);
  }

  for (const field of fields) {
    const fieldName = toCamelCase(field.name);
    const optionalMark = unionFieldNames.has(fieldName) ? "?" : "";
    let tsType: string;
    if (field.slot) {
      tsType = typeToTs(field.slot.type, nodeById, enumById, structById);
    } else if (field.group) {
      tsType = resolveTypeName(field.group.typeId, nodeById, enumById, structById);
    } else {
      continue;
    }
    out.push(`  ${quoteIfNeeded(fieldName)}${optionalMark}: ${tsType};`);
  }
  out.push("}");
  out.push("");
}

export function emitStructDescriptor(
  out: string[],
  structInfo: StructInfo,
  nodeById: Map<bigint, NodeModel>,
  enumById: Map<bigint, EnumInfo>,
  structById: Map<bigint, StructInfo>,
): void {
  const structNode = structInfo.node.structNode;
  if (!structNode) return;

  const fields = structNode.fields.slice().sort((a, b) => a.codeOrder - b.codeOrder)
    .filter((field) => field.slot !== undefined || field.group !== undefined);
  const unionFields = inferUnionFields(fields, structNode.discriminantCount);
  const unionFieldNames = new Set(unionFields.map((field) => toCamelCase(field.name)));
  const defaultUnionField = unionFields[0];

  out.push(`${structInfo.exported ? "export " : ""}const ${structInfo.descriptorConst}: StructDescriptor<${structInfo.typeName}> = {`);
  out.push('  kind: "struct",');
  out.push(`  name: ${JSON.stringify(structInfo.typeName)},`);
  out.push(`  dataWordCount: ${structNode.dataWordCount},`);
  out.push(`  pointerCount: ${structNode.pointerCount},`);
  out.push("  createDefault: () => ({");
  for (const field of fields) {
    const fieldName = quoteIfNeeded(toCamelCase(field.name));
    let defaultExpr: string;
    if (field.slot) {
      defaultExpr = defaultValueExpression(
        field.slot.type,
        nodeById,
        enumById,
        structById,
      );
    } else if (field.group) {
      const groupInfo = structById.get(field.group.typeId);
      defaultExpr = groupInfo
        ? `${groupInfo.descriptorConst}.createDefault()`
        : "{} as Record<string, unknown>";
    } else {
      continue;
    }
    out.push(`    ${fieldName}: ${defaultExpr},`);
  }
  if (defaultUnionField) {
    out.push(`    which: ${JSON.stringify(toCamelCase(defaultUnionField.name))},`);
  }
  out.push("  }),");
  if (defaultUnionField) {
    out.push("  union: {");
    out.push(`    discriminantOffset: ${structNode.discriminantOffset},`);
    out.push(`    defaultDiscriminant: ${defaultUnionField.discriminantValue},`);
    out.push("    byName: {");
    for (const field of unionFields) {
      out.push(
        `      ${JSON.stringify(toCamelCase(field.name))}: ${field.discriminantValue},`,
      );
    }
    out.push("    },");
    out.push("    byDiscriminant: {");
    for (const field of unionFields) {
      out.push(
        `      ${JSON.stringify(field.discriminantValue)}: ${
          JSON.stringify(toCamelCase(field.name))
        },`,
      );
    }
    out.push("    },");
    out.push("  },");
  }
  out.push("  fields: [");
  for (const field of fields) {
    const fieldName = toCamelCase(field.name);
    const inUnion = unionFieldNames.has(fieldName);
    out.push("    {");
    out.push(`      kind: ${field.slot ? JSON.stringify("slot") : JSON.stringify("group")},`);
    out.push(`      name: ${JSON.stringify(fieldName)},`);
    if (field.slot) {
      const typeExpr = typeDescriptorExpression(
        field.slot.type,
        enumById,
        structById,
      );
      out.push(`      offset: ${field.slot.offset},`);
      out.push(`      type: ${typeExpr},`);
    } else if (field.group) {
      const groupInfo = structById.get(field.group.typeId);
      if (!groupInfo) {
        throw new Error(
          `group field ${field.name} references unknown local struct id ${field.group.typeId}`,
        );
      }
      out.push(`      type: { kind: "struct", get: () => ${groupInfo.descriptorConst} },`);
    }
    if (inUnion) {
      out.push(`      discriminantValue: ${field.discriminantValue},`);
    }
    out.push("    },");
  }
  out.push("  ],");
  out.push("};");
  if (structInfo.exported) {
    out.push(`export const ${structInfo.codecConst}: StructCodec<${structInfo.typeName}> = {`);
    out.push(`  encode: (value: ${structInfo.typeName}): Uint8Array =>`);
    out.push(`    encodeStructMessage(${structInfo.descriptorConst}, value),`);
    out.push(`  decode: (bytes: Uint8Array): ${structInfo.typeName} =>`);
    out.push(`    decodeStructMessage(${structInfo.descriptorConst}, bytes),`);
    out.push("};");
  }
  out.push("");
}
