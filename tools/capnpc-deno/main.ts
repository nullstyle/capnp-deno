#!/usr/bin/env -S deno run --allow-read --allow-write

import {
  applyImplicitPluginDefaults,
  computeIncludePaths,
  discoverSchemaFiles,
  finalizeGeneratedFiles,
  helpText,
  loadCliFileConfig,
  mergeBarrelWithExistingModule,
  mergeCliOptionsWithConfig,
  parseCliArgs,
} from "./cli.ts";
import {
  CliUsageError,
  CodegenEmitError,
  CodegenIoError,
  CodegenRequestError,
  formatCapnpcDenoError,
} from "./errors.ts";
import { compileSchemasToRequest } from "./compiler.ts";
import { publishGeneratedFiles } from "./workspace_output.ts";
import { generateTypescriptFiles } from "./emitter.ts";
import { encodeCodeGeneratorResponse } from "./plugin_response.ts";
import { parseCodeGeneratorRequest } from "./request_parser.ts";

async function readRequestFromStdin(): Promise<Uint8Array> {
  const body = await new Response(Deno.stdin.readable).arrayBuffer();
  return new Uint8Array(body);
}

function joinPath(left: string, right: string): string {
  if (left.endsWith("/") || left.endsWith("\\")) return `${left}${right}`;
  return `${left}/${right}`;
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

  // Per-schema runs (--schema/--request-bin/stdin) only see a slice of the
  // project, so merge the barrel with previously generated entries instead of
  // silently dropping them. --src directory mode regenerates the whole tree
  // and keeps overwrite semantics.
  const filesToWrite = options.srcDirs.length === 0
    ? await mergeBarrelWithExistingModule(outputFiles, options.outDir)
    : outputFiles;

  await publishGeneratedFiles(options.outDir, filesToWrite);
  for (const file of filesToWrite) {
    const target = joinPath(options.outDir, file.path);
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
