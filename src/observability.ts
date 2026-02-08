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

/**
 * Safely emits an observability event, swallowing any errors thrown by the
 * observer to ensure observability failures never affect runtime behavior.
 *
 * @param observability - The observability hook, or undefined if none is configured.
 * @param event - The event to emit.
 */
export function emitObservabilityEvent(
  observability: RpcObservability | undefined,
  event: RpcObservabilityEvent,
): void {
  if (!observability?.onEvent) return;
  try {
    observability.onEvent(event);
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
