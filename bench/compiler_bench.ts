import { readCompilerPin } from "../tools/compiler_artifact.ts";
import {
  createSchemaCompiler,
  type SchemaCompiler,
} from "../tools/capnpc-deno/compiler.ts";

const COLD_SAMPLES = 5;
const WARM_SAMPLES = 25;
const DEADLINE_MS = 120_000;
const cases = [
  { name: "ping", schema: "examples/ping/schema.capnp" },
  {
    name: "rpc_protocol",
    schema: "vendor/capnp-zig/src/rpc/capnp/rpc.capnp",
  },
];

interface TimingSummary {
  samples: number[];
  min: number;
  median: number;
  p95: number;
  max: number;
}

function summarize(samples: number[]): TimingSummary {
  const sorted = samples.toSorted((left, right) => left - right);
  return {
    samples,
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1)!,
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function measureCase(
  fixture: typeof cases[number],
  signal: AbortSignal,
) {
  const initializeMs: number[] = [];
  const firstCompileMs: number[] = [];
  const coldTotalMs: number[] = [];
  const warmCompileMs: number[] = [];
  let requestSha256: string | undefined;
  let requestBytes = 0;
  let compiler: SchemaCompiler | undefined;

  async function verifyRequest(request: Uint8Array): Promise<void> {
    const actual = await sha256(request);
    if (requestSha256 !== undefined && actual !== requestSha256) {
      throw new Error(`${fixture.name}: cold and warm requests differ`);
    }
    requestSha256 = actual;
    requestBytes = request.byteLength;
  }

  try {
    for (let sample = 0; sample < COLD_SAMPLES; sample++) {
      signal.throwIfAborted();
      const started = performance.now();
      compiler = await createSchemaCompiler();
      const initialized = performance.now();
      const request = await compiler.compile([fixture.schema], [], { signal });
      const compiled = performance.now();
      initializeMs.push(initialized - started);
      firstCompileMs.push(compiled - initialized);
      coldTotalMs.push(compiled - started);
      await verifyRequest(request);
      compiler.dispose();
      compiler = undefined;
    }

    compiler = await createSchemaCompiler();
    // One untimed first compile initializes this worker before warm samples.
    await verifyRequest(
      await compiler.compile([fixture.schema], [], { signal }),
    );
    for (let sample = 0; sample < WARM_SAMPLES; sample++) {
      signal.throwIfAborted();
      const started = performance.now();
      const request = await compiler.compile([fixture.schema], [], { signal });
      warmCompileMs.push(performance.now() - started);
      await verifyRequest(request);
    }
  } finally {
    compiler?.dispose();
  }

  return {
    ...fixture,
    schemaSha256: await sha256(await Deno.readFile(fixture.schema)),
    requestBytes,
    requestSha256,
    initializeMs: summarize(initializeMs),
    firstCompileMs: summarize(firstCompileMs),
    coldTotalMs: summarize(coldTotalMs),
    warmCompileMs: summarize(warmCompileMs),
  };
}

async function main(): Promise<void> {
  if (Deno.args.length > 0) {
    throw new Error(
      "compiler_bench.ts takes no arguments; run from the repository root",
    );
  }
  const pin = await readCompilerPin();
  const deadline = new AbortController();
  const timeout = setTimeout(
    () =>
      deadline.abort(new DOMException("benchmark deadline", "TimeoutError")),
    DEADLINE_MS,
  );
  try {
    const results = [];
    for (const fixture of cases) {
      results.push(await measureCase(fixture, deadline.signal));
    }
    console.log(JSON.stringify(
      {
        schemaVersion: 1,
        measuredAt: new Date().toISOString(),
        environment: { ...Deno.version, ...Deno.build },
        compiler: pin,
        measurement: {
          unit: "milliseconds",
          coldSamples: COLD_SAMPLES,
          warmSamples: WARM_SAMPLES,
          deadlineMs: DEADLINE_MS,
          cold:
            "Fresh compiler client and worker per sample: full package verification, asset reads, worker initialization, workspace snapshot, and first compile-to-request.",
          warm:
            "Same client and worker after one untimed compile: workspace snapshot and compile-to-request on every sample.",
          excluded:
            "Deno process/module startup, artifact download, request digest verification, worker disposal, TypeScript emission, formatting, and output writes. OS file caches and V8 process caches are not flushed.",
          p95:
            "Nearest-rank sample percentile; cold p95 is the maximum of five observations.",
        },
        results,
      },
      null,
      2,
    ));
  } finally {
    clearTimeout(timeout);
  }
}

// This bounded measurement is a standalone command, not part of bench:fast's
// automatic calibration (which would repeatedly create thousands of workers).
if (import.meta.main) await main();
