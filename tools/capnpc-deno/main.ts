#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run

import {
  applyImplicitPluginDefaults,
  computeIncludePaths,
  discoverSchemaFiles,
  finalizeGeneratedFiles,
  helpText,
  loadCliFileConfig,
  mergeCliOptionsWithConfig,
  parseCliArgs,
} from "./cli.ts";
import {
  CliUsageError,
  CodegenEmitError,
  CodegenIoError,
  CodegenRequestError,
  formatCapnpcDenoError,
  SchemaCompileError,
} from "./errors.ts";
import { generateTypescriptFiles } from "./emitter.ts";
import { encodeCodeGeneratorResponse } from "./plugin_response.ts";
import { parseCodeGeneratorRequest } from "./request_parser.ts";

async function readRequestFromStdin(): Promise<Uint8Array> {
  const body = await new Response(Deno.stdin.readable).arrayBuffer();
  return new Uint8Array(body);
}

async function compileSchemasToRequest(
  schemas: string[],
  importPaths: string[],
): Promise<Uint8Array> {
  if (schemas.length === 0) {
    throw new CliUsageError("no schema files were provided");
  }

  const args = ["compile", "-o-"];
  for (const importPath of importPaths) {
    args.push(`-I${importPath}`);
  }
  args.push(...schemas);

  const cmd = new Deno.Command("capnp", {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new SchemaCompileError(`capnp compile failed:\n${stderr.trimEnd()}`);
  }
  return output.stdout;
}

function joinPath(left: string, right: string): string {
  if (left.endsWith("/") || left.endsWith("\\")) return `${left}${right}`;
  return `${left}/${right}`;
}

function dirnamePath(path: string): string {
  const slash = path.lastIndexOf("/");
  const backslash = path.lastIndexOf("\\");
  const idx = Math.max(slash, backslash);
  if (idx < 0) return ".";
  if (idx === 0) return path.slice(0, 1);
  return path.slice(0, idx);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

async function main(): Promise<void> {
  const cliOptions = applyImplicitPluginDefaults(parseCliArgs(Deno.args), {
    argvLength: Deno.args.length,
    stdinIsTerminal: Deno.stdin.isTerminal(),
  });
  if (cliOptions.showHelp) {
    console.log(helpText());
    return;
  }
  const fileConfig = await loadCliFileConfig(cliOptions);
  const options = mergeCliOptionsWithConfig(cliOptions, fileConfig);

  const discoveredSchemas = await discoverSchemaFiles(options.srcDirs);
  const schemaInputs = uniqueSorted([...options.schemas, ...discoveredSchemas]);
  const includePaths = computeIncludePaths(
    options.importPaths,
    options.srcDirs,
    schemaInputs,
  );

  let requestBytes: Uint8Array;
  if (options.requestBin) {
    try {
      requestBytes = await Deno.readFile(options.requestBin);
    } catch (error) {
      throw new CodegenIoError(
        `failed to read request file ${options.requestBin}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  } else if (schemaInputs.length > 0) {
    requestBytes = await compileSchemasToRequest(schemaInputs, includePaths);
  } else {
    if (Deno.stdin.isTerminal()) {
      throw new CliUsageError(
        "no schema input provided; pass --schema/--src/--request-bin or pipe a CodeGeneratorRequest on stdin",
      );
    }
    requestBytes = await readRequestFromStdin();
  }

  if (requestBytes.byteLength === 0) {
    throw new CodegenRequestError("empty CodeGeneratorRequest input");
  }

  const request = (() => {
    try {
      return parseCodeGeneratorRequest(requestBytes);
    } catch (error) {
      throw new CodegenRequestError(
        `failed to parse CodeGeneratorRequest: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  })();

  const generated = (() => {
    try {
      return generateTypescriptFiles(request);
    } catch (error) {
      throw new CodegenEmitError(
        `failed to generate TypeScript files: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  })();
  if (generated.length === 0) {
    throw new CodegenEmitError("no files were generated from request");
  }
  const outputFiles = (() => {
    try {
      return finalizeGeneratedFiles(generated, options);
    } catch (error) {
      throw new CodegenEmitError(
        `failed to finalize generated files: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  })();
  if (options.pluginResponse) {
    const idByFilename = new Map(
      request.requestedFiles.map((file) => [file.filename, file.id]),
    );
    let responseBytes: Uint8Array;
    try {
      responseBytes = encodeCodeGeneratorResponse(
        outputFiles.map((file) => ({
          id: file.sourceFilename
            ? idByFilename.get(file.sourceFilename)
            : undefined,
          filename: file.path,
          content: file.contents,
        })),
      );
    } catch (error) {
      throw new CodegenEmitError(
        `failed to encode CodeGeneratorResponse: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    await Deno.stdout.write(responseBytes);
    return;
  }

  try {
    await Deno.mkdir(options.outDir, { recursive: true });
  } catch (error) {
    throw new CodegenIoError(
      `failed to create output directory ${options.outDir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  for (const file of outputFiles) {
    const target = joinPath(options.outDir, file.path);
    try {
      await Deno.mkdir(dirnamePath(target), { recursive: true });
      await Deno.writeTextFile(target, file.contents);
    } catch (error) {
      throw new CodegenIoError(
        `failed to write ${target}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (!options.quiet) {
      console.log(`wrote ${target}`);
    }
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(formatCapnpcDenoError(error));
    Deno.exit(1);
  });
}
