/**
 * Thin orchestrator that delegates to focused sub-modules.
 *
 * Public API surface (re-exported unchanged):
 *   - GeneratedFile          (interface)
 *   - generateTypescriptFiles
 *   - renderSingleFileForTest
 *   - renderedFieldNamesForTest
 */

import type {
  CodeGeneratorRequestModel,
  FieldModel,
  NodeModel,
} from "./model.ts";

import { toCamelCase, toOutputPath } from "./emitter_helpers.ts";
import { emitTypesModule } from "./emitter_types_module.ts";
import { emitMetaModule } from "./emitter_meta.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GeneratedFile {
  path: string;
  contents: string;
  sourceFilename?: string;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function generateTypescriptFiles(
  request: CodeGeneratorRequestModel,
): GeneratedFile[] {
  const nodeById = new Map<bigint, NodeModel>();
  for (const node of request.nodes) {
    nodeById.set(node.id, node);
  }

  const files: GeneratedFile[] = [];
  for (const requested of request.requestedFiles) {
    const fileNode = nodeById.get(requested.id);
    if (!fileNode || fileNode.kind !== "file") continue;

    const typesPath = toOutputPath(requested.filename, "types");
    const typesContents = emitTypesModule(fileNode, nodeById);
    files.push({
      path: typesPath,
      contents: typesContents,
      sourceFilename: requested.filename,
    });

    const metaPath = toOutputPath(requested.filename, "meta");
    const metaContents = emitMetaModule(requested, fileNode, nodeById);
    files.push({
      path: metaPath,
      contents: metaContents,
      sourceFilename: requested.filename,
    });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function renderSingleFileForTest(
  request: CodeGeneratorRequestModel,
): string {
  const typesFiles = generateTypescriptFiles(request).filter((file) =>
    file.path.endsWith("_types.ts")
  );
  if (typesFiles.length !== 1) {
    throw new Error(
      `expected exactly one generated types file, got ${typesFiles.length}`,
    );
  }
  return typesFiles[0].contents;
}

export function renderedFieldNamesForTest(fields: FieldModel[]): string[] {
  return fields
    .slice()
    .sort((a, b) => a.codeOrder - b.codeOrder)
    .filter((field) => field.slot !== undefined)
    .map((field) => toCamelCase(field.name));
}
