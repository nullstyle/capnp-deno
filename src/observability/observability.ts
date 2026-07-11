/**
 * Observability primitives for the capnp-deno runtime.
 *
 * Provides the {@link RpcObservability} hook interface, event types, and
 * the {@link emitObservabilityEvent} helper used throughout the library.
 *
 * @module
 */

import { CapnpError, type ErrorMetadata } from "../errors.ts";

/**
 * A single attribute value in an observability event.
 * Supports string, number, boolean, and bigint for Cap'n Proto interface IDs.
 */
export type RpcObservabilityAttributeValue = string | number | boolean | bigint;

/**
 * A record of key-value attributes attached to an observability event.
 */
export type RpcObservabilityAttributes = Record<
  string,
  RpcObservabilityAttributeValue
>;

/**
 * Represents a single observability event emitted by the capnp-deno runtime.
 *
 * Events are emitted at significant points in the RPC lifecycle (session start,
 * frame processing, errors, transport operations) and can be consumed by any
 * {@link RpcObservability} implementation for logging, metrics, or tracing.
 */
export interface RpcObservabilityEvent {
  /** The dot-separated event name, e.g. "rpc.session.start" or "rpc.transport.tcp.error". */
  name: string;
  /** Optional key-value attributes providing additional context for the event. */
  attributes?: RpcObservabilityAttributes;
  /** Optional duration in milliseconds for timed operations. */
  durationMs?: number;
  /** Optional error associated with this event, present for error events. */
  error?: unknown;
}

/**
 * Hook interface for receiving observability events from the capnp-deno runtime.
 *
 * Provide an implementation of this interface to capture metrics, traces, and
 * structured logs from RPC sessions, transports, and the WASM ABI layer.
 *
 * @example
 * ```ts
 * const observability: RpcObservability = {
 *   onEvent(event) {
 *     console.log(`[${event.name}]`, event.attributes);
 *   },
 * };
 * const session = new RpcSession(peer, transport, { observability });
 * ```
 */
export interface RpcObservability {
  /**
   * Called when an observability event is emitted.
   *
   * Implementations must not throw -- any error thrown by this callback is
   * silently swallowed to prevent observability failures from affecting
   * runtime behavior.
   *
   * @param event - The observability event.
   */
  onEvent?: (event: RpcObservabilityEvent) => void;
}

const ERROR_METADATA_ATTRIBUTE_NAMES: Record<keyof ErrorMetadata, string> = {
  phase: "rpc.phase",
  errorType: "rpc.error_type",
  frameBytes: "rpc.frame_bytes",
  messageTag: "rpc.message_tag",
  messageName: "rpc.message_name",
  questionId: "rpc.question_id",
  answerId: "rpc.answer_id",
  interfaceId: "rpc.interface_id",
  methodId: "rpc.method_id",
  capabilityIndex: "rpc.capability_id",
  interfaceName: "rpc.interface_name",
  methodName: "rpc.method_name",
  serviceName: "rpc.service_name",
  transport: "rpc.transport",
  peerId: "rpc.peer_id",
};

function metadataAttributes(
  metadata: ErrorMetadata | undefined,
): RpcObservabilityAttributes {
  const out: RpcObservabilityAttributes = {};
  if (!metadata) return out;
  for (
    const [key, attributeName] of Object.entries(
      ERROR_METADATA_ATTRIBUTE_NAMES,
    ) as Array<[keyof ErrorMetadata, string]>
  ) {
    const value = metadata[key];
    if (value !== undefined) {
      out[attributeName] = value;
    }
  }
  return out;
}

/**
 * Safely emits an observability event, swallowing any errors thrown by the
 * observer to ensure observability failures never affect runtime behavior.
 *
 * @param observability - The observability hook, or undefined if none is configured.
 * @param event - The event to emit.
 * @returns void -- observer errors are swallowed, never rethrown.
 * @example
 * ```ts
 * emitObservabilityEvent(observability, {
 *   name: "rpc.transport.tcp.error",
 *   attributes: { "rpc.transport": "tcp" },
 *   error,
 * });
 * ```
 */
export function emitObservabilityEvent(
  observability: RpcObservability | undefined,
  event: RpcObservabilityEvent,
): void {
  if (!observability?.onEvent) return;
  try {
    const attributes = event.error instanceof CapnpError
      ? {
        ...metadataAttributes(event.error.metadata),
        ...(event.attributes ?? {}),
      }
      : event.attributes;
    observability.onEvent({ ...event, attributes });
  } catch {
    // Never allow observability failures to affect runtime behavior.
  }
}

/**
 * Extracts a human-readable error type string from an unknown error value.
 *
 * Returns `Error.name` for Error instances, or `typeof` for other values.
 *
 * @param error - The error value to inspect.
 * @returns A string describing the error type.
 */
export function getErrorType(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) return error.name;
  return typeof error;
}
