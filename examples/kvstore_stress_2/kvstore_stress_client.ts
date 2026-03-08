import { Command } from "@cliffy/command";
import { connect, TcpTransport } from "@nullstyle/capnp";
import { KvStore, type WriteBatchResults, type WriteOp } from "./gen/mod.ts";

interface ClientOptions {
  host: string;
  port: number;
  keySpace: number;
  activeKeys: number;
  rotationStep: number;
  minBatch: number;
  maxBatch: number;
  concurrency: number;
  deleteRatio: number;
  minValueBytes: number;
  maxValueBytes: number;
  reportMs: number;
  durationSeconds: number;
}

interface BuiltBatch {
  ops: WriteOp[];
  putCount: number;
  deleteCount: number;
  putBytes: number;
}

interface Stats {
  startedAtMs: number;
  completedBatches: number;
  completedOps: number;
  completedPuts: number;
  completedDeletes: number;
  appliedOps: number;
  putBytes: number;
  totalLatencyMs: number;
  latencySamples: number[];
  errors: number;
  lastError: string | null;
}

interface ReportSnapshot {
  atMs: number;
  completedBatches: number;
  completedOps: number;
  putBytes: number;
}

interface WorkerState {
  running: boolean;
  inFlight: number;
  nextWindowStart: number;
}

const DEFAULTS: ClientOptions = {
  host: "127.0.0.1",
  port: 9000,
  keySpace: 16_384,
  activeKeys: 1_024,
  rotationStep: 1,
  minBatch: 8,
  maxBatch: 64,
  concurrency: 32,
  deleteRatio: 0.1,
  minValueBytes: 32,
  maxValueBytes: 256,
  reportMs: 1000,
  durationSeconds: 0,
};

const MAX_LATENCY_SAMPLES = 2048;
const ERROR_BACKOFF_MS = 5;

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function formatKey(index: number): string {
  return `key:${index.toString().padStart(8, "0")}`;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function buildBatch(options: ClientOptions, windowStart: number): BuiltBatch {
  const opCount = randomInt(options.minBatch, options.maxBatch);
  const ops: WriteOp[] = new Array(opCount);

  let putCount = 0;
  let deleteCount = 0;
  let putBytes = 0;

  for (let i = 0; i < opCount; i++) {
    const keyOffset = randomInt(0, options.activeKeys - 1);
    const keyIndex = (windowStart + keyOffset) % options.keySpace;
    const key = formatKey(keyIndex);

    if (Math.random() < options.deleteRatio) {
      ops[i] = {
        which: "delete",
        key,
      };
      deleteCount++;
      continue;
    }

    const valueLength = randomInt(options.minValueBytes, options.maxValueBytes);
    ops[i] = {
      which: "put",
      key,
      put: randomBytes(valueLength),
    };

    putCount++;
    putBytes += valueLength;
  }

  return {
    ops,
    putCount,
    deleteCount,
    putBytes,
  };
}

function pushLatencySample(stats: Stats, latencyMs: number): void {
  stats.latencySamples.push(latencyMs);
  if (stats.latencySamples.length > MAX_LATENCY_SAMPLES) {
    stats.latencySamples.shift();
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.floor((sorted.length - 1) * p);
  return sorted[index];
}

function report(
  stats: Stats,
  snapshot: ReportSnapshot,
  inFlight: number,
): ReportSnapshot {
  const now = performance.now();
  const elapsedSeconds = (now - stats.startedAtMs) / 1000;
  const deltaSeconds = (now - snapshot.atMs) / 1000;

  const deltaBatches = stats.completedBatches - snapshot.completedBatches;
  const deltaOps = stats.completedOps - snapshot.completedOps;
  const deltaBytes = stats.putBytes - snapshot.putBytes;

  const avgLatencyMs = stats.completedBatches === 0
    ? 0
    : stats.totalLatencyMs / stats.completedBatches;

  const sortedLatencies = [...stats.latencySamples].sort((a, b) => a - b);
  const p95LatencyMs = percentile(sortedLatencies, 0.95);

  const mibTotal = stats.putBytes / (1024 * 1024);
  const mibPerSecond = deltaSeconds > 0
    ? (deltaBytes / (1024 * 1024)) / deltaSeconds
    : 0;
  const batchesPerSecond = deltaSeconds > 0 ? deltaBatches / deltaSeconds : 0;
  const opsPerSecond = deltaSeconds > 0 ? deltaOps / deltaSeconds : 0;

  console.log(
    [
      `t=${elapsedSeconds.toFixed(1)}s`,
      `inflight=${inFlight}`,
      `batches=${stats.completedBatches} (${batchesPerSecond.toFixed(1)}/s)`,
      `ops=${stats.completedOps} (${opsPerSecond.toFixed(1)}/s)`,
      `puts=${stats.completedPuts}`,
      `deletes=${stats.completedDeletes}`,
      `applied=${stats.appliedOps}`,
      `writeMiB=${mibTotal.toFixed(2)} (+${mibPerSecond.toFixed(2)}/s)`,
      `lat(avg/p95)=${avgLatencyMs.toFixed(2)}/${p95LatencyMs.toFixed(2)}ms`,
      `errors=${stats.errors}`,
      stats.lastError ? `lastError=${stats.lastError}` : "",
    ].filter((segment) => segment.length > 0).join(" | "),
  );

  return {
    atMs: now,
    completedBatches: stats.completedBatches,
    completedOps: stats.completedOps,
    putBytes: stats.putBytes,
  };
}

function applyBatchResult(
  stats: Stats,
  batch: BuiltBatch,
  result: WriteBatchResults,
  latencyMs: number,
): void {
  stats.completedBatches++;
  stats.completedOps += batch.ops.length;
  stats.completedPuts += batch.putCount;
  stats.completedDeletes += batch.deleteCount;
  stats.appliedOps += result.applied;
  stats.putBytes += batch.putBytes;
  stats.totalLatencyMs += latencyMs;
  pushLatencySample(stats, latencyMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function workerLoop(
  kvStore: KvStore,
  options: ClientOptions,
  state: WorkerState,
  stats: Stats,
): Promise<void> {
  while (state.running) {
    const windowStart = state.nextWindowStart;
    state.nextWindowStart = (windowStart + options.rotationStep) %
      options.keySpace;

    const batch = buildBatch(options, windowStart);

    state.inFlight++;
    const startedAt = performance.now();
    try {
      const result = await kvStore.writeBatch(batch.ops);
      const latencyMs = performance.now() - startedAt;
      applyBatchResult(stats, batch, result, latencyMs);
    } catch (error) {
      stats.errors++;
      stats.lastError = error instanceof Error ? error.message : String(error);
      await sleep(ERROR_BACKOFF_MS);
    } finally {
      state.inFlight--;
    }
  }
}

async function run(options: ClientOptions): Promise<void> {
  if (options.activeKeys > options.keySpace) {
    throw new Error("--active-keys must be <= --key-space");
  }
  if (options.maxBatch < options.minBatch) {
    throw new Error("--max-batch must be >= --min-batch");
  }
  if (options.maxValueBytes < options.minValueBytes) {
    throw new Error("--max-value-bytes must be >= --min-value-bytes");
  }

  console.log(
    `connecting to ${options.host}:${options.port}` +
      ` | N=${options.activeKeys}` +
      ` | M=${options.keySpace}` +
      ` | concurrency=${options.concurrency}` +
      ` | batch=${options.minBatch}-${options.maxBatch}`,
  );

  using kvStore = await connect(
    KvStore,
    await TcpTransport.connect(options.host, options.port),
  );

  const state: WorkerState = {
    running: true,
    inFlight: 0,
    nextWindowStart: 0,
  };

  const stats: Stats = {
    startedAtMs: performance.now(),
    completedBatches: 0,
    completedOps: 0,
    completedPuts: 0,
    completedDeletes: 0,
    appliedOps: 0,
    putBytes: 0,
    totalLatencyMs: 0,
    latencySamples: [],
    errors: 0,
    lastError: null,
  };

  let snapshot: ReportSnapshot = {
    atMs: stats.startedAtMs,
    completedBatches: 0,
    completedOps: 0,
    putBytes: 0,
  };

  const onSigInt = () => {
    state.running = false;
  };
  const onSigTerm = () => {
    state.running = false;
  };

  let signalsRegistered = false;
  try {
    Deno.addSignalListener("SIGINT", onSigInt);
    Deno.addSignalListener("SIGTERM", onSigTerm);
    signalsRegistered = true;
  } catch {
    // If --allow-sys is missing, timed runs still work.
  }

  const reportTimer = setInterval(() => {
    snapshot = report(stats, snapshot, state.inFlight);
  }, options.reportMs);

  const durationTimer = options.durationSeconds > 0
    ? setTimeout(() => {
      state.running = false;
    }, options.durationSeconds * 1000)
    : null;

  const workers = Array.from(
    { length: options.concurrency },
    () => workerLoop(kvStore, options, state, stats),
  );

  await Promise.all(workers);

  clearInterval(reportTimer);
  if (durationTimer !== null) clearTimeout(durationTimer);

  if (signalsRegistered) {
    Deno.removeSignalListener("SIGINT", onSigInt);
    Deno.removeSignalListener("SIGTERM", onSigTerm);
  }

  snapshot = report(stats, snapshot, state.inFlight);
  console.log("stopped");
}

if (import.meta.main) {
  await new Command()
    .name("kvstore-stress-client")
    .description(
      "Drive KvStore.writeBatch RPC traffic with configurable concurrency and rotating key windows.",
    )
    .option(
      "--host <host:string>",
      "Server host to connect to",
      { default: DEFAULTS.host },
    )
    .option(
      "--port <port:integer>",
      "Server port to connect to",
      { default: DEFAULTS.port },
    )
    .option(
      "--key-space <size:integer>",
      "Total key space size M",
      { default: DEFAULTS.keySpace },
    )
    .option(
      "--active-keys <count:integer>",
      "Rotating active window size N",
      { default: DEFAULTS.activeKeys },
    )
    .option(
      "--rotation-step <step:integer>",
      "Window shift applied after each batch",
      { default: DEFAULTS.rotationStep },
    )
    .option(
      "--min-batch <count:integer>",
      "Minimum ops per batch",
      { default: DEFAULTS.minBatch },
    )
    .option(
      "--max-batch <count:integer>",
      "Maximum ops per batch",
      { default: DEFAULTS.maxBatch },
    )
    .option(
      "--concurrency <count:integer>",
      "Number of concurrent write loops",
      { default: DEFAULTS.concurrency },
    )
    .option(
      "--delete-ratio <ratio:number>",
      "Probability of generating a delete op",
      { default: DEFAULTS.deleteRatio },
    )
    .option(
      "--min-value-bytes <bytes:integer>",
      "Minimum bytes per put payload",
      { default: DEFAULTS.minValueBytes },
    )
    .option(
      "--max-value-bytes <bytes:integer>",
      "Maximum bytes per put payload",
      { default: DEFAULTS.maxValueBytes },
    )
    .option(
      "--report-ms <ms:integer>",
      "Stats reporting interval in milliseconds",
      { default: DEFAULTS.reportMs },
    )
    .option(
      "--duration-seconds <seconds:integer>",
      "Stop automatically after N seconds; 0 runs until interrupted",
      { default: DEFAULTS.durationSeconds },
    )
    .example(
      "Run against the default local server",
      "deno run --allow-net --allow-sys examples/kvstore_stress_2/kvstore_stress_client.ts",
    )
    .example(
      "Run a 30 second stress pass over a wider key space",
      "deno run --allow-net --allow-sys examples/kvstore_stress_2/kvstore_stress_client.ts --duration-seconds=30 --key-space=65536 --active-keys=4096",
    )
    .action(run)
    .parse(Deno.args);
}
