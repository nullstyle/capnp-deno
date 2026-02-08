import type { GeneratedFile } from "./emitter.ts";
import { CliConfigError, CliUsageError } from "./errors.ts";

export type OutputLayout = "schema" | "flat";

export interface CliOptionOverrides {
  outDir: boolean;
  requestBin: boolean;
  schemas: boolean;
  srcDirs: boolean;
  importPaths: boolean;
  layout: boolean;
  emitBarrel: boolean;
  pluginResponse: boolean;
}

export interface CliOptions {
  showHelp: boolean;
  outDir: string;
  requestBin?: string;
  schemas: string[];
  srcDirs: string[];
  importPaths: string[];
  layout: OutputLayout;
  emitBarrel: boolean;
  pluginResponse: boolean;
  quiet: boolean;
  configPath?: string;
  useConfig: boolean;
  overrides: CliOptionOverrides;
}

export interface CliFileConfig {
  srcDirs?: string[];
  outDir?: string;
  importPaths?: string[];
  layout?: OutputLayout;
  emitBarrel?: boolean;
  pluginResponse?: boolean;
}

export interface CliRuntimeContext {
  argvLength: number;
  stdinIsTerminal: boolean;
}

const DEFAULT_OUT_DIR = "generated";
const DEFAULT_CONFIG_FILE = "capnpc-deno.toml";

export function helpText(): string {
  return `capnpc-deno

Usage:
  deno run tools/capnpc-deno/main.ts generate [options] [schema.capnp ...]
  deno run tools/capnpc-deno/main.ts [plugin-out-dir]

Options:
  --out <dir>            Output directory (default: ${DEFAULT_OUT_DIR})
  --schema <file>        Compile one schema with capnp (repeatable)
  --src <dir>            Recursively discover *.capnp files (repeatable)
  --request-bin <file>   Read binary CodeGeneratorRequest from file
  -I <dir>               Import path to pass to capnp compile (repeatable)
  --layout <schema|flat> Output layout strategy (default: schema)
  --barrel               Force generated mod.ts barrel output
  --no-barrel            Do not generate mod.ts barrel exports
  --plugin-response      Emit CodeGeneratorResponse bytes to stdout instead of writing files
  --config <file>        Load config from a specific TOML file
  --no-config            Ignore capnpc-deno.toml auto-discovery
  --quiet                Suppress "wrote ..." output lines
  --help                 Show this help

Config precedence:
  CLI flags override config file values, which override built-in defaults.

Examples:
  deno run tools/capnpc-deno/main.ts generate --src schema --out generated
  deno run tools/capnpc-deno/main.ts generate --schema schema/foo.capnp --out generated
  deno run tools/capnpc-deno/main.ts generate --request-bin request.bin --out generated
`;
}

export function parseCliArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    showHelp: false,
    outDir: DEFAULT_OUT_DIR,
    schemas: [],
    srcDirs: [],
    importPaths: [],
    layout: "schema",
    emitBarrel: true,
    pluginResponse: false,
    quiet: false,
    useConfig: true,
    overrides: {
      outDir: false,
      requestBin: false,
      schemas: false,
      srcDirs: false,
      importPaths: false,
      layout: false,
      emitBarrel: false,
      pluginResponse: false,
    },
  };

  const queue = [...args];
  let pluginMode = false;

  if (queue[0] === "generate") {
    queue.shift();
  } else if (queue[0] !== undefined && !queue[0].startsWith("-")) {
    options.outDir = queue.shift()!;
    options.overrides.outDir = true;
    pluginMode = true;
  }

  for (let i = 0; i < queue.length; i += 1) {
    const arg = queue[i];
    switch (arg) {
      case "--help":
      case "-h":
        options.showHelp = true;
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "--config":
        i += 1;
        if (i >= queue.length) {
          throw new CliUsageError("--config requires a value");
        }
        options.configPath = queue[i];
        break;
      case "--no-config":
        options.useConfig = false;
        break;
      case "--out":
        i += 1;
        if (i >= queue.length) {
          throw new CliUsageError("--out requires a value");
        }
        options.outDir = queue[i];
        options.overrides.outDir = true;
        break;
      case "--request-bin":
        i += 1;
        if (i >= queue.length) {
          throw new CliUsageError("--request-bin requires a value");
        }
        options.requestBin = queue[i];
        options.overrides.requestBin = true;
        break;
      case "--schema":
        i += 1;
        if (i >= queue.length) {
          throw new CliUsageError("--schema requires a value");
        }
        options.schemas.push(queue[i]);
        options.overrides.schemas = true;
        break;
      case "--src":
        i += 1;
        if (i >= queue.length) {
          throw new CliUsageError("--src requires a value");
        }
        options.srcDirs.push(queue[i]);
        options.overrides.srcDirs = true;
        break;
      case "-I":
      case "--import-path":
        i += 1;
        if (i >= queue.length) {
          throw new CliUsageError(`${arg} requires a value`);
        }
        options.importPaths.push(queue[i]);
        options.overrides.importPaths = true;
        break;
      case "--layout":
        i += 1;
        if (i >= queue.length) {
          throw new CliUsageError("--layout requires a value");
        }
        {
          const layout = queue[i];
          if (layout !== "schema" && layout !== "flat") {
            throw new CliUsageError(
              `--layout must be "schema" or "flat", got: ${layout}`,
            );
          }
          options.layout = layout;
          options.overrides.layout = true;
        }
        break;
      case "--barrel":
        options.emitBarrel = true;
        options.overrides.emitBarrel = true;
        break;
      case "--no-barrel":
        options.emitBarrel = false;
        options.overrides.emitBarrel = true;
        break;
      case "--plugin-response":
        options.pluginResponse = true;
        options.overrides.pluginResponse = true;
        break;
      case "--":
        break;
      default:
        if (arg.startsWith("-")) {
          throw new CliUsageError(`unknown argument: ${arg}`);
        }
        if (pluginMode) {
          throw new CliUsageError(
            `unexpected positional argument in plugin mode: ${arg} (use "generate" to pass positional schemas)`,
          );
        }
        options.schemas.push(arg);
        options.overrides.schemas = true;
        break;
    }
  }

  if (!options.useConfig && options.configPath) {
    throw new CliUsageError("--no-config cannot be used with --config");
  }
  if (
    options.requestBin &&
    (options.schemas.length > 0 || options.srcDirs.length > 0)
  ) {
    throw new CliUsageError("--request-bin cannot be used with --schema/--src");
  }

  return options;
}

export function applyImplicitPluginDefaults(
  options: CliOptions,
  runtime: CliRuntimeContext,
): CliOptions {
  const shouldApply = runtime.argvLength === 0 &&
    !runtime.stdinIsTerminal &&
    !options.showHelp &&
    options.requestBin === undefined &&
    options.schemas.length === 0 &&
    options.srcDirs.length === 0;

  if (!shouldApply) return options;
  return {
    ...options,
    outDir: ".",
    quiet: true,
    useConfig: false,
    overrides: {
      ...options.overrides,
      outDir: true,
    },
  };
}

export async function loadCliFileConfig(
  options: CliOptions,
): Promise<CliFileConfig | null> {
  if (!options.useConfig) return null;

  const configPath = options.configPath ?? DEFAULT_CONFIG_FILE;
  const isOptional = options.configPath === undefined;
  let source: string;
  try {
    source = await Deno.readTextFile(configPath);
  } catch (error) {
    if (isOptional && error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw new CliConfigError(
      error instanceof Error
        ? `failed to read config file ${configPath}: ${error.message}`
        : `failed to read config file ${configPath}`,
      { cause: error },
    );
  }

  const parsed = parseCliConfigToml(source);
  return resolveCliFileConfigPaths(parsed, configPath);
}

export function mergeCliOptionsWithConfig(
  options: CliOptions,
  config: CliFileConfig | null,
): CliOptions {
  if (!config) return options;
  const merged: CliOptions = {
    ...options,
    schemas: [...options.schemas],
    srcDirs: [...options.srcDirs],
    importPaths: [...options.importPaths],
    overrides: { ...options.overrides },
  };

  if (!merged.overrides.outDir && config.outDir !== undefined) {
    merged.outDir = config.outDir;
  }
  if (!merged.overrides.srcDirs && config.srcDirs !== undefined) {
    merged.srcDirs = [...config.srcDirs];
  }
  if (!merged.overrides.importPaths && config.importPaths !== undefined) {
    merged.importPaths = [...config.importPaths];
  }
  if (!merged.overrides.layout && config.layout !== undefined) {
    merged.layout = config.layout;
  }
  if (!merged.overrides.emitBarrel && config.emitBarrel !== undefined) {
    merged.emitBarrel = config.emitBarrel;
  }
  if (!merged.overrides.pluginResponse && config.pluginResponse !== undefined) {
    merged.pluginResponse = config.pluginResponse;
  }
  return merged;
}

export function parseCliConfigToml(source: string): CliFileConfig {
  const assignments = parseTomlAssignments(source);
  const config: CliFileConfig = {};

  for (const [key, rawValue] of assignments) {
    switch (key) {
      case "src":
        config.srcDirs = parseStringOrStringArray(rawValue, "src");
        break;
      case "out_dir":
        config.outDir = parseStringValue(rawValue, "out_dir");
        break;
      case "import_paths":
        config.importPaths = parseStringOrStringArray(rawValue, "import_paths");
        break;
      case "layout":
        config.layout = parseLayoutValue(rawValue, "layout");
        break;
      case "emit_barrel":
        config.emitBarrel = parseBooleanValue(rawValue, "emit_barrel");
        break;
      case "plugin_response":
        config.pluginResponse = parseBooleanValue(rawValue, "plugin_response");
        break;
      default:
        throw new CliConfigError(`unsupported config key: ${key}`);
    }
  }

  return config;
}

export async function discoverSchemaFiles(
  srcDirs: string[],
): Promise<string[]> {
  const files = new Set<string>();
  for (const srcDir of srcDirs) {
    await walkSchemaDir(srcDir, files);
  }
  return [...files].sort();
}

export function computeIncludePaths(
  importPaths: string[],
  srcDirs: string[],
  schemas: string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const normalized = trimTrailingSlash(normalizePath(value));
    if (normalized.length === 0 || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  for (const path of importPaths) push(path);
  for (const path of srcDirs) push(path);
  for (const schema of schemas) push(dirnamePath(schema));
  return out;
}

export function finalizeGeneratedFiles(
  generated: GeneratedFile[],
  options: Pick<CliOptions, "layout" | "srcDirs" | "emitBarrel">,
): GeneratedFile[] {
  const out: GeneratedFile[] = [];
  const pathToSource = new Map<string, string>();
  for (const file of generated) {
    const mapped = mapGeneratedFilePath(file, options.layout, options.srcDirs);
    const safePath = ensureSafeOutputPath(mapped);
    const source = file.sourceFilename ?? file.path;
    const prior = pathToSource.get(safePath);
    if (prior !== undefined) {
      throw new CliUsageError(
        `output path collision: ${safePath} from ${prior} and ${source}; try --layout schema or adjust --src`,
      );
    }
    pathToSource.set(safePath, source);
    out.push({
      path: safePath,
      contents: file.contents,
      sourceFilename: file.sourceFilename,
    });
  }

  out.sort((left, right) => left.path.localeCompare(right.path));

  if (options.emitBarrel) {
    const barrelPath = "mod.ts";
    if (pathToSource.has(barrelPath)) {
      throw new CliUsageError(
        "generated files already include mod.ts; cannot emit barrel",
      );
    }
    out.push({
      path: barrelPath,
      contents: renderBarrelModule(out.map((file) => file.path)),
    });
  }

  return out;
}

export function mapGeneratedFilePath(
  file: GeneratedFile,
  layout: OutputLayout,
  srcDirs: string[],
): string {
  if (layout === "flat") return normalizePath(file.path);
  if (!file.sourceFilename) return normalizePath(file.path);
  const schemaRel = deriveSchemaRelativePath(file.sourceFilename, srcDirs);
  if (!schemaRel) return normalizePath(file.path);
  return toModulePathFromSchema(schemaRel, detectGeneratedSuffix(file.path));
}

export function renderBarrelModule(paths: string[]): string {
  const entries = [
    ...new Set(
      paths.map((path) => normalizePath(path)).filter((path) =>
        path !== "mod.ts"
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));

  const out: string[] = [];
  out.push("// Generated by capnpc-deno");
  out.push("// DO NOT EDIT MANUALLY.");
  out.push("");
  if (entries.length === 0) {
    out.push("export {};");
  } else {
    for (const entry of entries) {
      const specifier = entry.startsWith(".") ? entry : `./${entry}`;
      out.push(`export * from ${JSON.stringify(specifier)};`);
    }
  }
  out.push("");
  return out.join("\n");
}

function resolveCliFileConfigPaths(
  config: CliFileConfig,
  configPath: string,
): CliFileConfig {
  const baseDir = dirnamePath(normalizePath(configPath));
  const resolve = (value: string): string =>
    resolvePathFromBase(baseDir, value);
  return {
    outDir: config.outDir !== undefined ? resolve(config.outDir) : undefined,
    srcDirs: config.srcDirs?.map(resolve),
    importPaths: config.importPaths?.map(resolve),
    layout: config.layout,
    emitBarrel: config.emitBarrel,
    pluginResponse: config.pluginResponse,
  };
}

function parseTomlAssignments(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = source.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = stripTomlComments(lines[i]).trim();
    if (line.length === 0) continue;

    if (line.startsWith("[") && !line.includes("=")) {
      throw new CliConfigError(
        "config tables are not supported; use top-level keys only",
      );
    }

    const eq = line.indexOf("=");
    if (eq <= 0) {
      throw new CliConfigError(`invalid config line ${i + 1}: ${lines[i]}`);
    }
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new CliConfigError(`invalid config key on line ${i + 1}: ${key}`);
    }
    let value = line.slice(eq + 1).trim();
    if (value.length === 0) {
      throw new CliConfigError(`config key ${key} is missing a value`);
    }

    if (value.startsWith("[") && !isBracketLiteralClosed(value)) {
      while (!isBracketLiteralClosed(value)) {
        i += 1;
        if (i >= lines.length) {
          throw new CliConfigError(`unterminated array for config key ${key}`);
        }
        value += `\n${stripTomlComments(lines[i])}`;
      }
    }

    if (out.has(key)) {
      throw new CliConfigError(`duplicate config key: ${key}`);
    }
    out.set(key, value.trim());
  }

  return out;
}

function parseStringOrStringArray(value: string, key: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    return parseStringArrayValue(trimmed, key);
  }
  return [parseStringValue(trimmed, key)];
}

function parseStringValue(value: string, key: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== "string") {
        throw new CliConfigError(`config key ${key} must be a quoted string`);
      }
      return parsed;
    } catch {
      throw new CliConfigError(`config key ${key} must be a quoted string`);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  throw new CliConfigError(`config key ${key} must be a quoted string`);
}

function parseStringArrayValue(value: string, key: string): string[] {
  if (!value.startsWith("[") || !value.endsWith("]")) {
    throw new CliConfigError(`config key ${key} must be an array of strings`);
  }
  const out: string[] = [];
  let cursor = 1;
  while (cursor < value.length - 1) {
    while (cursor < value.length - 1 && /[\s,]/.test(value[cursor])) {
      cursor += 1;
    }
    if (cursor >= value.length - 1) break;
    const quote = value[cursor];
    if (quote !== '"' && quote !== "'") {
      throw new CliConfigError(
        `config key ${key} must contain only quoted strings`,
      );
    }
    const parsed = parseQuotedToken(value, cursor, key);
    out.push(parsed.value);
    cursor = parsed.next;
    while (cursor < value.length - 1 && /\s/.test(value[cursor])) cursor += 1;
    if (cursor < value.length - 1 && value[cursor] === ",") {
      cursor += 1;
    }
  }
  return out;
}

function parseQuotedToken(
  source: string,
  start: number,
  key: string,
): { value: string; next: number } {
  const quote = source[start];
  if (quote === '"') {
    let cursor = start + 1;
    let escaped = false;
    while (cursor < source.length) {
      const char = source[cursor];
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        break;
      }
      cursor += 1;
    }
    if (cursor >= source.length) {
      throw new CliConfigError(`unterminated string in config key ${key}`);
    }
    const token = source.slice(start, cursor + 1);
    try {
      const value = JSON.parse(token);
      if (typeof value !== "string") {
        throw new CliConfigError(`invalid string value in config key ${key}`);
      }
      return { value, next: cursor + 1 };
    } catch {
      throw new CliConfigError(`invalid string value in config key ${key}`);
    }
  }

  let cursor = start + 1;
  while (cursor < source.length && source[cursor] !== "'") cursor += 1;
  if (cursor >= source.length) {
    throw new CliConfigError(`unterminated string in config key ${key}`);
  }
  return {
    value: source.slice(start + 1, cursor),
    next: cursor + 1,
  };
}

function parseBooleanValue(value: string, key: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  throw new CliConfigError(`config key ${key} must be true or false`);
}

function parseLayoutValue(value: string, key: string): OutputLayout {
  const parsed = parseStringValue(value, key);
  if (parsed !== "schema" && parsed !== "flat") {
    throw new CliConfigError(`config key ${key} must be "schema" or "flat"`);
  }
  return parsed;
}

function stripTomlComments(value: string): string {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (inDouble) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      if (char === "'") inSingle = false;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      continue;
    }
    if (char === "#") return value.slice(0, i);
  }

  return value;
}

function isBracketLiteralClosed(value: string): boolean {
  let depth = 0;
  let inDouble = false;
  let inSingle = false;
  let escaped = false;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (inDouble) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      if (char === "'") inSingle = false;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      continue;
    }
    if (char === "[") depth += 1;
    if (char === "]") depth -= 1;
  }
  return depth === 0;
}

function deriveSchemaRelativePath(
  sourceFilename: string,
  srcDirs: string[],
): string | null {
  const source = normalizePath(sourceFilename);
  const sourceIsAbsolute = isAbsolutePath(source);
  const normalizedRoots = srcDirs.map((root) =>
    trimTrailingSlash(normalizePath(root))
  )
    .filter((root) => root.length > 0)
    .sort((left, right) => right.length - left.length);

  for (const root of normalizedRoots) {
    if (sourceIsAbsolute !== isAbsolutePath(root)) continue;
    if (!source.startsWith(`${root}/`) && source !== root) continue;
    if (source === root) return null;
    return normalizeRelativePath(source.slice(root.length + 1), {
      allowParentTraversal: false,
      context: "schema source filename",
    });
  }

  if (sourceIsAbsolute) {
    return basenamePath(source);
  }
  return normalizeRelativePath(source, {
    allowParentTraversal: false,
    context: "schema source filename",
  });
}

function toModulePathFromSchema(
  schemaRelativePath: string,
  suffix: "capnp" | "rpc" | "meta",
): string {
  const normalized = normalizePath(schemaRelativePath);
  const withoutExt = normalized.endsWith(".capnp")
    ? normalized.slice(0, -".capnp".length)
    : normalized;
  return `${withoutExt || "schema"}_${suffix}.ts`;
}

function detectGeneratedSuffix(path: string): "capnp" | "rpc" | "meta" {
  const base = basenamePath(normalizePath(path));
  const match = base.match(/_(capnp|rpc|meta)\.ts$/);
  if (!match) return "capnp";
  return match[1] as "capnp" | "rpc" | "meta";
}

function ensureSafeOutputPath(value: string): string {
  const normalized = normalizePath(value);
  const safe = normalizeRelativePath(normalized, {
    allowParentTraversal: false,
    context: "generated output path",
  });
  if (safe.length === 0) {
    throw new CliUsageError(`invalid output path: ${value}`);
  }
  return safe;
}

function resolvePathFromBase(baseDir: string, value: string): string {
  const normalizedValue = normalizePath(value);
  if (isAbsolutePath(normalizedValue)) return normalizedValue;
  if (baseDir === ".") return normalizedValue;
  return normalizePath(joinPath(baseDir, normalizedValue));
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function trimTrailingSlash(value: string): string {
  let out = value;
  while (out.endsWith("/") && out !== "/") {
    out = out.slice(0, -1);
  }
  return out;
}

function normalizeRelativePath(
  value: string,
  options: { allowParentTraversal: boolean; context: string },
): string {
  const out: string[] = [];
  for (const segment of value.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (!options.allowParentTraversal) {
        throw new CliUsageError(
          `${options.context} must not contain '..': ${value}`,
        );
      }
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

function basenamePath(path: string): string {
  const normalized = normalizePath(path);
  const idx = normalized.lastIndexOf("/");
  if (idx < 0) return normalized;
  return normalized.slice(idx + 1);
}

function dirnamePath(path: string): string {
  const normalized = normalizePath(path);
  const idx = normalized.lastIndexOf("/");
  if (idx < 0) return ".";
  if (idx === 0) return "/";
  return normalized.slice(0, idx);
}

function joinPath(left: string, right: string): string {
  if (left.endsWith("/") || left.endsWith("\\")) return `${left}${right}`;
  return `${left}/${right}`;
}

async function walkSchemaDir(srcDir: string, out: Set<string>): Promise<void> {
  const queue = [srcDir];
  while (queue.length > 0) {
    const current = queue.pop()!;
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(current)) {
      entries.push(entry);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = normalizePath(joinPath(current, entry.name));
      if (entry.isDirectory) {
        queue.push(fullPath);
      } else if (entry.isFile && entry.name.endsWith(".capnp")) {
        out.add(fullPath);
      }
    }
  }
}
