/** Measure final generated parameter buffers and their retained lifetimes. */
import {
  AddParamsCodec,
  CounterSink,
  createCounterSinkAddStreamSender,
} from "../examples/streaming/gen/schema_types.ts";
import { EMPTY_STRUCT_MESSAGE, type StreamSender } from "../src/rpc.ts";
import { MessageBuilder } from "../src/encoding.ts";

if (Deno.args.length > 1) {
  throw new Error("usage: streaming_memory.ts [output.json]");
}

const config = {
  calls: 1024,
  samplesPerMode: 3,
  warmupCallsPerMode: 64,
  maxInFlight: 32,
  parameterMessageBytes: 24,
  maxInFlightBytes: 8 * 24,
  acknowledgementDelayMs: 2,
  sampleTimeoutMs: 10_000,
} as const;
type Mode = "count_only" | "byte_bounded";

function require(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function measure(mode: Mode, calls: number) {
  const controller = new AbortController();
  const timers = new Set<number>();
  const retained = new Map<number, Uint8Array>();
  const seenBuffers = new WeakSet<ArrayBufferLike>();
  let serializedOutputCount = 0;
  let serializedOutputBytes = 0;
  let encodedCount = 0;
  let encodedBytes = 0;
  let finishedCount = 0;
  let finishedBytes = 0;
  let transportCount = 0;
  let transportBytes = 0;
  let uniqueBuffers = 0;
  let uniqueBufferBytes = 0;
  let transportRetainedBytes = 0;
  let decodedSum = 0;
  const peaks = {
    encodedToFinishBuffers: 0,
    encodedToFinishBytes: 0,
    transportRetainedBuffers: 0,
    transportRetainedBytes: 0,
    encodedBeforeTransportBuffers: 0,
    encodedBeforeTransportBytes: 0,
    senderInFlight: 0,
    senderInFlightBytes: 0,
    senderPendingEncodedBytes: 0,
  };
  function observe(): void {
    peaks.encodedToFinishBuffers = Math.max(
      peaks.encodedToFinishBuffers,
      encodedCount - finishedCount,
    );
    peaks.encodedToFinishBytes = Math.max(
      peaks.encodedToFinishBytes,
      encodedBytes - finishedBytes,
    );
    peaks.transportRetainedBuffers = Math.max(
      peaks.transportRetainedBuffers,
      retained.size,
    );
    peaks.transportRetainedBytes = Math.max(
      peaks.transportRetainedBytes,
      transportRetainedBytes,
    );
    peaks.encodedBeforeTransportBuffers = Math.max(
      peaks.encodedBeforeTransportBuffers,
      encodedCount - transportCount,
    );
    peaks.encodedBeforeTransportBytes = Math.max(
      peaks.encodedBeforeTransportBytes,
      encodedBytes - transportBytes,
    );
    if (sender) {
      peaks.senderInFlight = Math.max(peaks.senderInFlight, sender.inFlight);
      peaks.senderInFlightBytes = Math.max(
        peaks.senderInFlightBytes,
        sender.inFlightBytes,
      );
      peaks.senderPendingEncodedBytes = Math.max(
        peaks.senderPendingEncodedBytes,
        sender.pendingEncodedBytes,
      );
    }
  }

  const client = await CounterSink.bootstrapClient({
    bootstrap: () => Promise.resolve({ capabilityIndex: 0 }),
    call(_capability, _method, params, options) {
      const questionId = ++transportCount;
      transportBytes += params.byteLength;
      require(
        params.byteLength === config.parameterMessageBytes,
        "wire size changed",
      );
      require(
        params.byteOffset === 0 &&
          params.byteLength === params.buffer.byteLength,
        "parameter message no longer owns an exact-size backing buffer",
      );
      if (!seenBuffers.has(params.buffer)) {
        seenBuffers.add(params.buffer);
        uniqueBuffers++;
        uniqueBufferBytes += params.buffer.byteLength;
      }
      decodedSum += AddParamsCodec.decode(params).value;
      retained.set(questionId, params);
      transportRetainedBytes += params.byteLength;
      options?.onQuestionId?.(questionId);
      observe();
      return new Promise<Uint8Array>((resolve, reject) => {
        const signal = options?.signal;
        const abort = (): void => {
          clearTimeout(timer);
          timers.delete(timer);
          signal?.removeEventListener("abort", abort);
          reject(signal?.reason);
        };
        const timer = setTimeout(() => {
          timers.delete(timer);
          signal?.removeEventListener("abort", abort);
          // Before acknowledgment, a byte-blocked candidate remains visible.
          observe();
          resolve(EMPTY_STRUCT_MESSAGE);
        }, config.acknowledgementDelayMs);
        timers.add(timer);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    },
    finish(questionId) {
      const params = retained.get(questionId);
      require(params !== undefined, "Finish did not match a retained call");
      retained.delete(questionId);
      transportRetainedBytes -= params.byteLength;
      finishedCount++;
      finishedBytes += params.byteLength;
      observe();
    },
  });
  const sender: StreamSender<number, void> = createCounterSinkAddStreamSender(
    client,
    {
      maxInFlight: config.maxInFlight,
      ...(mode === "byte_bounded"
        ? { maxInFlightBytes: config.maxInFlightBytes }
        : {}),
      signal: controller.signal,
      call: {
        onEncodedParams(byteLength) {
          encodedCount++;
          encodedBytes += byteLength;
          observe();
          return Promise.resolve();
        },
      },
    },
  );
  // This standalone process runs one sample at a time. Count the real final
  // serialization allocations, including any discarded before transport.call.
  // Restore the public method even if a workload or assertion fails.
  const originalToMessageBytes = MessageBuilder.prototype.toMessageBytes;
  MessageBuilder.prototype.toMessageBytes = function (
    this: MessageBuilder,
  ): Uint8Array {
    const bytes = originalToMessageBytes.call(this);
    serializedOutputCount++;
    serializedOutputBytes += bytes.byteLength;
    return bytes;
  };
  const timeout = setTimeout(
    () => controller.abort(new Error("streaming measurement timed out")),
    config.sampleTimeoutMs,
  );
  const started = performance.now();
  try {
    for (let value = 1; value <= calls; value++) {
      await sender.send(value);
      observe();
    }
    await sender.flush();
    const elapsedMs = performance.now() - started;
    observe();
    require(
      encodedCount === calls && transportCount === calls &&
        finishedCount === calls,
      "serialization, transport, and Finish counts differ",
    );
    require(
      serializedOutputCount === calls && serializedOutputBytes === encodedBytes,
      "generated path serialized more than one final buffer per call",
    );
    require(
      encodedBytes === calls * config.parameterMessageBytes &&
        transportBytes === encodedBytes && finishedBytes === encodedBytes,
      "serialization, transport, and Finish byte counts differ",
    );
    require(decodedSum === calls * (calls + 1) / 2, "decoded workload differs");
    require(
      retained.size === 0 && transportRetainedBytes === 0 &&
        timers.size === 0 &&
        sender.inFlight === 0 && sender.inFlightBytes === 0 &&
        sender.pendingEncodedBytes === 0 && sender.totalReceived === calls,
      "measurement retained calls, buffers, timers, or byte charges after flush",
    );
    require(
      peaks.senderInFlight <= config.maxInFlight,
      "count window exceeded",
    );
    if (mode === "byte_bounded") {
      require(
        peaks.senderInFlightBytes <= config.maxInFlightBytes &&
          peaks.transportRetainedBytes <= config.maxInFlightBytes &&
          peaks.encodedToFinishBytes <=
            config.maxInFlightBytes + config.parameterMessageBytes &&
          peaks.senderPendingEncodedBytes === config.parameterMessageBytes,
        "byte window or single-candidate retention contract changed",
      );
    }
    return {
      mode,
      calls,
      elapsedMs,
      callsPerSecond: calls * 1000 / elapsedMs,
      parameterBytesPerSecond: transportBytes * 1000 / elapsedMs,
      encodedMessages: encodedCount,
      encodedMessageBytes: encodedBytes,
      serializedOutputAllocations: serializedOutputCount,
      serializedOutputAllocationBytes: serializedOutputBytes,
      distinctTransportArrayBuffers: uniqueBuffers,
      distinctTransportArrayBufferBytes: uniqueBufferBytes,
      peaks,
      remainingAfterFlush: {
        buffers: retained.size,
        bytes: transportRetainedBytes,
        calls: sender.inFlight,
        admittedBytes: sender.inFlightBytes,
        pendingEncodedBytes: sender.pendingEncodedBytes,
      },
    };
  } finally {
    MessageBuilder.prototype.toMessageBytes = originalToMessageBytes;
    clearTimeout(timeout);
    controller.abort(new Error("streaming measurement complete"));
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    retained.clear();
  }
}

const modes: Mode[] = ["count_only", "byte_bounded"];
for (const mode of modes) await measure(mode, config.warmupCallsPerMode);
const samples: Awaited<ReturnType<typeof measure>>[] = [];
for (let repeat = 0; repeat < config.samplesPerMode; repeat++) {
  // Alternate order to reduce systematic engine-warmup bias between modes.
  for (const mode of repeat % 2 ? modes.toReversed() : modes) {
    samples.push(await measure(mode, config.calls));
  }
}
function median(values: number[]): number {
  return values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
}
const sources: Record<string, string> = {};
for (
  const path of [
    "bench/streaming_memory.ts",
    "examples/streaming/gen/schema_types.ts",
    "src/rpc/session/streaming.ts",
    "src/encoding/runtime_codec.ts",
    "src/encoding/runtime_message.ts",
  ]
) {
  const bytes = await Deno.readFile(new URL(`../${path}`, import.meta.url));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  sources[path] = Array.from(
    digest,
    (byte) => byte.toString(16).padStart(2, "0"),
  )
    .join("");
}
const result = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  environment: { ...Deno.version, target: Deno.build.target },
  sources,
  config,
  definitions: {
    allocation:
      "Final MessageBuilder.toMessageBytes allocations counted by an isolated-process wrapper restored after each sample, plus distinct exact-size ArrayBuffers at transport.call; not internal builder growth or total V8 allocations.",
    encodedRetention:
      "Generated onEncodedParams notification through matching transport.finish; includes encoded candidates waiting for byte admission.",
    transportRetention:
      "Actual Uint8Array references held by this delayed-ack transport from call through Finish.",
    senderPeaks:
      "Public sender stats observed at encode, send, transport call, acknowledgment, Finish, and final flush; count-only inFlightBytes remains unmetered (zero).",
    throughput:
      "Generated serialize/decode/stream admission and timer-delayed acknowledgments on one local event loop; not network or native WASM throughput.",
  },
  summary: modes.map((mode) => {
    const selected = samples.filter((sample) => sample.mode === mode);
    return {
      mode,
      medianElapsedMs: median(selected.map((sample) => sample.elapsedMs)),
      medianCallsPerSecond: median(
        selected.map((sample) => sample.callsPerSecond),
      ),
      peakEncodedToFinishBytes: Math.max(
        ...selected.map((sample) => sample.peaks.encodedToFinishBytes),
      ),
      peakTransportRetainedBytes: Math.max(
        ...selected.map((sample) => sample.peaks.transportRetainedBytes),
      ),
      peakSenderPendingEncodedBytes: Math.max(
        ...selected.map((sample) => sample.peaks.senderPendingEncodedBytes),
      ),
    };
  }),
  samples,
};
const json = JSON.stringify(result, null, 2) + "\n";
if (Deno.args[0]) await Deno.writeTextFile(Deno.args[0], json);
console.log(json);
