import {
  COMPILER_PACKAGE_ROOT,
  compilerAssetURL,
  readCompilerPin,
  verifyCompilerPackage,
} from "../compiler_artifact.ts";
import { SchemaCompileError } from "./errors.ts";
import {
  type SchemaWorkspace,
  snapshotSchemaWorkspace,
  type WorkspaceLimits,
  type WorkspaceOptions,
} from "./workspace.ts";

export interface CompilerLimits extends WorkspaceLimits {
  memoryPages: number;
  requestBytes: number;
  outputBytes: number;
  outputEntries: number;
  stdoutBytes: number;
  stderrBytes: number;
}
export interface CompileSchemasOptions extends WorkspaceOptions {
  timeoutMs?: number;
  limits?: Partial<CompilerLimits>;
}
interface WorkerCompiler {
  compile(
    workspace: SchemaWorkspace,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<{ request: Uint8Array }>;
  dispose(): void;
}
interface CompilerHost {
  supportedDenoWorkerVersion: string;
  createWorkerCompiler(
    url: URL | string,
    modules: { compiler: Uint8Array; generators: Record<string, never> },
    options: { limits?: Partial<CompilerLimits> },
  ): Promise<WorkerCompiler>;
}

export interface SchemaCompiler {
  compile(
    schemas: readonly string[],
    importPaths: readonly string[],
    options?: Omit<CompileSchemasOptions, "limits">,
  ): Promise<Uint8Array>;
  dispose(): void;
}

/**
 * Load the independently verified offline compiler and its worker.
 * Call dispose after the last job; one compiler accepts one active job at a time.
 */
export async function createSchemaCompiler(
  limits?: Partial<CompilerLimits>,
): Promise<SchemaCompiler> {
  const pin = await readCompilerPin();
  if (Deno.version.deno !== pin.denoVersion) {
    throw new SchemaCompileError(
      `bounded code generation requires Deno ${pin.denoVersion}; running ${Deno.version.deno}. Use mise exec -- deno task codegen or install the pinned compiled CLI.`,
    );
  }
  const manifest = await verifyCompilerPackage(COMPILER_PACKAGE_ROOT, pin);
  // Dynamic loading keeps ordinary runtime/type checking independent of acquired assets.
  const host = await import(
    new URL("typescript/mod.js", COMPILER_PACKAGE_ROOT).href
  ) as CompilerHost;
  if (host.supportedDenoWorkerVersion !== pin.denoVersion) {
    throw new SchemaCompileError(
      "compiler host and Deno toolchain pins disagree",
    );
  }
  const compiler = await Deno.readFile(
    compilerAssetURL("wasm/capnp.wasm"),
  );
  const includeFiles: Record<string, Uint8Array> = Object.create(null);
  for (const file of manifest.files) {
    if (file.path.startsWith("include/")) {
      includeFiles[file.path.slice(8)] = await Deno.readFile(
        new URL(file.path, COMPILER_PACKAGE_ROOT),
      );
    }
  }
  const workerURL = new URL("typescript/worker.js", COMPILER_PACKAGE_ROOT);
  const worker = await host.createWorkerCompiler(workerURL, {
    compiler,
    generators: {},
  }, { limits });
  let disposed = false;
  let busy = false;
  let active: AbortController | undefined;
  return {
    async compile(schemas, importPaths, options = {}) {
      if (disposed) throw new SchemaCompileError("schema compiler is disposed");
      if (busy) {
        throw new SchemaCompileError(
          "schema compiler already has an active job",
        );
      }
      const timeoutMs = options.timeoutMs ?? 30_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new TypeError("timeoutMs must be a positive integer");
      }
      const controller = new AbortController();
      active = controller;
      const abort = () => controller.abort(options.signal?.reason);
      const timeout = setTimeout(
        () =>
          controller.abort(
            new DOMException("schema compilation timed out", "TimeoutError"),
          ),
        timeoutMs,
      );
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      busy = true;
      const started = performance.now();
      try {
        const workspace = await snapshotSchemaWorkspace(
          schemas,
          importPaths,
          includeFiles,
          { ...options, limits, signal: controller.signal },
        );
        controller.signal.throwIfAborted();
        return (await worker.compile(workspace, {
          signal: controller.signal,
          timeoutMs: Math.max(
            1,
            Math.floor(timeoutMs - (performance.now() - started)),
          ),
        })).request;
      } catch (cause) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (
          cause instanceof DOMException || cause instanceof SchemaCompileError
        ) throw cause;
        const diagnostics =
          (cause as { diagnostics?: Array<{ stderr: string }> })?.diagnostics
            ?.map((item) => item.stderr).join("") ?? "";
        throw new SchemaCompileError(
          `capnp-wasm compile failed:\n${
            diagnostics.trimEnd() ||
            (cause instanceof Error ? cause.message : String(cause))
          }`,
          { cause },
        );
      } finally {
        busy = false;
        active = undefined;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active?.abort(new DOMException("schema compiler disposed", "AbortError"));
      worker.dispose();
    },
  };
}

/** Compile schema files with the pinned worker, without subprocesses or network. */
export async function compileSchemasToRequest(
  schemas: readonly string[],
  importPaths: readonly string[],
  options: CompileSchemasOptions = {},
): Promise<Uint8Array> {
  const compiler = await createSchemaCompiler(options.limits);
  try {
    return await compiler.compile(schemas, importPaths, options);
  } finally {
    compiler.dispose();
  }
}
