import { dirname, isAbsolute, posix, resolve, win32 } from "node:path";
import { CodegenIoError, SchemaCompileError } from "./errors.ts";

export interface WorkspaceLimits {
  workspaceBytes: number;
  workspaceEntries: number;
  pathBytes: number;
}

export interface SchemaWorkspace {
  files: Record<string, Uint8Array>;
  includeFiles: Record<string, Uint8Array>;
  entrypoints: string[];
  importPaths: string[];
  sourcePrefix: string;
  generators: [];
}

export interface WorkspaceOptions {
  cwd?: string;
  sourcePrefix?: string;
  signal?: AbortSignal;
  limits?: Partial<WorkspaceLimits>;
}

export const DEFAULT_WORKSPACE_LIMITS: Readonly<WorkspaceLimits> = Object
  .freeze({
    workspaceBytes: 64 * 1024 * 1024,
    workspaceEntries: 4096,
    pathBytes: 4096,
  });

/** Map an absolute host path into the compiler's read-only /src mount. */
export function virtualPath(
  path: string,
  windows = Deno.build.os === "windows",
): string {
  const paths = windows ? win32 : posix;
  if (!paths.isAbsolute(path)) {
    throw new TypeError(`expected absolute path: ${path}`);
  }
  const normalized = windows
    ? paths.normalize(path).replaceAll("\\", "/")
    : paths.normalize(path);
  if (windows && normalized.startsWith("//")) {
    return `UNC/${normalized.slice(2).replace(/\/$/, "")}`;
  }
  return normalized.replace(/^\//, "").replace(/\/$/, "");
}

interface Dependency {
  path: string;
  schema: boolean;
}

/** Lex just import/embed operands; comments and other strings cannot create reads. */
export function schemaDependencies(
  source: Uint8Array,
  pathBytes = 4096,
  entries = 4096,
): Dependency[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  const dependencies: Dependency[] = [];
  const seen = new Set<string>();
  const add = (dependency: Dependency) => {
    const key = `${dependency.schema}:${dependency.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > entries) {
      throw new SchemaCompileError("schema exceeds dependency entry limit");
    }
    dependencies.push(dependency);
  };
  let pending: boolean | undefined;
  let arrow = false;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    if (character === "#") {
      while (index < text.length && text[index] !== "\n") index++;
      continue;
    }
    if (character === '"') {
      arrow = false;
      const chunks: number[] = [];
      let plain = "";
      let closed = false;
      const append = () => {
        if (pending !== undefined) {
          chunks.push(...new TextEncoder().encode(plain));
        }
        plain = "";
        if (chunks.length > pathBytes) {
          throw new SchemaCompileError("dependency exceeds pathBytes limit");
        }
      };
      index++;
      while (index < text.length) {
        const next = text[index++];
        if (next === '"') {
          closed = true;
          break;
        }
        if (next !== "\\") {
          if (pending !== undefined) plain += next;
          if (plain.length > pathBytes) {
            throw new SchemaCompileError("dependency exceeds pathBytes limit");
          }
          continue;
        }
        append();
        const escaped = text[index++];
        if (pending === undefined) continue;
        const simple: Record<string, number> = {
          a: 7,
          b: 8,
          f: 12,
          n: 10,
          r: 13,
          t: 9,
          v: 11,
          "'": 39,
          '"': 34,
          "\\": 92,
          "?": 63,
        };
        if (Object.hasOwn(simple, escaped)) chunks.push(simple[escaped]);
        else if (
          escaped === "x" && /^[0-9a-f]{2}$/i.test(text.slice(index, index + 2))
        ) {
          chunks.push(parseInt(text.slice(index, index + 2), 16));
          index += 2;
        } else if (/[0-7]/.test(escaped ?? "")) {
          let digits = escaped;
          while (digits.length < 3 && /[0-7]/.test(text[index] ?? "")) {
            digits += text[index++];
          }
          chunks.push(parseInt(digits, 8) & 255);
        } else {
          // Invalid strings belong to the actual compiler's diagnostics.
          pending = undefined;
        }
      }
      append();
      if (closed && pending !== undefined) {
        add({
          path: new TextDecoder("utf-8", { fatal: true }).decode(
            new Uint8Array(chunks),
          ),
          schema: pending,
        });
      }
      pending = undefined;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const start = index++;
      while (/[A-Za-z0-9_]/.test(text[index] ?? "")) index++;
      const word = text.slice(start, index);
      if (word === "stream" && arrow) {
        add({ path: "/capnp/stream.capnp", schema: true });
      }
      arrow = false;
      pending = word === "import" ? true : word === "embed" ? false : undefined;
    } else {
      arrow = text.slice(index, index + 2) === "->";
      index += arrow ? 2 : 1;
      pending = undefined;
    }
  }
  return dependencies;
}

/**
 * Snapshot the reachable import/embed graph, following normal Deno read permissions.
 * Symlinks are followed, but aliases consume separate budgets; no directory is scanned.
 */
export async function snapshotSchemaWorkspace(
  schemas: readonly string[],
  importPaths: readonly string[],
  includeFiles: Record<string, Uint8Array>,
  options: WorkspaceOptions = {},
): Promise<SchemaWorkspace> {
  const limits = { ...DEFAULT_WORKSPACE_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`invalid ${name} limit`);
    }
  }
  const cwd = resolve(options.cwd ?? Deno.cwd());
  if (
    schemas.length > limits.workspaceEntries ||
    importPaths.length > limits.workspaceEntries
  ) throw new SchemaCompileError("workspace exceeds workspaceEntries limit");
  const roots = [...new Set(importPaths.map((path) => resolve(cwd, path)))];
  for (const root of roots) {
    try {
      if (!(await Deno.stat(root)).isDirectory) {
        throw new Error("not a directory");
      }
    } catch (cause) {
      throw new CodegenIoError(
        `invalid import directory ${root}: ${
          cause instanceof Error ? cause.message : cause
        }`,
        { cause },
      );
    }
  }
  const entrypoints = [...new Set(schemas.map((path) => resolve(cwd, path)))];
  if (entrypoints.length === 0) {
    throw new SchemaCompileError("no schema files were provided");
  }
  const files: Record<string, Uint8Array> = Object.create(null);
  const nodes = new Set<string>();
  let bytes = 0;
  function reserve(path: string, size: number, mount: string): void {
    options.signal?.throwIfAborted();
    if (
      !path || /[\\\0]/.test(path) || !path.isWellFormed() ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new SchemaCompileError(
        `path cannot be represented in compiler workspace: ${path}`,
      );
    }
    if (new TextEncoder().encode(path).length > limits.pathBytes) {
      throw new SchemaCompileError("workspace exceeds pathBytes limit");
    }
    const segments = path.split("/");
    for (let end = 1; end <= segments.length; end++) {
      nodes.add(`${mount}/${segments.slice(0, end).join("/")}`);
      if (nodes.size > limits.workspaceEntries) {
        throw new SchemaCompileError(
          "workspace exceeds workspaceEntries limit",
        );
      }
    }
    bytes += size;
    if (bytes > limits.workspaceBytes) {
      throw new SchemaCompileError("workspace exceeds workspaceBytes limit");
    }
  }
  for (const [path, contents] of Object.entries(includeFiles)) {
    reserve(path, contents.length, "include");
  }
  const scanned = new Set<string>();
  const queue = entrypoints.map((path) => ({
    path,
    schema: true,
    required: true,
  }));
  async function load(
    path: string,
    required: boolean,
  ): Promise<Uint8Array | undefined> {
    const name = virtualPath(path);
    if (Object.hasOwn(files, name)) return files[name];
    let handle: Deno.FsFile;
    try {
      handle = await Deno.open(path, { read: true });
    } catch (cause) {
      if (!required && cause instanceof Deno.errors.NotFound) return undefined;
      throw new CodegenIoError(
        `failed to read schema dependency ${path}: ${
          cause instanceof Error ? cause.message : cause
        }`,
        { cause },
      );
    }
    try {
      const info = await handle.stat();
      if (!info.isFile) {
        throw new CodegenIoError(
          `schema dependency is not a regular file: ${path}`,
        );
      }
      reserve(name, info.size, "src");
      // A single extra byte detects growth without reading an unbounded stream.
      const content = new Uint8Array(info.size + 1);
      let length = 0;
      while (length < content.length) {
        options.signal?.throwIfAborted();
        const count = await handle.read(content.subarray(length));
        if (count === null) break;
        length += count;
      }
      if (length !== info.size) {
        throw new CodegenIoError(
          `schema dependency changed while reading: ${path}`,
        );
      }
      return files[name] = content.slice(0, length);
    } finally {
      handle.close();
    }
  }
  async function resolveDependency(
    from: string | undefined,
    dependency: Dependency,
  ): Promise<{ path: string; included: boolean } | undefined> {
    if (!dependency.path || dependency.path.includes("\0")) return undefined;
    if (dependency.path.startsWith("/")) {
      const relative = dependency.path.slice(1);
      if (relative.split("/").some((part) => part === "..")) return undefined;
      for (const root of roots) {
        const path = resolve(root, relative);
        if (await load(path, false)) return { path, included: false };
      }
      const path = posix.normalize(relative);
      return Object.hasOwn(includeFiles, path)
        ? { path, included: true }
        : undefined;
    }
    if (from === undefined) return undefined;
    if (isAbsolute(from)) {
      return { path: resolve(dirname(from), dependency.path), included: false };
    }
    const path = posix.normalize(
      posix.join(posix.dirname(from), dependency.path),
    );
    return Object.hasOwn(includeFiles, path)
      ? { path, included: true }
      : undefined;
  }
  // Includes may themselves import an explicitly supplied override.
  const includeQueue: string[] = [];
  const scheduled = new Set(queue.map((item) => `src:true:${item.path}`));
  while (queue.length || includeQueue.length) {
    options.signal?.throwIfAborted();
    const item = queue.shift();
    const path = item?.path ?? includeQueue.shift()!;
    const key = item ? `src:${path}` : `include:${path}`;
    const content = item ? await load(path, item.required) : includeFiles[path];
    if (!content || scanned.has(key) || item?.schema === false) continue;
    scanned.add(key);
    for (
      const dependency of schemaDependencies(
        content,
        limits.pathBytes,
        limits.workspaceEntries,
      )
    ) {
      const resolved = await resolveDependency(path, dependency);
      if (!resolved) continue; // The compiler owns missing-import diagnostics.
      if (resolved.included) {
        const next = `include:${resolved.path}`;
        if (dependency.schema && !scheduled.has(next)) {
          scheduled.add(next);
          includeQueue.push(resolved.path);
        }
      } else {
        const next = `src:${dependency.schema}:${resolved.path}`;
        if (scheduled.has(next)) continue;
        scheduled.add(next);
        if (scheduled.size > limits.workspaceEntries * 2) {
          throw new SchemaCompileError(
            "workspace exceeds dependency entry limit",
          );
        }
        queue.push({
          path: resolved.path,
          schema: dependency.schema,
          required: false,
        });
      }
    }
  }
  const names = Object.keys(files);
  const containsFile = (prefix: string) =>
    prefix === "" || names.some((path) => path.startsWith(`${prefix}/`));
  const prefix = virtualPath(resolve(cwd, options.sourcePrefix ?? cwd));
  return {
    files,
    includeFiles,
    generators: [],
    entrypoints: entrypoints.map((path) => virtualPath(path)),
    // A root with no reachable files cannot satisfy an import. Omit it instead
    // of inventing placeholder files solely to create an empty virtual directory.
    importPaths: roots.map((path) => virtualPath(path)).filter(containsFile),
    sourcePrefix: containsFile(prefix) ? prefix : "",
  };
}
