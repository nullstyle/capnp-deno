import { createDenoOtelObservability } from "../mod.ts";
import { assert, assertEquals } from "./test_utils.ts";

type Attributes = Record<string, string | number | boolean>;

class FakeCounter {
  readonly adds: Array<{ value: number; attributes?: Attributes }> = [];

  add(value: number, attributes?: Attributes): void {
    this.adds.push({ value, attributes });
  }
}

class FakeHistogram {
  readonly records: Array<{ value: number; attributes?: Attributes }> = [];

  record(value: number, attributes?: Attributes): void {
    this.records.push({ value, attributes });
  }
}

class FakeSpan {
  attributes: Attributes | undefined;
  exception: unknown;
  ended = false;

  setAttributes(attributes: Attributes): void {
    this.attributes = attributes;
  }

  recordException(error: unknown): void {
    this.exception = error;
  }

  end(): void {
    this.ended = true;
  }
}

function withTelemetry(
  telemetry: unknown,
  fn: () => void,
): void {
  const denoObject = Deno as unknown as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(denoObject, "telemetry");
  Object.defineProperty(denoObject, "telemetry", {
    configurable: true,
    writable: true,
    value: telemetry,
  });
  try {
    fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(denoObject, "telemetry", descriptor);
    } else {
      delete denoObject.telemetry;
    }
  }
}

Deno.test("createDenoOtelObservability returns inert observability when Deno.telemetry is missing", () => {
  withTelemetry(undefined, () => {
    const observability = createDenoOtelObservability();
    assertEquals(typeof observability.onEvent, "undefined");
  });
});

Deno.test("createDenoOtelObservability emits counters, histogram, and error span", () => {
  const eventCounter = new FakeCounter();
  const errorCounter = new FakeCounter();
  const durationHistogram = new FakeHistogram();
  const startedSpans: Array<{ name: string; span: FakeSpan }> = [];
  const getTracerCalls: Array<{ name: string; version?: string }> = [];
  const getMeterCalls: Array<{ name: string; version?: string }> = [];

  withTelemetry({
    tracerProvider: {
      getTracer(name: string, version?: string) {
        getTracerCalls.push({ name, version });
        return {
          startSpan(spanName: string): FakeSpan {
            const span = new FakeSpan();
            startedSpans.push({ name: spanName, span });
            return span;
          },
        };
      },
    },
    meterProvider: {
      getMeter(name: string, version?: string) {
        getMeterCalls.push({ name, version });
        return {
          createCounter(counterName: string) {
            if (counterName === "capnp.rpc.events") return eventCounter;
            if (counterName === "capnp.rpc.errors") return errorCounter;
            throw new Error(`unexpected counter name: ${counterName}`);
          },
          createHistogram(histogramName: string) {
            if (histogramName === "capnp.rpc.event.duration") {
              return durationHistogram;
            }
            throw new Error(`unexpected histogram name: ${histogramName}`);
          },
        };
      },
    },
  }, () => {
    const observability = createDenoOtelObservability({
      instrumentationName: "capnp-deno-test",
      instrumentationVersion: "1.2.3",
    });
    if (!observability.onEvent) {
      throw new Error("expected onEvent handler");
    }

    const error = new TypeError("boom");
    observability.onEvent({
      name: "rpc.call",
      attributes: {
        "rpc.question_id": 123,
        "rpc.has_caps": true,
        "rpc.interface_id": 0x1234n,
      },
      durationMs: 42,
      error,
    });

    assertEquals(getTracerCalls.length, 1);
    assertEquals(getMeterCalls.length, 1);
    assertEquals(getTracerCalls[0].name, "capnp-deno-test");
    assertEquals(getTracerCalls[0].version, "1.2.3");
    assertEquals(getMeterCalls[0].name, "capnp-deno-test");
    assertEquals(getMeterCalls[0].version, "1.2.3");

    assertEquals(eventCounter.adds.length, 1);
    assertEquals(eventCounter.adds[0].value, 1);
    assertEquals(
      eventCounter.adds[0].attributes?.["rpc.event.name"],
      "rpc.call",
    );
    assertEquals(eventCounter.adds[0].attributes?.["rpc.interface_id"], "4660");

    assertEquals(durationHistogram.records.length, 1);
    assertEquals(durationHistogram.records[0].value, 42);
    assertEquals(
      durationHistogram.records[0].attributes?.["rpc.event.name"],
      "rpc.call",
    );

    assertEquals(errorCounter.adds.length, 1);
    assertEquals(
      errorCounter.adds[0].attributes?.["rpc.error.type"],
      "TypeError",
    );

    assertEquals(startedSpans.length, 1);
    assertEquals(startedSpans[0].name, "rpc.call.error");
    assertEquals(
      startedSpans[0].span.attributes?.["rpc.error.type"],
      "TypeError",
    );
    assertEquals(startedSpans[0].span.exception, error);
    assertEquals(startedSpans[0].span.ended, true);
  });
});

Deno.test("createDenoOtelObservability can suppress error spans while still emitting metrics", () => {
  const eventCounter = new FakeCounter();
  const errorCounter = new FakeCounter();
  const durationHistogram = new FakeHistogram();
  let spanStarts = 0;

  withTelemetry({
    tracerProvider: {
      getTracer() {
        return {
          startSpan() {
            spanStarts += 1;
            return new FakeSpan();
          },
        };
      },
    },
    meterProvider: {
      getMeter() {
        return {
          createCounter(counterName: string) {
            return counterName === "capnp.rpc.events"
              ? eventCounter
              : errorCounter;
          },
          createHistogram() {
            return durationHistogram;
          },
        };
      },
    },
  }, () => {
    const observability = createDenoOtelObservability({
      emitErrorSpans: false,
    });
    if (!observability.onEvent) {
      throw new Error("expected onEvent handler");
    }

    observability.onEvent({
      name: "rpc.bootstrap",
      durationMs: 3,
      error: new Error("no-span"),
    });

    assertEquals(eventCounter.adds.length, 1);
    assertEquals(errorCounter.adds.length, 1);
    assertEquals(durationHistogram.records.length, 1);
    assertEquals(spanStarts, 0);
  });
});

Deno.test("createDenoOtelObservability tolerates missing tracer/meter providers", () => {
  withTelemetry({}, () => {
    const observability = createDenoOtelObservability();
    if (!observability.onEvent) {
      throw new Error("expected onEvent handler");
    }

    observability.onEvent({
      name: "rpc.noop",
      attributes: { "rpc.flag": true },
      durationMs: 1,
      error: new Error("ignored"),
    });
  });

  assert(true, "event dispatch should not throw");
});
