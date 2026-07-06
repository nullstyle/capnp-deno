import { assert, assertEquals } from "./test_utils.ts";

const SOURCE_ROOT = "src";
const EXTERNAL_SPECIFIER_PATTERN =
  /^(?:npm:|jsr:|node:|https?:\/\/|@std\/|@cliffy\/|@nullstyle\/)/;

interface ImportReference {
  readonly file: string;
  readonly specifier: string;
}

async function collectSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      files.push(...await collectSourceFiles(path));
    } else if (entry.isFile && path.endsWith(".ts")) {
      files.push(path);
    }
  }
  files.sort();
  return files;
}

function collectImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const staticImportPattern =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'"()]*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of source.matchAll(staticImportPattern)) {
    specifiers.push(match[1]);
  }
  for (const match of source.matchAll(dynamicImportPattern)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

Deno.test("published runtime source has no external TypeScript imports", async () => {
  const files = await collectSourceFiles(SOURCE_ROOT);
  assert(files.length > 0, "expected runtime source files");

  const externalReferences: ImportReference[] = [];
  for (const file of files) {
    const source = await Deno.readTextFile(file);
    for (const specifier of collectImportSpecifiers(source)) {
      if (
        !isRelativeSpecifier(specifier) ||
        EXTERNAL_SPECIFIER_PATTERN.test(specifier)
      ) {
        externalReferences.push({ file, specifier });
      }
    }
  }

  assertEquals(
    externalReferences.map((ref) => `${ref.file}: ${ref.specifier}`).join("\n"),
    "",
    "runtime imports must stay relative so @nullstyle/capnp has no third-party runtime dependencies",
  );
});
