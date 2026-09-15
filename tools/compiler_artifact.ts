/** Acquisition and integrity verification, separate from permission-limited codegen. */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./runtime_artifact.ts";

export interface CompilerPin {
  schemaVersion: 1;
  denoVersion: string;
  version: string;
  sourceCommit: string;
  sourceSha256: string;
  compilerRevision: string;
  archive: { url: string; sha256: string; bytes: number };
  manifestSha256: string;
  compilerSha256: string;
  includeSha256: string;
}

export interface CompilerManifest {
  format: 1;
  name: string;
  version: string;
  source: { commit: string; dirty: boolean; sha256: string };
  references: Record<string, string>;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

export const COMPILER_BUNDLE_ROOT = new URL(
  "../.capnp-cache/compiler-host/bundle/",
  import.meta.url,
);
export const COMPILER_PACKAGE_ROOT = Deno.build.standalone
  ? COMPILER_BUNDLE_ROOT
  : new URL("../.capnp-cache/compiler-host/package/", import.meta.url);

/** Preserve manifest names while embedding WASM as opaque bytes, not a Deno module. */
export function compilerAssetURL(
  path: string,
  root = COMPILER_PACKAGE_ROOT,
): URL {
  return new URL(
    root.href === COMPILER_BUNDLE_ROOT.href && path === "wasm/capnp.wasm"
      ? `${path}.bin`
      : path,
    root,
  );
}
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export async function readCompilerPin(): Promise<CompilerPin> {
  const pin: CompilerPin = JSON.parse(
    await Deno.readTextFile(
      new URL("./compiler_toolchain.json", import.meta.url),
    ),
  );
  if (
    pin.schemaVersion !== 1 || !Number.isSafeInteger(pin.archive.bytes) ||
    pin.archive.bytes < 1 || pin.archive.bytes > MAX_ARCHIVE_BYTES ||
    ![
      pin.archive.sha256,
      pin.manifestSha256,
      pin.compilerSha256,
      pin.includeSha256,
      pin.sourceSha256,
    ].every((value) => /^[0-9a-f]{64}$/.test(value)) ||
    !/^[0-9a-f]{40}$/.test(pin.sourceCommit) ||
    !/^[0-9a-f]{40}$/.test(pin.compilerRevision)
  ) {
    throw new Error("invalid compiler toolchain pin");
  }
  return pin;
}

function validPath(path: string): boolean {
  return path.length > 0 && !/[\\\0:]/.test(path) &&
    path.split("/").every((part) => !!part && part !== "." && part !== "..");
}

async function inventory(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(relative: string): Promise<void> {
    for await (const entry of Deno.readDir(join(root, relative))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (!validPath(path) || entry.isSymlink) {
        throw new Error(`invalid compiler package entry: ${path}`);
      }
      if (entry.isDirectory) await visit(path);
      else if (entry.isFile) files.push(path);
      else throw new Error(`unsupported compiler package entry: ${path}`);
    }
  }
  await visit("");
  return files.sort();
}

async function verifyFiles(
  files: Map<string, Uint8Array>,
  pin: CompilerPin,
): Promise<CompilerManifest> {
  const bytes = files.get("manifest.json");
  if (!bytes || await sha256(bytes) !== pin.manifestSha256) {
    throw new Error("compiler manifest integrity mismatch");
  }
  const manifest: CompilerManifest = JSON.parse(decoder.decode(bytes));
  if (
    manifest.format !== 1 ||
    manifest.name !== "@nullstyle/capnp-wasm-compiler-host" ||
    manifest.version !== pin.version ||
    manifest.source.commit !== pin.sourceCommit || manifest.source.dirty ||
    manifest.source.sha256 !== pin.sourceSha256 ||
    manifest.references["ref/capnproto"] !== pin.compilerRevision ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("compiler identity/provenance mismatch");
  }
  const expected = new Set(["manifest.json"]);
  for (const file of manifest.files) {
    if (
      !validPath(file.path) || expected.has(file.path) ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    ) throw new Error("invalid compiler manifest inventory");
    expected.add(file.path);
    const actual = files.get(file.path);
    if (
      !actual || actual.length !== file.bytes ||
      await sha256(actual) !== file.sha256
    ) throw new Error(`compiler package integrity mismatch: ${file.path}`);
  }
  if (
    files.size !== expected.size ||
    [...files.keys()].some((path) => !expected.has(path))
  ) throw new Error("compiler package has unexpected files");
  const compiler = manifest.files.find((file) =>
    file.path === "wasm/capnp.wasm"
  );
  const includes = manifest.files.filter((file) =>
    file.path.startsWith("include/")
  ).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const includeHash = await sha256(
    new TextEncoder().encode(
      includes.map((file) => `${file.sha256}  ${file.path}\n`).join(""),
    ),
  );
  if (
    compiler?.sha256 !== pin.compilerSha256 ||
    includeHash !== pin.includeSha256 ||
    !files.has("typescript/mod.js") || !files.has("typescript/worker.js")
  ) throw new Error("compiler assets do not match the pinned inventory");
  return manifest;
}

export async function verifyCompilerPackage(
  root: URL = COMPILER_PACKAGE_ROOT,
  pin?: CompilerPin,
): Promise<CompilerManifest> {
  const path = fileURLToPath(root);
  const files = new Map<string, Uint8Array>();
  let size = 0;
  try {
    for (const name of await inventory(path)) {
      const info = await Deno.lstat(join(path, name));
      size += info.size;
      if (size > MAX_PACKAGE_BYTES) {
        throw new Error("compiler package exceeds size limit");
      }
      const logicalName = root.href === COMPILER_BUNDLE_ROOT.href &&
          name === "wasm/capnp.wasm.bin"
        ? "wasm/capnp.wasm"
        : name;
      if (files.has(logicalName)) throw new Error("duplicate compiler asset");
      files.set(logicalName, await Deno.readFile(join(path, name)));
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        "compiler assets are missing; run deno task compiler:fetch first",
      );
    }
    throw error;
  }
  return await verifyFiles(files, pin ?? await readCompilerPin());
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > limit) throw new Error("compiler archive exceeds size limit");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Parse only the deterministic regular-file ustar emitted by the producer. */
export function unpackCompilerTar(tar: Uint8Array): Map<string, Uint8Array> {
  if (tar.length > MAX_PACKAGE_BYTES || tar.length % 512) {
    throw new Error("invalid compiler tar length");
  }
  const files = new Map<string, Uint8Array>();
  function field(block: Uint8Array, start: number, length: number): string {
    return decoder.decode(block.subarray(start, start + length)).replace(
      /\0.*$/s,
      "",
    ).trim();
  }
  for (let offset = 0; offset < tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (
        tar.length - offset < 1024 ||
        !tar.subarray(offset).every((byte) => byte === 0)
      ) throw new Error("invalid compiler tar trailer");
      return files;
    }
    const rawPath = field(header, 0, 100);
    const path = rawPath.slice("package/".length);
    const sizeText = field(header, 124, 12);
    const checksumText = field(header, 148, 8);
    const sum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (
      !rawPath.startsWith("package/") || !validPath(path) || files.has(path) ||
      header[156] !== 48 || field(header, 257, 6) !== "ustar" ||
      field(header, 345, 155) ||
      !/^[0-7]+$/.test(sizeText) || !/^[0-7]+$/.test(checksumText) ||
      parseInt(checksumText, 8) !== sum
    ) throw new Error("invalid compiler tar entry");
    const size = parseInt(sizeText, 8);
    const end = offset + 512 + size;
    if (!Number.isSafeInteger(size) || end > tar.length) {
      throw new Error("truncated compiler tar entry");
    }
    files.set(path, tar.slice(offset + 512, end));
    offset = offset + 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("missing compiler tar trailer");
}

export async function installCompilerArchive(
  archive: Uint8Array,
  pin: CompilerPin,
  root: URL = COMPILER_PACKAGE_ROOT,
): Promise<void> {
  if (
    archive.length !== pin.archive.bytes ||
    archive.length > MAX_ARCHIVE_BYTES ||
    await sha256(archive) !== pin.archive.sha256
  ) throw new Error("compiler archive integrity mismatch");
  const tar = await readBounded(
    new Blob([archive.slice().buffer]).stream().pipeThrough(
      new DecompressionStream("gzip"),
    ),
    MAX_PACKAGE_BYTES,
  );
  const files = unpackCompilerTar(tar);
  await verifyFiles(files, pin);
  const destination = fileURLToPath(root);
  const parent = dirname(destination.replace(/[\\/]$/, ""));
  await Deno.mkdir(parent, { recursive: true });
  const staging = await Deno.makeTempDir({
    dir: parent,
    prefix: ".compiler-stage-",
  });
  try {
    for (const [name, bytes] of files) {
      const target = join(staging, name);
      await Deno.mkdir(dirname(target), { recursive: true });
      await Deno.writeFile(target, bytes);
    }
    await Deno.remove(destination, { recursive: true }).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    await Deno.rename(staging, destination);
  } finally {
    await Deno.remove(staging, { recursive: true }).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
}

if (import.meta.main) {
  const pin = await readCompilerPin();
  if (Deno.args[0] === "--fetch" && Deno.args.length === 1) {
    const response = await fetch(pin.archive.url, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok || !response.body) {
      throw new Error(`compiler download failed: ${response.status}`);
    }
    await installCompilerArchive(
      await readBounded(response.body, MAX_ARCHIVE_BYTES),
      pin,
    );
  } else if (Deno.args[0] === "--archive" && Deno.args.length === 2) {
    const path = resolve(Deno.args[1]);
    if ((await Deno.stat(path)).size > MAX_ARCHIVE_BYTES) {
      throw new Error("compiler archive exceeds size limit");
    }
    await installCompilerArchive(await Deno.readFile(path), pin);
  } else if (Deno.args.length) {
    throw new Error(
      "usage: compiler_artifact.ts [--fetch | --archive file.tgz]",
    );
  }
  const manifest = await verifyCompilerPackage(COMPILER_PACKAGE_ROOT, pin);
  console.log(
    `Verified ${manifest.name}@${manifest.version} (${manifest.files.length} files)`,
  );
}
