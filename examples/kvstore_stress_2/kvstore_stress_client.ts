import { TCP } from "@nullstyle/capnp";
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

function usage(): string {
  return [
    "Usage:",
    "  deno run --allow-net --allow-sys kvstore_stress_client.ts [options]",
    "",
    "Options:",
    "  --host=<value>              server host (default: 127.0.0.1)",
    "  --port=<value>              server port (default: 9000)",
    "  --key-space=<M>             total key space size M (default: 16384)",
    "  --active-keys=<N>           rotating active set size N (default: 1024)",
    "  --rotation-step=<value>     window shift per batch (default: 1)",
    "  --min-batch=<value>         min ops per batch (default: 8)",
    "  --max-batch=<value>         max ops per batch (default: 64)",
    "  --concurrency=<value>       concurrent write loops (default: 32)",
    "  --delete-ratio=<0..1>       probability of delete op (default: 0.1)",
    "  --min-value-bytes=<value>   min bytes per put value (default: 32)",
    "  --max-value-bytes=<value>   max bytes per put value (default: 256)",
    "  --report-ms=<value>         stats interval in ms (default: 1000)",
    "  --duration-seconds=<value>  stop after N seconds, 0 = run forever (default: 0)",
    "  --m=<value>                 alias for --key-space",
    "  --n=<value>                 alias for --active-keys",
    "  --help                      show this help",
  ].join("\n");
}

function parseArgs(args: string[]): ClientOptions {
  const aliases = new Map<string, string>([
    ["m", "key-space"],
    ["n", "active-keys"],
  ]);

  const allowed = new Set<string>([
    "host",
    "port",
    "key-space",
    "active-keys",
    "rotation-step",
    "min-batch",
    "max-batch",
    "concurrency",
    "delete-ratio",
    "min-value-bytes",
    "max-value-bytes",
    "report-ms",
    "duration-seconds",
    "help",
  ]);

  const values = new Map<string, string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      values.set("help", "true");
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }

    let rawKey = "";
    let value = "";

    const eqIndex = arg.indexOf("=");
    if (eqIndex >= 0) {
      rawKey = arg.slice(2, eqIndex);
      value = arg.slice(eqIndex + 1);
    } else {
      rawKey = arg.slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`missing value for --${rawKey}`);
      }
      value = next;
      i++;
    }

    const key = aliases.get(rawKey) ?? rawKey;
    if (!allowed.has(key)) {
      throw new Error(`unknown option: --${rawKey}`);
    }

    values.set(key, value);
  }

  if (values.has("help")) {
    console.log(usage());
    Deno.exit(0);
  }

  const host = values.get("host") ?? DEFAULTS.host;
  const port = parseIntFlag(values, "port", DEFAULTS.port, {
    min: 1,
    max: 65_535,
  });

  const keySpace = parseIntFlag(values, "key-space", DEFAULTS.keySpace, {
    min: 1,
  });
  const activeKeys = parseIntFlag(
    values,
    "active-keys",
    DEFAULTS.activeKeys,
    {
      min: 1,
      max: keySpace,
    },
  );
  const rotationStep = parseIntFlag(
    values,
    "rotation-step",
    DEFAULTS.rotationStep,
    {
      min: 1,
    },
  );

  const minBatch = parseIntFlag(values, "min-batch", DEFAULTS.minBatch, {
    min: 1,
  });
  const maxBatch = parseIntFlag(values, "max-batch", DEFAULTS.maxBatch, {
    min: minBatch,
  });

  const concurrency = parseIntFlag(
    values,
    "concurrency",
    DEFAULTS.concurrency,
    {
      min: 1,
    },
  );
  const deleteRatio = parseFloatFlag(
    values,
    "delete-ratio",
    DEFAULTS.deleteRatio,
    { min: 0, max: 1 },
  );

  const minValueBytes = parseIntFlag(
    values,
    "min-value-bytes",
    DEFAULTS.minValueBytes,
    {
      min: 1,
    },
  );
  const maxValueBytes = parseIntFlag(
    values,
    "max-value-bytes",
    DEFAULTS.maxValueBytes,
    {
      min: minValueBytes,
    },
  );

  const reportMs = parseIntFlag(values, "report-ms", DEFAULTS.reportMs, {
    min: 100,
  });
  const durationSeconds = parseIntFlag(
    values,
    "duration-seconds",
    DEFAULTS.durationSeconds,
    {
      min: 0,
    },
  );

  return {
    host,
    port,
    keySpace,
    activeKeys,
    rotationStep,
    minBatch,
    maxBatch,
    concurrency,
    deleteRatio,
    minValueBytes,
    maxValueBytes,
    reportMs,
    durationSeconds,
  };
}

function parseIntFlag(
  values: Map<string, string>,
  key: string,
  fallback: number,
  bounds: { min: number; max?: number },
): number {
  const raw = values.get(key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`--${key} must be an integer`);
  }
  if (parsed < bounds.min) {
    throw new Error(`--${key} must be >= ${bounds.min}`);
  }
  if (bounds.max !== undefined && parsed > bounds.max) {
    throw new Error(`--${key} must be <= ${bounds.max}`);
  }
  return parsed;
}

function parseFloatFlag(
  values: Map<string, string>,
  key: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = values.get(key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${key} must be a number`);
  }
  if (parsed < bounds.min || parsed > bounds.max) {
    throw new Error(`--${key} must be between ${bounds.min} and ${bounds.max}`);
  }
  return parsed;
}

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

async function main(): Promise<void> {
  const options = parseArgs(Deno.args);

  console.log(
    `connecting to ${options.host}:${options.port}` +
      ` | N=${options.activeKeys}` +
      ` | M=${options.keySpace}` +
      ` | concurrency=${options.concurrency}` +
      ` | batch=${options.minBatch}-${options.maxBatch}`,
  );

  using kvStore = await TCP.connect(KvStore, options.host, options.port);

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
  await main();
}
