export type RpcObservabilityAttributeValue = string | number | boolean | bigint;

export type RpcObservabilityAttributes = Record<
  string,
  RpcObservabilityAttributeValue
>;

export interface RpcObservabilityEvent {
  name: string;
  attributes?: RpcObservabilityAttributes;
  durationMs?: number;
  error?: unknown;
}

export interface RpcObservability {
  onEvent?: (event: RpcObservabilityEvent) => void;
}

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

export function getErrorType(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) return error.name;
  return typeof error;
}
