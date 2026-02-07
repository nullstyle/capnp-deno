import {
  getErrorType,
  type RpcObservability,
  type RpcObservabilityAttributes,
  type RpcObservabilityAttributeValue,
  type RpcObservabilityEvent,
} from "./observability.ts";

type OTelAttributeValue = string | number | boolean;
type OTelAttributes = Record<string, OTelAttributeValue>;

interface OTelSpan {
  setAttributes?(attributes: OTelAttributes): void;
  recordException?(error: unknown): void;
  end?(endTime?: number | Date): void;
}

interface OTelTracer {
  startSpan(name: string): OTelSpan;
}

interface OTelTracerProvider {
  getTracer(name: string, version?: string): OTelTracer;
}

interface OTelCounter {
  add(value: number, attributes?: OTelAttributes): void;
}

interface OTelHistogram {
  record(value: number, attributes?: OTelAttributes): void;
}

interface OTelMeter {
  createCounter(
    name: string,
    options?: { description?: string; unit?: string },
  ): OTelCounter;
  createHistogram(
    name: string,
    options?: { description?: string; unit?: string },
  ): OTelHistogram;
}

interface OTelMeterProvider {
  getMeter(name: string, version?: string): OTelMeter;
}

interface DenoTelemetryNamespace {
  tracerProvider?: OTelTracerProvider;
  meterProvider?: OTelMeterProvider;
}

export interface DenoOtelObservabilityOptions {
  instrumentationName?: string;
  instrumentationVersion?: string;
  emitErrorSpans?: boolean;
}

function toOtelValue(
  value: RpcObservabilityAttributeValue,
): OTelAttributeValue {
  if (typeof value === "bigint") return value.toString();
  return value;
}

function toOtelAttributes(
  attributes: RpcObservabilityAttributes | undefined,
): OTelAttributes {
  const out: OTelAttributes = {};
  if (!attributes) return out;
  for (const [key, value] of Object.entries(attributes)) {
    out[key] = toOtelValue(value);
  }
  return out;
}

function readDenoTelemetry(): DenoTelemetryNamespace | undefined {
  return (Deno as unknown as { telemetry?: DenoTelemetryNamespace }).telemetry;
}

export function createDenoOtelObservability(
  options: DenoOtelObservabilityOptions = {},
): RpcObservability {
  const instrumentationName = options.instrumentationName ?? "@capnp/deno";
  const instrumentationVersion = options.instrumentationVersion ?? "0.0.0-dev";
  const emitErrorSpans = options.emitErrorSpans ?? true;

  const telemetry = readDenoTelemetry();
  if (!telemetry) return {};

  const tracer = telemetry.tracerProvider?.getTracer(
    instrumentationName,
    instrumentationVersion,
  );
  const meter = telemetry.meterProvider?.getMeter(
    instrumentationName,
    instrumentationVersion,
  );

  const eventCounter = meter?.createCounter("capnp.rpc.events", {
    description: "Total capnp-deno observability events",
    unit: "{event}",
  });
  const errorCounter = meter?.createCounter("capnp.rpc.errors", {
    description: "Total capnp-deno error events",
    unit: "{error}",
  });
  const durationHistogram = meter?.createHistogram(
    "capnp.rpc.event.duration",
    {
      description: "Duration for capnp-deno timed events",
      unit: "ms",
    },
  );

  return {
    onEvent(event: RpcObservabilityEvent): void {
      const attributes = toOtelAttributes(event.attributes);
      attributes["rpc.event.name"] = event.name;

      eventCounter?.add(1, attributes);
      if (event.durationMs !== undefined) {
        durationHistogram?.record(event.durationMs, attributes);
      }

      if (event.error !== undefined) {
        const errorAttributes = {
          ...attributes,
          "rpc.error.type": getErrorType(event.error),
        };
        errorCounter?.add(1, errorAttributes);

        if (emitErrorSpans && tracer) {
          const span = tracer.startSpan(`${event.name}.error`);
          span.setAttributes?.(errorAttributes);
          span.recordException?.(event.error);
          span.end?.();
        }
      }
    },
  };
}
