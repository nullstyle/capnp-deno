import {
  Pinger,
  PingResultsCodec,
  type Ponger,
  PongParamsCodec,
} from "../examples/ping/gen/schema_types.ts";
import {
  type CounterSink as CounterSinkClient,
  createCounterSinkAddStreamSender,
} from "../examples/streaming/gen/schema_types.ts";
import type { CapabilityPointer } from "../src/encoding.ts";
import type {
  RpcBootstrapClientTransport,
  RpcCallContext,
  RpcCallOptions,
  RpcExportCapabilityOptions,
  RpcGeneratedServerDispatch as RpcServerDispatch,
} from "../src/rpc.ts";

let blackhole = 0;

class GeneratedCallbackBenchTransport implements RpcBootstrapClientTransport {
  #nextCapabilityIndex = 1;
  #nextQuestionId = 1;
  readonly #capabilities = new Map<number, RpcServerDispatch>();
  finished = 0;

  bootstrap(_options?: RpcCallOptions): Promise<CapabilityPointer> {
    return Promise.resolve({ capabilityIndex: 0 });
  }

  exportCapability(
    dispatch: RpcServerDispatch,
    options?: RpcExportCapabilityOptions,
  ): CapabilityPointer {
    const capabilityIndex = options?.capabilityIndex ??
      this.#nextCapabilityIndex++;
    this.#capabilities.set(capabilityIndex, dispatch);
    return { capabilityIndex };
  }

  async call(
    _capability: CapabilityPointer,
    methodId: number,
    _params: Uint8Array,
    options?: RpcCallOptions,
  ): Promise<Uint8Array> {
    const questionId = this.#nextQuestionId++;
    options?.onQuestionId?.(questionId);
    const callbackCap = options?.paramsCapTable?.[0]?.id;
    if (callbackCap !== undefined) {
      const callback = this.#capabilities.get(callbackCap);
      if (!callback) {
        throw new Error(`missing callback cap ${callbackCap}`);
      }
      const ctx: RpcCallContext = {
        capability: { capabilityIndex: callbackCap },
        methodId: 0,
        questionId,
        interfaceId: callback.interfaceId,
        signal: new AbortController().signal,
      };
      await callback.dispatch(0, PongParamsCodec.encode({ n: methodId }), ctx);
      blackhole ^= methodId;
    }
    return PingResultsCodec.encode({});
  }

  finish(_questionId: number): void {
    this.finished += 1;
  }
}

const callbackTransport = new GeneratedCallbackBenchTransport();
const pinger = await Pinger.bootstrapClient(callbackTransport);
const ponger: Ponger = {
  pong(value) {
    blackhole ^= value;
    return Promise.resolve();
  },
};

Deno.bench({
  name: "generated_rpc:callback_cap_export_call_finish",
  group: "generated_rpc",
  baseline: true,
  n: 3_000,
  warmup: 150,
  async fn() {
    await pinger.ping(ponger);
  },
});

const counter: CounterSinkClient = {
  add(value, options) {
    if (options?.signal?.aborted) {
      throw new Error("unexpected aborted generated stream call");
    }
    blackhole ^= value;
    return Promise.resolve();
  },

  total() {
    return Promise.resolve({
      sum: BigInt(blackhole >>> 0),
      count: 1,
    });
  },
};

const streamValues = Array.from({ length: 32 }, (_v, i) => i + 1);

Deno.bench({
  name: "generated_rpc:typed_stream_sender_32",
  group: "generated_rpc",
  n: 1_000,
  warmup: 80,
  async fn() {
    const sender = createCounterSinkAddStreamSender(counter, {
      maxInFlight: 8,
    });
    for (const value of streamValues) {
      await sender.send(value);
    }
    await sender.flush();
  },
});
