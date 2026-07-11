/**
 * Shared helper functions for the emitter: type mapping, name resolution,
 * formatting, and collection utilities.
 */

import type {
  CodeGeneratorRequestModel,
  FieldModel,
  NodeModel,
  TypeModel,
} from "./model.ts";

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

export type OutputModuleSuffix =
  | "capnp"
  | "rpc"
  | "types"
  | "meta"
  | "wire_constants";

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

/**
 * Assign deterministic per-module TypeScript names to a naming pool.
 *
 * This is the single naming/uniquing pass shared by the per-module local
 * tables ({@link collectLocalTypes}, {@link collectLocalInterfaces}) and the
 * cross-file {@link buildModuleIndex}, so index names always match what the
 * owning module actually exports.
 */
function assignTypeNames(nodes: NodeModel[]): Map<bigint, string> {
  const usedTypeNames = new Set<string>();
  const typeNameById = new Map<bigint, string>();
  for (const node of nodes) {
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
  return typeNameById;
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

  const typeNameById = assignTypeNames([...localEnums, ...localStructs]);

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

  const typeNameById = assignTypeNames(localInterfaces);
  return localInterfaces.map((node): InterfaceInfo => ({
    id: node.id,
    typeName: typeNameById.get(node.id) ?? "GeneratedInterface",
    node,
  }));
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

// ---------------------------------------------------------------------------
// Cross-file module index + per-module import collection
// ---------------------------------------------------------------------------

/** One request-wide index entry: a named type and the module that owns it. */
export type ModuleIndexEntry =
  | {
    kind: "enum";
    fileId: bigint;
    schemaFilename: string;
    info: EnumInfo;
  }
  | {
    kind: "struct";
    fileId: bigint;
    schemaFilename: string;
    info: StructInfo;
  }
  | {
    kind: "interface";
    fileId: bigint;
    schemaFilename: string;
    info: InterfaceInfo;
  };

export interface ModuleFileTypes {
  enumInfos: EnumInfo[];
  structInfos: StructInfo[];
  interfaceInfos: InterfaceInfo[];
}

/**
 * Request-wide node-id -> owning-module index.
 *
 * Maps every enum/struct/interface node in the request (requested files AND
 * import-only files) to the schema file that owns it and the TypeScript name
 * its generated module exports for it.
 */
export interface ModuleIndex {
  readonly byId: Map<bigint, ModuleIndexEntry>;
  readonly byFileId: Map<bigint, ModuleFileTypes>;
}

/**
 * Build the {@link ModuleIndex} for a request.
 *
 * Per-file names come from the exact same collection + naming pass the
 * per-module emitters use ({@link collectLocalTypes} /
 * {@link collectLocalInterfaces}), so cross-file references always agree with
 * the owning module's actual exports. The owning schema filename prefers the
 * requested-file spelling and falls back to the file node's display name for
 * import-only files (capnp records the resolved path there).
 */
export function buildModuleIndex(
  request: CodeGeneratorRequestModel,
  nodeById: Map<bigint, NodeModel>,
): ModuleIndex {
  const filenameByFileId = new Map<bigint, string>();
  for (const requested of request.requestedFiles) {
    filenameByFileId.set(requested.id, requested.filename);
  }

  const byId = new Map<bigint, ModuleIndexEntry>();
  const byFileId = new Map<bigint, ModuleFileTypes>();
  for (const node of request.nodes) {
    if (node.kind !== "file") continue;
    const schemaFilename = filenameByFileId.get(node.id) ?? node.displayName;
    const { enumInfos, structInfos } = collectLocalTypes(node, nodeById);
    const interfaceInfos = collectLocalInterfaces(node, nodeById);
    byFileId.set(node.id, { enumInfos, structInfos, interfaceInfos });
    for (const info of enumInfos) {
      byId.set(info.id, {
        kind: "enum",
        fileId: node.id,
        schemaFilename,
        info,
      });
    }
    for (const info of structInfos) {
      byId.set(info.id, {
        kind: "struct",
        fileId: node.id,
        schemaFilename,
        info,
      });
    }
    for (const info of interfaceInfos) {
      byId.set(info.id, {
        kind: "interface",
        fileId: node.id,
        schemaFilename,
        info,
      });
    }
  }
  return { byId, byFileId };
}

/** Cross-module import recorded on a generated file for layout-aware fixup. */
export interface CrossSchemaImportRef {
  /** Flat sibling specifier as emitted, e.g. `"./base_types.ts"`. */
  specifier: string;
  /** Schema source filename of the module the specifier points at. */
  targetSourceFilename: string;
}

interface CollectedModuleImports {
  specifier: string;
  targetSourceFilename: string;
  /** exported name -> local alias */
  types: Map<string, string>;
  /** exported name -> local alias */
  values: Map<string, string>;
}

interface EnumImportMirror {
  typeAlias: string;
  valuesConst: string;
  descriptorConst: string;
  values: string[];
}

/**
 * Per-module collector for cross-file references.
 *
 * Records `import type` entries for type-position names and value imports for
 * codec/descriptor references (consumed only inside deferred getters, per the
 * cross-file design), and materializes local descriptor mirrors for imported
 * enums (whose descriptors are module-private in the owning module). Aliases
 * are chosen deterministically and never collide with the module's own
 * declarations.
 */
export class ModuleImportCollector {
  readonly #fileId: bigint;
  readonly #reservedNames: Set<string>;
  readonly #moduleIndex: ModuleIndex;
  readonly #modules = new Map<string, CollectedModuleImports>();
  readonly #aliasByKey = new Map<string, string>();
  readonly #enumMirrors = new Map<bigint, EnumImportMirror>();

  constructor(options: {
    fileId: bigint;
    moduleIndex: ModuleIndex;
    reservedNames: Iterable<string>;
  }) {
    this.#fileId = options.fileId;
    this.#moduleIndex = options.moduleIndex;
    this.#reservedNames = new Set(options.reservedNames);
  }

  /**
   * Resolve a node id to an importable cross-file entry: the id must belong
   * to another schema file in the request and be exported by that file's
   * generated module. Returns `null` for local ids, unknown ids, and
   * non-exported foreign types (callers keep their existing fallbacks).
   */
  crossFileEntry(id: bigint): ModuleIndexEntry | null {
    const entry = this.#moduleIndex.byId.get(id);
    if (!entry || entry.fileId === this.#fileId) return null;
    if (entry.kind === "enum" || entry.kind === "struct") {
      return entry.info.exported ? entry : null;
    }
    return entry;
  }

  /** Import a cross-file enum/struct type name (type position). */
  importTypeName(entry: ModuleIndexEntry): string {
    return this.#importName(entry, entry.info.typeName, "types");
  }

  /** Import a cross-file exported value (codec/descriptor const). */
  importValueName(entry: ModuleIndexEntry, exportedName: string): string {
    return this.#importName(entry, exportedName, "values");
  }

  /**
   * Get (or create) the local descriptor mirror for an imported enum. The
   * owning module does not export enum descriptors, so the importing module
   * re-materializes the values/descriptor consts from the schema nodes; only
   * the enum's TypeScript type is imported.
   */
  enumMirror(entry: ModuleIndexEntry & { kind: "enum" }): EnumImportMirror {
    const existing = this.#enumMirrors.get(entry.info.id);
    if (existing) return existing;
    const typeAlias = this.importTypeName(entry);
    const mirror: EnumImportMirror = {
      typeAlias,
      valuesConst: this.#claimLocalName(`${typeAlias}Values`),
      descriptorConst: this.#claimLocalName(`${typeAlias}Type`),
      values: entry.info.values,
    };
    this.#enumMirrors.set(entry.info.id, mirror);
    return mirror;
  }

  hasImports(): boolean {
    return this.#modules.size > 0;
  }

  /** Render the sibling-module import lines (sorted, deterministic). */
  renderImportLines(): string[] {
    const out: string[] = [];
    const modules = [...this.#modules.values()].sort((left, right) =>
      left.specifier.localeCompare(right.specifier)
    );
    for (const module of modules) {
      const typeEntries = renderImportEntries(module.types);
      if (typeEntries.length > 0) {
        out.push(
          `import type { ${typeEntries.join(", ")} } from ${
            JSON.stringify(module.specifier)
          };`,
        );
      }
      const valueEntries = renderImportEntries(module.values);
      if (valueEntries.length > 0) {
        out.push(
          `import { ${valueEntries.join(", ")} } from ${
            JSON.stringify(module.specifier)
          };`,
        );
      }
    }
    return out;
  }

  /** Render local descriptor mirrors for imported enums (sorted). */
  renderEnumMirrorLines(): string[] {
    const out: string[] = [];
    const mirrors = [...this.#enumMirrors.values()].sort((left, right) =>
      left.descriptorConst.localeCompare(right.descriptorConst)
    );
    for (const mirror of mirrors) {
      const valuesLiteral = mirror.values
        .map((value) => JSON.stringify(value))
        .join(", ");
      out.push(`const ${mirror.valuesConst} = [${valuesLiteral}] as const;`);
      out.push(
        `const ${mirror.descriptorConst}: EnumTypeDescriptor<${mirror.typeAlias}> = {`,
      );
      out.push('  kind: "enum",');
      out.push(`  byOrdinal: ${mirror.valuesConst},`);
      out.push("  toOrdinal: {");
      for (let i = 0; i < mirror.values.length; i += 1) {
        out.push(`    ${JSON.stringify(mirror.values[i])}: ${i},`);
      }
      out.push("  },");
      out.push("};");
      out.push("");
    }
    return out;
  }

  /** Metadata for layout-aware import-specifier fixup in the CLI. */
  crossSchemaImports(): CrossSchemaImportRef[] {
    return [...this.#modules.values()]
      .sort((left, right) => left.specifier.localeCompare(right.specifier))
      .map((module) => ({
        specifier: module.specifier,
        targetSourceFilename: module.targetSourceFilename,
      }));
  }

  #importName(
    entry: ModuleIndexEntry,
    exportedName: string,
    slot: "types" | "values",
  ): string {
    const module = this.#moduleFor(entry);
    const existing = module[slot].get(exportedName);
    if (existing) return existing;
    const aliasKey = `${module.specifier} ${slot} ${exportedName}`;
    let alias = this.#aliasByKey.get(aliasKey);
    if (alias === undefined) {
      alias = this.#claimImportAlias(exportedName, entry.schemaFilename);
      this.#aliasByKey.set(aliasKey, alias);
    }
    module[slot].set(exportedName, alias);
    return alias;
  }

  #moduleFor(entry: ModuleIndexEntry): CollectedModuleImports {
    const specifier = `./${toOutputPath(entry.schemaFilename, "types")}`;
    const existing = this.#modules.get(specifier);
    if (existing) return existing;
    const created: CollectedModuleImports = {
      specifier,
      targetSourceFilename: entry.schemaFilename,
      types: new Map(),
      values: new Map(),
    };
    this.#modules.set(specifier, created);
    return created;
  }

  #claimImportAlias(exportedName: string, schemaFilename: string): string {
    if (!this.#reservedNames.has(exportedName)) {
      this.#reservedNames.add(exportedName);
      return exportedName;
    }
    const stem = toPascalCase(schemaModuleStem(schemaFilename));
    return this.#claimLocalName(`${exportedName}$${stem}`);
  }

  #claimLocalName(base: string): string {
    let candidate = base;
    let suffix = 2;
    while (this.#reservedNames.has(candidate)) {
      candidate = `${base}${suffix}`;
      suffix += 1;
    }
    this.#reservedNames.add(candidate);
    return candidate;
  }
}

function renderImportEntries(entries: Map<string, string>): string[] {
  return [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([exported, alias]) =>
      exported === alias ? exported : `${exported} as ${alias}`
    );
}

function schemaModuleStem(filename: string): string {
  const normalized = filename.replaceAll("\\", "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base.endsWith(".capnp") ? base.slice(0, -6) : base;
}

/**
 * Local function names for one struct's capability walkers: `dehydrate`
 * converts live `RpcStub` proxies in capability fields to raw
 * `CapabilityPointer`s before encoding, `hydrate` wraps decoded capability
 * pointers into typed stubs after decoding.
 */
export interface CapabilityWalkerNames {
  readonly hydrate: string;
  readonly dehydrate: string;
}

/**
 * Shared context threaded through the type-position and descriptor emission
 * helpers: the request-wide node table, the current module's local tables,
 * and the per-module cross-file import collector.
 */
export interface TypeEmitContext {
  nodeById: Map<bigint, NodeModel>;
  enumById: Map<bigint, EnumInfo>;
  structById: Map<bigint, StructInfo>;
  imports: ModuleImportCollector;
  /** Local interface id -> high-level service type name (typed stub fields). */
  interfaceNameById?: ReadonlyMap<bigint, string>;
  /** Cap-bearing struct id -> capability walker names (codec dehydration). */
  capabilityWalkers?: ReadonlyMap<bigint, CapabilityWalkerNames>;
}

/**
 * Resolve an interface id to the TypeScript name usable in a typed
 * `RpcStub<T>` position: the local high-level service interface name, or an
 * `import type` alias for interfaces owned by another schema file. Returns
 * `null` for truly-unknown ids (callers keep the `CapabilityPointer` typing).
 */
export function capabilityStubTypeName(
  typeId: bigint,
  ctx: TypeEmitContext,
): string | null {
  const local = ctx.interfaceNameById?.get(typeId);
  if (local) return local;
  const entry = ctx.imports.crossFileEntry(typeId);
  if (entry?.kind === "interface") {
    return ctx.imports.importTypeName(entry);
  }
  return null;
}

export function typeDescriptorExpression(
  type: TypeModel,
  ctx: TypeEmitContext,
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
        typeDescriptorExpression(type.elementType, ctx)
      } }`;
    case "enum": {
      const enumInfo = ctx.enumById.get(type.typeId);
      if (enumInfo) return enumInfo.descriptorConst;
      const entry = ctx.imports.crossFileEntry(type.typeId);
      if (entry?.kind === "enum") {
        return ctx.imports.enumMirror(entry).descriptorConst;
      }
      return "TYPE_UINT16";
    }
    case "struct": {
      const structInfo = ctx.structById.get(type.typeId);
      if (structInfo) {
        return `{ kind: "struct", get: () => ${structInfo.descriptorConst} }`;
      }
      const entry = ctx.imports.crossFileEntry(type.typeId);
      if (entry?.kind === "struct") {
        // Deferred getter: the imported descriptor is only dereferenced at
        // use time, so mutually-importing schema modules cannot hit TDZ.
        const descriptor = ctx.imports.importValueName(
          entry,
          entry.info.descriptorConst,
        );
        return `{ kind: "struct", get: () => ${descriptor} }`;
      }
      return "TYPE_ANY_POINTER";
    }
    case "interface":
      return "TYPE_INTERFACE";
    case "anyPointer":
      return "TYPE_ANY_POINTER";
  }
}

export function defaultValueExpression(
  type: TypeModel,
  ctx: TypeEmitContext,
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
      const info = ctx.enumById.get(type.typeId);
      if (info) {
        if (info.values.length === 0) {
          return `undefined as unknown as ${typeToTs(type, ctx)}`;
        }
        return `${info.valuesConst}[0]`;
      }
      const entry = ctx.imports.crossFileEntry(type.typeId);
      if (entry?.kind === "enum" && entry.info.values.length > 0) {
        return `${ctx.imports.enumMirror(entry).valuesConst}[0]`;
      }
      return `undefined as unknown as ${typeToTs(type, ctx)}`;
    }
    case "struct": {
      const info = ctx.structById.get(type.typeId);
      if (info) return `${info.descriptorConst}.createDefault()`;
      const entry = ctx.imports.crossFileEntry(type.typeId);
      if (entry?.kind === "struct") {
        // Evaluated inside the surrounding createDefault() lambda, so the
        // imported descriptor is dereferenced lazily (no module-init TDZ).
        const descriptor = ctx.imports.importValueName(
          entry,
          entry.info.descriptorConst,
        );
        return `${descriptor}.createDefault()`;
      }
      return `undefined as unknown as ${typeToTs(type, ctx)}`;
    }
    case "interface":
      return "null";
    case "anyPointer":
      return '{ kind: "null" }';
  }
}

export function typeToTs(
  type: TypeModel,
  ctx: TypeEmitContext,
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
    case "list": {
      const element = typeToTs(type.elementType, ctx);
      return element.includes(" | ") ? `(${element})[]` : `${element}[]`;
    }
    case "enum":
    case "struct":
      return resolveTypeName(type.typeId, ctx);
    case "interface": {
      const stubType = capabilityStubTypeName(type.typeId, ctx);
      if (stubType) return `RpcStub<${stubType}> | null`;
      return "CapabilityPointer | null";
    }
    case "anyPointer":
      return "AnyPointerValue";
  }
}

export function resolveTypeName(
  id: bigint,
  ctx: TypeEmitContext,
): string {
  const enumInfo = ctx.enumById.get(id);
  if (enumInfo) return enumInfo.typeName;
  const structInfo = ctx.structById.get(id);
  if (structInfo) return structInfo.typeName;
  const entry = ctx.imports.crossFileEntry(id);
  if (entry && (entry.kind === "enum" || entry.kind === "struct")) {
    return ctx.imports.importTypeName(entry);
  }
  const node = ctx.nodeById.get(id);
  if (!node) return "unknown";
  const simple = simpleNodeName(node);
  return toPascalCase(simple);
}
