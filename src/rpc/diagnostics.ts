/**
 * RPC diagnostics helpers for generated client/server debugging.
 *
 * @module
 */

import { CapnpError, SessionError } from "../errors.ts";
import type {
  RpcObservability,
  RpcObservabilityAttributes,
  RpcObservabilityEvent,
} from "../observability/observability.ts";
import {
  decodeBootstrapRequestFrame,
  decodeCallRequestFrame,
  decodeFinishFrame,
  decodeReleaseFrame,
  decodeReturnFrame,
  decodeRpcMessageTag,
  RPC_MESSAGE_TAG_BOOTSTRAP,
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_DISEMBARGO,
  RPC_MESSAGE_TAG_FINISH,
  RPC_MESSAGE_TAG_RELEASE,
  RPC_MESSAGE_TAG_RESOLVE,
  RPC_MESSAGE_TAG_RETURN,
} from "./wire.ts";
import type {
  RpcFrameDirection,
  RpcTransportMiddleware,
} from "./transports/middleware/rpc_middleware.ts";

const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_PAYLOAD_HEX_BYTES = 64;

export interface RpcDebugPayloadSummary {
  /** Number of decoded payload/content bytes. */
  readonly byteLength: number;
  /** Whether payload bytes were withheld. */
  readonly redacted: boolean;
  /** Optional bounded hexadecimal payload prefix. */
  readonly hex?: string;
  /** Number of bytes represented in {@link hex}. */
  readonly hexBytes?: number;
}

export interface RpcDebugSchemaMethod {
  /** Cap'n Proto interface ID. */
  readonly interfaceId: bigint;
  /** Generated interface name. */
  readonly interfaceName: string;
  /** Generated service token name, when different from the interface name. */
  readonly serviceName?: string;
  /** Method ordinal. */
  readonly methodId: number;
  /** Generated method name. */
  readonly methodName: string;
}

export interface RpcDebugEvent {
  /** Millisecond timestamp from `Date.now()`. */
  readonly timestampMs: number;
  /** Event source. */
  readonly kind: "frame" | "observability";
  /** Transport frame direction for frame events. */
  readonly direction?: RpcFrameDirection;
  /** Raw frame size in bytes. */
  readonly frameBytes?: number;
  /** Numeric RPC message tag. */
  readonly messageTag?: number;
  /** Human-readable RPC message name. */
  readonly messageName?: string;
  /** RPC question ID. */
  readonly questionId?: number;
  /** RPC answer ID. */
  readonly answerId?: number;
  /** Cap'n Proto interface ID. */
  readonly interfaceId?: bigint;
  /** Generated service token name, when known. */
  readonly serviceName?: string;
  /** Generated interface name, when known. */
  readonly interfaceName?: string;
  /** RPC method ordinal. */
  readonly methodId?: number;
  /** Generated method name, when known. */
  readonly methodName?: string;
  /** Capability index involved in the frame. */
  readonly capabilityIndex?: number;
  /** Number of capability descriptors attached to params/results. */
  readonly capTableCount?: number;
  /** Return message kind. */
  readonly returnKind?: "results" | "exception";
  /** Finish release-result-capability flag. */
  readonly releaseResultCaps?: boolean;
  /** Finish early-cancellation flag. */
  readonly requireEarlyCancellation?: boolean;
  /** Return exception reason, when present. */
  readonly reason?: string;
  /** Redacted or explicitly enabled payload/content summary. */
  readonly payload?: RpcDebugPayloadSummary;
  /** Observability event name for observability events. */
  readonly eventName?: string;
  /** Observability attributes for observability events. */
  readonly attributes?: RpcObservabilityAttributes;
  /** Error type associated with a failed decode or observability event. */
  readonly errorType?: string;
  /** Error message associated with a failed decode or observability event. */
  readonly errorMessage?: string;
}

export interface RpcDebugEventFormatOptions {
  /** Include the event timestamp in formatted output. Defaults to false. */
  includeTimestamp?: boolean;
  /** Include payload hexadecimal snippets when present. Defaults to true. */
  includePayloadHex?: boolean;
}

export interface RpcDebugTracerOptions {
  /**
   * Logging sink. `true` logs formatted events through `console.debug`.
   * Defaults to `false`.
   */
  log?: boolean | ((line: string, event: RpcDebugEvent) => void);
  /** Include bounded payload hexadecimal snippets. Defaults to redacted only. */
  includePayloadHex?: boolean | { maxBytes?: number };
  /** Maximum number of events retained in memory. Defaults to 500. */
  maxEvents?: number;
}

export interface RpcDebugTracer {
  /** Middleware that records transport frame summaries. */
  readonly middleware: RpcTransportMiddleware;
  /** Observability hook that records runtime events and errors. */
  readonly observability: RpcObservability;
  /**
   * Record a debug event.
   *
   * @param event - Event to append to the ring buffer.
   */
  record(event: RpcDebugEvent): void;
  /**
   * Return a snapshot of retained events.
   *
   * @returns A copy of retained debug events in insertion order.
   */
  snapshot(): RpcDebugEvent[];
  /**
   * Clear retained debug events.
   */
  clear(): void;
  /**
   * Register generated interface/method metadata for later frame enrichment.
   *
   * High-level `connect()` / `serve()` helpers call this automatically when a
   * generated service token includes method metadata.
   *
   * @param methods - Generated method metadata to add to the tracer.
   */
  registerSchema?(methods: Iterable<RpcDebugSchemaMethod>): void;
}

function rpcMessageName(tag: number | undefined): string {
  switch (tag) {
    case RPC_MESSAGE_TAG_BOOTSTRAP:
      return "Bootstrap";
    case RPC_MESSAGE_TAG_CALL:
      return "Call";
    case RPC_MESSAGE_TAG_RETURN:
      return "Return";
    case RPC_MESSAGE_TAG_FINISH:
      return "Finish";
    case RPC_MESSAGE_TAG_RELEASE:
      return "Release";
    case RPC_MESSAGE_TAG_RESOLVE:
      return "Resolve";
    case RPC_MESSAGE_TAG_DISEMBARGO:
      return "Disembargo";
    case undefined:
      return "DecodeError";
    default:
      return `Unknown(${tag})`;
  }
}

function formatBigint(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function schemaMethodKey(interfaceId: bigint, methodId: number): string {
  return `${interfaceId.toString(16)}:${methodId}`;
}

function errorType(error: unknown): string | undefined {
  if (error instanceof Error && error.name.length > 0) return error.name;
  if (error !== undefined) return typeof error;
  return undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (error === undefined) return undefined;
  return String(error);
}

function includePayloadHexLimit(
  option: RpcDebugTracerOptions["includePayloadHex"],
): number | null {
  if (!option) return null;
  if (option === true) return DEFAULT_PAYLOAD_HEX_BYTES;
  const maxBytes = option.maxBytes ?? DEFAULT_PAYLOAD_HEX_BYTES;
  return Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : null;
}

function toHex(bytes: Uint8Array, maxBytes: number): string {
  const limit = Math.min(bytes.byteLength, maxBytes);
  const parts: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    parts.push(bytes[i].toString(16).padStart(2, "0"));
  }
  return parts.join("");
}

function payloadSummary(
  bytes: Uint8Array,
  payloadHexBytes: number | null,
): RpcDebugPayloadSummary {
  if (payloadHexBytes === null) {
    return { byteLength: bytes.byteLength, redacted: true };
  }
  return {
    byteLength: bytes.byteLength,
    redacted: false,
    hex: toHex(bytes, payloadHexBytes),
    hexBytes: Math.min(bytes.byteLength, payloadHexBytes),
  };
}

function makeDecodeErrorEvent(
  frame: Uint8Array,
  direction: RpcFrameDirection,
  error: unknown,
  tag?: number,
): RpcDebugEvent {
  return {
    timestampMs: Date.now(),
    kind: "frame",
    direction,
    frameBytes: frame.byteLength,
    messageTag: tag,
    messageName: rpcMessageName(tag),
    errorType: errorType(error),
    errorMessage: errorMessage(error),
  };
}

function summarizeFrame(
  frame: Uint8Array,
  direction: RpcFrameDirection,
  payloadHexBytes: number | null,
): RpcDebugEvent {
  let tag: number;
  try {
    tag = decodeRpcMessageTag(frame);
  } catch (error) {
    return makeDecodeErrorEvent(frame, direction, error);
  }

  const base = {
    timestampMs: Date.now(),
    kind: "frame" as const,
    direction,
    frameBytes: frame.byteLength,
    messageTag: tag,
    messageName: rpcMessageName(tag),
  };

  try {
    switch (tag) {
      case RPC_MESSAGE_TAG_BOOTSTRAP: {
        const bootstrap = decodeBootstrapRequestFrame(frame);
        return { ...base, questionId: bootstrap.questionId };
      }
      case RPC_MESSAGE_TAG_CALL: {
        const call = decodeCallRequestFrame(frame);
        return {
          ...base,
          questionId: call.questionId,
          interfaceId: call.interfaceId,
          methodId: call.methodId,
          capabilityIndex: call.targetImportedCap,
          capTableCount: call.paramsCapTable.length,
          payload: payloadSummary(call.paramsContent, payloadHexBytes),
        };
      }
      case RPC_MESSAGE_TAG_RETURN: {
        const ret = decodeReturnFrame(frame);
        if (ret.kind === "exception") {
          return {
            ...base,
            answerId: ret.answerId,
            returnKind: ret.kind,
            reason: ret.reason,
          };
        }
        return {
          ...base,
          answerId: ret.answerId,
          returnKind: ret.kind,
          capTableCount: ret.capTable.length,
          payload: payloadSummary(ret.contentBytes, payloadHexBytes),
        };
      }
      case RPC_MESSAGE_TAG_FINISH: {
        const finish = decodeFinishFrame(frame);
        return {
          ...base,
          questionId: finish.questionId,
          releaseResultCaps: finish.releaseResultCaps,
          requireEarlyCancellation: finish.requireEarlyCancellation,
        };
      }
      case RPC_MESSAGE_TAG_RELEASE: {
        const release = decodeReleaseFrame(frame);
        return {
          ...base,
          capabilityIndex: release.id,
        };
      }
      default:
        return base;
    }
  } catch (error) {
    return makeDecodeErrorEvent(frame, direction, error, tag);
  }
}

function eventErrorFields(error: unknown): Pick<
  RpcDebugEvent,
  "errorType" | "errorMessage"
> {
  if (error === undefined) return {};
  return {
    errorType: errorType(error),
    errorMessage: errorMessage(error),
  };
}

function observabilityDebugEvent(
  event: RpcObservabilityEvent,
): RpcDebugEvent {
  const metadata = event.error instanceof CapnpError
    ? event.error.metadata
    : undefined;
  return {
    timestampMs: Date.now(),
    kind: "observability",
    eventName: event.name,
    attributes: event.attributes,
    questionId: metadata?.questionId,
    answerId: metadata?.answerId,
    interfaceId: metadata?.interfaceId,
    serviceName: metadata?.serviceName,
    interfaceName: metadata?.interfaceName,
    methodId: metadata?.methodId,
    methodName: metadata?.methodName,
    capabilityIndex: metadata?.capabilityIndex,
    frameBytes: metadata?.frameBytes,
    messageTag: metadata?.messageTag,
    messageName: metadata?.messageName,
    ...eventErrorFields(event.error),
  };
}

function formatPayload(payload: RpcDebugPayloadSummary | undefined): string[] {
  if (!payload) return [];
  if (payload.redacted) {
    return [`payload=redacted(${payload.byteLength}b)`];
  }
  return [
    `payload=${payload.byteLength}b`,
    payload.hex ? `hex=${payload.hex}` : "hex=",
  ];
}

function attributeString(
  attributes: RpcObservabilityAttributes | undefined,
  key: string,
): string | undefined {
  const value = attributes?.[key];
  if (value === undefined) return undefined;
  return String(value);
}

function eventServiceName(event: RpcDebugEvent): string | undefined {
  return event.serviceName ??
    attributeString(event.attributes, "rpc.service_name");
}

function eventInterfaceName(event: RpcDebugEvent): string | undefined {
  return event.interfaceName ??
    attributeString(event.attributes, "rpc.interface_name");
}

function eventMethodName(event: RpcDebugEvent): string | undefined {
  return event.methodName ??
    attributeString(event.attributes, "rpc.method_name");
}

/**
 * Format a debug event as a concise human-readable line.
 *
 * @param event - Debug event to format.
 * @param options - Formatting options.
 * @returns A stable one-line string for local diagnostic logs.
 *
 * @example
 * ```ts
 * const line = formatRpcDebugEvent(debug.snapshot()[0]);
 * console.debug(line);
 * ```
 */
export function formatRpcDebugEvent(
  event: RpcDebugEvent,
  options: RpcDebugEventFormatOptions = {},
): string {
  const parts: string[] = ["[rpc.debug]"];
  if (options.includeTimestamp) {
    parts.push(new Date(event.timestampMs).toISOString());
  }
  if (event.kind === "observability") {
    parts.push("event", event.eventName ?? "unknown");
    const serviceName = eventServiceName(event);
    const peerId = attributeString(event.attributes, "rpc.peer_id");
    if (serviceName) parts.push(`service=${serviceName}`);
    if (peerId) parts.push(`peer=${peerId}`);
  } else {
    parts.push(event.direction ?? "frame", event.messageName ?? "Unknown");
  }
  const interfaceName = eventInterfaceName(event);
  const methodName = eventMethodName(event);
  if (interfaceName && methodName) {
    parts.push(`rpc=${interfaceName}.${methodName}`);
  }
  if (event.frameBytes !== undefined) parts.push(`bytes=${event.frameBytes}`);
  if (event.questionId !== undefined) parts.push(`q=${event.questionId}`);
  if (event.answerId !== undefined) parts.push(`a=${event.answerId}`);
  if (event.interfaceId !== undefined) {
    parts.push(`iface=${formatBigint(event.interfaceId)}`);
  }
  if (event.methodId !== undefined) parts.push(`method=${event.methodId}`);
  if (event.capabilityIndex !== undefined) {
    parts.push(`cap=${event.capabilityIndex}`);
  }
  if (event.capTableCount !== undefined) {
    parts.push(`caps=${event.capTableCount}`);
  }
  if (event.returnKind) parts.push(`return=${event.returnKind}`);
  if (event.requireEarlyCancellation !== undefined) {
    parts.push(`earlyCancel=${event.requireEarlyCancellation}`);
  }
  if (options.includePayloadHex === false && event.payload?.hex) {
    parts.push(`payload=${event.payload.byteLength}b`);
  } else {
    parts.push(...formatPayload(event.payload));
  }
  if (event.errorType) parts.push(`error=${event.errorType}`);
  if (event.errorMessage) {
    parts.push(`message=${JSON.stringify(event.errorMessage)}`);
  }
  return parts.join(" ");
}

function createLogSink(
  log: RpcDebugTracerOptions["log"],
): ((event: RpcDebugEvent) => void) | null {
  if (!log) return null;
  if (log === true) {
    return (event) => console.debug(formatRpcDebugEvent(event));
  }
  return (event) => log(formatRpcDebugEvent(event), event);
}

/**
 * Create an opt-in RPC debug tracer for generated clients and servers.
 *
 * The tracer records frame summaries through transport middleware and runtime
 * events through the existing observability hook. Payload bytes are redacted by
 * default; enable `includePayloadHex` only for trusted local debugging.
 *
 * @param options - Tracer storage, logging, and payload-snippet options.
 * @returns A tracer with middleware, observability hook, and event buffer.
 *
 * @example
 * ```ts
 * const debug = createRpcDebugTracer({ log: true });
 * using client = await connect(Pinger, transport, { debug });
 * console.log(debug.snapshot());
 * ```
 */
export function createRpcDebugTracer(
  options: RpcDebugTracerOptions = {},
): RpcDebugTracer {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  if (!Number.isInteger(maxEvents) || maxEvents <= 0) {
    throw new SessionError("maxEvents must be a positive integer");
  }
  const payloadHexBytes = includePayloadHexLimit(options.includePayloadHex);
  const events: RpcDebugEvent[] = [];
  const logEvent = createLogSink(options.log);
  const methodByKey = new Map<string, RpcDebugSchemaMethod>();

  const registerSchema = (methods: Iterable<RpcDebugSchemaMethod>): void => {
    for (const method of methods) {
      methodByKey.set(
        schemaMethodKey(method.interfaceId, method.methodId),
        method,
      );
    }
  };

  const enrichEvent = (event: RpcDebugEvent): RpcDebugEvent => {
    if (event.interfaceId === undefined || event.methodId === undefined) {
      return event;
    }
    const method = methodByKey.get(
      schemaMethodKey(event.interfaceId, event.methodId),
    );
    if (!method) return event;
    return {
      ...event,
      serviceName: event.serviceName ?? method.serviceName ??
        method.interfaceName,
      interfaceName: event.interfaceName ?? method.interfaceName,
      methodName: event.methodName ?? method.methodName,
    };
  };

  const record = (event: RpcDebugEvent): void => {
    const enriched = enrichEvent(event);
    events.push(enriched);
    while (events.length > maxEvents) {
      events.shift();
    }
    try {
      logEvent?.(enriched);
    } catch {
      // Debug logging must never affect RPC behavior.
    }
  };

  return {
    middleware: {
      onSend(frame: Uint8Array): Uint8Array {
        record(summarizeFrame(frame, "send", payloadHexBytes));
        return frame;
      },
      onReceive(frame: Uint8Array): Uint8Array {
        record(summarizeFrame(frame, "receive", payloadHexBytes));
        return frame;
      },
    },
    observability: {
      onEvent(event: RpcObservabilityEvent): void {
        record(observabilityDebugEvent(event));
      },
    },
    record,
    snapshot(): RpcDebugEvent[] {
      return [...events];
    },
    clear(): void {
      events.splice(0);
    },
    registerSchema,
  };
}
