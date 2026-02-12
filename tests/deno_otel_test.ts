import { createDenoOtelObservability } from "../src/advanced.ts";
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

/**
 * Helper: creates a full fake telemetry object and returns references to all
 * the fake instruments so tests can inspect recorded values.
 */
function createFakeTelemetry() {
  const eventCounter = new FakeCounter();
  const errorCounter = new FakeCounter();
  const durationHistogram = new FakeHistogram();
  const startedSpans: Array<{ name: string; span: FakeSpan }> = [];

  const telemetry = {
    tracerProvider: {
      getTracer() {
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
      getMeter() {
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
  };

  return {
    telemetry,
    eventCounter,
    errorCounter,
    durationHistogram,
    startedSpans,
  };
}

// ---------------------------------------------------------------------------
// No-op when Deno.telemetry is unavailable
// ---------------------------------------------------------------------------

Deno.test("createDenoOtelObservability returns inert observability when Deno.telemetry is missing", () => {
  withTelemetry(undefined, () => {
    const observability = createDenoOtelObservability();
    assertEquals(typeof observability.onEvent, "undefined");
  });
});

Deno.test("createDenoOtelObservability returns inert observability when Deno.telemetry is null", () => {
  withTelemetry(null, () => {
    const observability = createDenoOtelObservability();
    assertEquals(typeof observability.onEvent, "undefined");
  });
});

Deno.test("createDenoOtelObservability returns inert observability when Deno.telemetry is false", () => {
  withTelemetry(false, () => {
    const observability = createDenoOtelObservability();
    assertEquals(typeof observability.onEvent, "undefined");
  });
});

Deno.test("createDenoOtelObservability returns inert observability regardless of options", () => {
  withTelemetry(undefined, () => {
    const observability = createDenoOtelObservability({
      instrumentationName: "test",
      instrumentationVersion: "9.9.9",
      emitErrorSpans: true,
    });
    assertEquals(typeof observability.onEvent, "undefined");
  });
});

// ---------------------------------------------------------------------------
// Full integration: counters, histogram, and error span
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Error counter increments on error events
// ---------------------------------------------------------------------------

Deno.test("error counter increments once per error event", () => {
  const { telemetry, errorCounter } = createFakeTelemetry();

  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability();
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    observability.onEvent({
      name: "rpc.transport.error",
      error: new Error("first"),
    });
    observability.onEvent({
      name: "rpc.session.error",
      error: new RangeError("second"),
    });

    assertEquals(errorCounter.adds.length, 2);
    assertEquals(errorCounter.adds[0].value, 1);
    assertEquals(errorCounter.adds[0].attributes?.["rpc.error.type"], "Error");
    assertEquals(errorCounter.adds[1].value, 1);
    assertEquals(
      errorCounter.adds[1].attributes?.["rpc.error.type"],
      "RangeError",
    );
  });
});

Deno.test("error counter is not incremented for events without errors", () => {
  const { telemetry, errorCounter } = createFakeTelemetry();

  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability();
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    observability.onEvent({ name: "rpc.session.start" });
    observability.onEvent({ name: "rpc.call", durationMs: 5 });

    assertEquals(errorCounter.adds.length, 0);
  });
});

Deno.test("error counter includes rpc.event.name attribute from the originating event", () => {
  const { telemetry, errorCounter } = createFakeTelemetry();

  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability();
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    observability.onEvent({
      name: "rpc.frame.decode",
      error: new SyntaxError("bad frame"),
    });

    assertEquals(errorCounter.adds.length, 1);
    assertEquals(
      errorCounter.adds[0].attributes?.["rpc.event.name"],
      "rpc.frame.decode",
    );
    assertEquals(
      errorCounter.adds[0].attributes?.["rpc.error.type"],
      "SyntaxError",
    );
  });
});

// ---------------------------------------------------------------------------
// Error spans: created when emitErrorSpans is true (default)
// ---------------------------------------------------------------------------

Deno.test("error spans are created by default when error is present", () => {
  const { telemetry, startedSpans } = createFakeTelemetry();

  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability();
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    const err = new URIError("bad uri");
    observability.onEvent({
      name: "rpc.transport.error",
      error: err,
    });

    assertEquals(startedSpans.length, 1);
    assertEquals(startedSpans[0].name, "rpc.transport.error.error");
    assertEquals(
      startedSpans[0].span.attributes?.["rpc.error.type"],
      "URIError",
    );
    assertEquals(startedSpans[0].span.exception, err);
    assertEquals(startedSpans[0].span.ended, true);
  });
});

Deno.test("error spans are created when emitErrorSpans is explicitly true", () => {
  const { telemetry, startedSpans } = createFakeTelemetry();

  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability({ emitErrorSpans: true });
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    const err = new TypeError("explicit true");
    observability.onEvent({ name: "rpc.call", error: err });

    assertEquals(startedSpans.length, 1);
    assertEquals(startedSpans[0].name, "rpc.call.error");
    assertEquals(startedSpans[0].span.exception, err);
    assertEquals(startedSpans[0].span.ended, true);
  });
});

// ---------------------------------------------------------------------------
// Error spans: NOT created when emitErrorSpans is false
// ---------------------------------------------------------------------------

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

Deno.test("no error spans for multiple error events when emitErrorSpans is false", () => {
  const { telemetry, startedSpans, errorCounter } = createFakeTelemetry();

  // We need to rebuild telemetry with emitErrorSpans false, but use the shared helpers
  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability({
      emitErrorSpans: false,
    });
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    observability.onEvent({ name: "rpc.err1", error: new Error("a") });
    observability.onEvent({ name: "rpc.err2", error: new TypeError("b") });
    observability.onEvent({ name: "rpc.err3", error: new RangeError("c") });

    // Error counter should still record all three errors
    assertEquals(errorCounter.adds.length, 3);
    // But no spans should have been created
    assertEquals(startedSpans.length, 0);
  });
});

Deno.test("no error spans for events without errors regardless of emitErrorSpans", () => {
  const { telemetry, startedSpans } = createFakeTelemetry();

  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability({ emitErrorSpans: true });
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    observability.onEvent({ name: "rpc.session.start" });
    observability.onEvent({ name: "rpc.call", durationMs: 10 });
    observability.onEvent({
      name: "rpc.return",
      durationMs: 2,
      attributes: { "rpc.answer_id": 1 },
    });

    assertEquals(startedSpans.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Attribute conversion: all types (string, number, boolean, bigint)
// ---------------------------------------------------------------------------

Deno.test("attribute conversion: string values are passed through", () => {
  const { telemetry, eventCounter } = createFakeTelemetry();

  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability();
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    observability.onEvent({
      name: "rpc.test",
      attributes: { "rpc.label": "hello" },
    });

    assertEquals(eventCounter.adds[0].attributes?.["rpc.label"], "hello");
  });
});

Deno.test("attribute conversion: number values are passed through", () => {
  const { telemetry, eventCounter } = createFakeTelemetry();

  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability();
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    observability.onEvent({
      name: "rpc.test",
      attributes: { "rpc.count": 42, "rpc.float": 3.14 },
    });

    assertEquals(eventCounter.adds[0].attributes?.["rpc.count"], 42);
    assertEquals(eventCounter.adds[0].attributes?.["rpc.float"], 3.14);
  });
});

Deno.test("attribute conversion: boolean values are passed through", () => {
  const { telemetry, eventCounter } = createFakeTelemetry();

  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability();
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    observability.onEvent({
      name: "rpc.test",
      attributes: { "rpc.active": true, "rpc.closed": false },
    });

    assertEquals(eventCounter.adds[0].attributes?.["rpc.active"], true);
    assertEquals(eventCounter.adds[0].attributes?.["rpc.closed"], false);
  });
});

Deno.test("attribute conversion: bigint values are converted to string", () => {
  const { telemetry, eventCounter } = createFakeTelemetry();

  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability();
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    observability.onEvent({
      name: "rpc.test",
      attributes: {
        "rpc.interface_id": 0xDEAD_BEEF_CAFE_BABEn,
        "rpc.small_bigint": 0n,
        "rpc.negative_bigint": -42n,
      },
    });

    assertEquals(
      eventCounter.adds[0].attributes?.["rpc.interface_id"],
      "16045690984503098046",
    );
    assertEquals(eventCounter.adds[0].attributes?.["rpc.small_bigint"], "0");
    assertEquals(
      eventCounter.adds[0].attributes?.["rpc.negative_bigint"],
      "-42",
    );
  });
});

Deno.test("attribute conversion: mixed types in a single event", () => {
  const { telemetry, eventCounter } = createFakeTelemetry();

  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability();
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    observability.onEvent({
      name: "rpc.call",
      attributes: {
        "rpc.interface_id": 0xFFn,
        "rpc.method_id": 7,
        "rpc.has_caps": true,
        "rpc.label": "test-method",
      },
    });

    const attrs = eventCounter.adds[0].attributes!;
    assertEquals(attrs["rpc.interface_id"], "255");
    assertEquals(attrs["rpc.method_id"], 7);
    assertEquals(attrs["rpc.has_caps"], true);
    assertEquals(attrs["rpc.label"], "test-method");
    assertEquals(attrs["rpc.event.name"], "rpc.call");
  });
});

Deno.test("attribute conversion: empty attributes produce only rpc.event.name", () => {
  const { telemetry, eventCounter } = createFakeTelemetry();

  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability();
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    observability.onEvent({ name: "rpc.test", attributes: {} });

    const attrs = eventCounter.adds[0].attributes!;
    assertEquals(attrs["rpc.event.name"], "rpc.test");
    // Verify no extra keys beyond rpc.event.name
    const keys = Object.keys(attrs);
    assertEquals(keys.length, 1);
  });
});

Deno.test("attribute conversion: undefined attributes produce only rpc.event.name", () => {
  const { telemetry, eventCounter } = createFakeTelemetry();

  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability();
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    observability.onEvent({ name: "rpc.test" });

    const attrs = eventCounter.adds[0].attributes!;
    assertEquals(attrs["rpc.event.name"], "rpc.test");
    const keys = Object.keys(attrs);
    assertEquals(keys.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Histogram behavior: durationMs present vs. absent
// ---------------------------------------------------------------------------

Deno.test("histogram records duration when durationMs is present", () => {
  const { telemetry, durationHistogram } = createFakeTelemetry();

  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability();
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    observability.onEvent({ name: "rpc.call", durationMs: 100 });

    assertEquals(durationHistogram.records.length, 1);
    assertEquals(durationHistogram.records[0].value, 100);
    assertEquals(
      durationHistogram.records[0].attributes?.["rpc.event.name"],
      "rpc.call",
    );
  });
});

Deno.test("histogram records zero duration", () => {
  const { telemetry, durationHistogram } = createFakeTelemetry();

  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability();
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    observability.onEvent({ name: "rpc.fast", durationMs: 0 });

    assertEquals(durationHistogram.records.length, 1);
    assertEquals(durationHistogram.records[0].value, 0);
  });
});

Deno.test("histogram does not record when durationMs is absent", () => {
  const { telemetry, durationHistogram } = createFakeTelemetry();

  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability();
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    observability.onEvent({ name: "rpc.session.start" });

    assertEquals(durationHistogram.records.length, 0);
  });
});

Deno.test("histogram records fractional duration", () => {
  const { telemetry, durationHistogram } = createFakeTelemetry();

  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability();
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    observability.onEvent({ name: "rpc.call", durationMs: 0.123 });

    assertEquals(durationHistogram.records.length, 1);
    assertEquals(durationHistogram.records[0].value, 0.123);
  });
});

// ---------------------------------------------------------------------------
// Event counter always increments
// ---------------------------------------------------------------------------

Deno.test("event counter increments for every event regardless of error/duration", () => {
  const { telemetry, eventCounter } = createFakeTelemetry();

  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability();
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    observability.onEvent({ name: "rpc.session.start" });
    observability.onEvent({ name: "rpc.call", durationMs: 5 });
    observability.onEvent({
      name: "rpc.error",
      error: new Error("e"),
    });
    observability.onEvent({
      name: "rpc.call",
      durationMs: 10,
      error: new Error("f"),
      attributes: { "rpc.id": 99 },
    });

    assertEquals(eventCounter.adds.length, 4);
    for (const add of eventCounter.adds) {
      assertEquals(add.value, 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Multiple events accumulate correctly
// ---------------------------------------------------------------------------

Deno.test("multiple events accumulate counters, histograms, and spans correctly", () => {
  const {
    telemetry,
    eventCounter,
    errorCounter,
    durationHistogram,
    startedSpans,
  } = createFakeTelemetry();

  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability({ emitErrorSpans: true });
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    // Event 1: no error, no duration
    observability.onEvent({ name: "rpc.session.start" });

    // Event 2: with duration, no error
    observability.onEvent({ name: "rpc.call", durationMs: 10 });

    // Event 3: with error, no duration
    observability.onEvent({
      name: "rpc.decode.error",
      error: new SyntaxError("bad"),
    });

    // Event 4: with error and duration
    observability.onEvent({
      name: "rpc.transport.error",
      durationMs: 50,
      error: new TypeError("timeout"),
    });

    // Event 5: no error, no duration, with attributes
    observability.onEvent({
      name: "rpc.finish",
      attributes: { "rpc.question_id": 7 },
    });

    assertEquals(eventCounter.adds.length, 5);
    assertEquals(errorCounter.adds.length, 2);
    assertEquals(durationHistogram.records.length, 2);
    assertEquals(durationHistogram.records[0].value, 10);
    assertEquals(durationHistogram.records[1].value, 50);
    assertEquals(startedSpans.length, 2);
    assertEquals(startedSpans[0].name, "rpc.decode.error.error");
    assertEquals(startedSpans[1].name, "rpc.transport.error.error");
  });
});

// ---------------------------------------------------------------------------
// Default instrumentation name and version
// ---------------------------------------------------------------------------

Deno.test("createDenoOtelObservability uses default instrumentation name and version", () => {
  const getTracerCalls: Array<{ name: string; version?: string }> = [];
  const getMeterCalls: Array<{ name: string; version?: string }> = [];

  withTelemetry({
    tracerProvider: {
      getTracer(name: string, version?: string) {
        getTracerCalls.push({ name, version });
        return {
          startSpan(): FakeSpan {
            return new FakeSpan();
          },
        };
      },
    },
    meterProvider: {
      getMeter(name: string, version?: string) {
        getMeterCalls.push({ name, version });
        return {
          createCounter() {
            return new FakeCounter();
          },
          createHistogram() {
            return new FakeHistogram();
          },
        };
      },
    },
  }, () => {
    const observability = createDenoOtelObservability();
    assert(observability.onEvent !== undefined, "expected onEvent handler");

    assertEquals(getTracerCalls.length, 1);
    assertEquals(getTracerCalls[0].name, "@capnp/deno");
    assertEquals(getTracerCalls[0].version, "0.0.0-dev");
    assertEquals(getMeterCalls.length, 1);
    assertEquals(getMeterCalls[0].name, "@capnp/deno");
    assertEquals(getMeterCalls[0].version, "0.0.0-dev");
  });
});

// ---------------------------------------------------------------------------
// Tolerates missing tracer/meter providers
// ---------------------------------------------------------------------------

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

Deno.test("createDenoOtelObservability tolerates missing tracerProvider only", () => {
  const eventCounter = new FakeCounter();
  const errorCounter = new FakeCounter();

  withTelemetry({
    meterProvider: {
      getMeter() {
        return {
          createCounter(name: string) {
            if (name === "capnp.rpc.events") return eventCounter;
            if (name === "capnp.rpc.errors") return errorCounter;
            throw new Error(`unexpected counter: ${name}`);
          },
          createHistogram() {
            return new FakeHistogram();
          },
        };
      },
    },
  }, () => {
    const observability = createDenoOtelObservability();
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    observability.onEvent({
      name: "rpc.test",
      error: new Error("no tracer"),
    });

    // Event counter and error counter should still work even without a tracer
    assertEquals(eventCounter.adds.length, 1);
    assertEquals(errorCounter.adds.length, 1);
  });
});

Deno.test("createDenoOtelObservability tolerates missing meterProvider only", () => {
  const startedSpans: Array<{ name: string; span: FakeSpan }> = [];

  withTelemetry({
    tracerProvider: {
      getTracer() {
        return {
          startSpan(spanName: string): FakeSpan {
            const span = new FakeSpan();
            startedSpans.push({ name: spanName, span });
            return span;
          },
        };
      },
    },
  }, () => {
    const observability = createDenoOtelObservability();
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    observability.onEvent({
      name: "rpc.test",
      durationMs: 5,
      error: new Error("no meter"),
    });

    // Error span should still be created even without a meter
    assertEquals(startedSpans.length, 1);
    assertEquals(startedSpans[0].name, "rpc.test.error");
  });
});

// ---------------------------------------------------------------------------
// Error span attributes include event-level attributes
// ---------------------------------------------------------------------------

Deno.test("error span attributes include event-level attributes alongside error type", () => {
  const { telemetry, startedSpans } = createFakeTelemetry();

  withTelemetry(telemetry, () => {
    const observability = createDenoOtelObservability({ emitErrorSpans: true });
    if (!observability.onEvent) throw new Error("expected onEvent handler");

    observability.onEvent({
      name: "rpc.call",
      attributes: {
        "rpc.question_id": 42,
        "rpc.interface_id": 0xABCDn,
      },
      error: new Error("span attrs test"),
    });

    assertEquals(startedSpans.length, 1);
    const spanAttrs = startedSpans[0].span.attributes!;
    assertEquals(spanAttrs["rpc.event.name"], "rpc.call");
    assertEquals(spanAttrs["rpc.question_id"], 42);
    assertEquals(spanAttrs["rpc.interface_id"], "43981");
    assertEquals(spanAttrs["rpc.error.type"], "Error");
  });
});
