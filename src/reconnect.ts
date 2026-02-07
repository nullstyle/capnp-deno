import { TransportError } from "./errors.ts";

export interface ReconnectPolicyContext {
  attempt: number;
  elapsedMs: number;
  error: unknown;
}

export interface ReconnectRetryInfo extends ReconnectPolicyContext {
  delayMs: number;
}

export interface ReconnectPolicy {
  shouldRetry(context: ReconnectPolicyContext): boolean;
  nextDelayMs(context: ReconnectPolicyContext): number;
}

export interface ExponentialBackoffReconnectPolicyOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitterRatio?: number;
  maxElapsedMs?: number;
  random?: () => number;
}

export interface ConnectWithReconnectOptions {
  policy: ReconnectPolicy;
  signal?: AbortSignal;
  onRetry?: (info: ReconnectRetryInfo) => void | Promise<void>;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TransportError(
      `${name} must be a non-negative integer, got ${value}`,
    );
  }
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TransportError(
      `${name} must be a non-negative finite number, got ${value}`,
    );
  }
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TransportError(
      `${name} must be a positive finite number, got ${value}`,
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new TransportError("reconnect aborted");
  }
}

async function defaultSleep(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (delayMs <= 0) return;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new TransportError("reconnect aborted"));
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function createExponentialBackoffReconnectPolicy(
  options: ExponentialBackoffReconnectPolicyOptions = {},
): ReconnectPolicy {
  const maxAttempts = options.maxAttempts ?? 5;
  const initialDelayMs = options.initialDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const factor = options.factor ?? 2;
  const jitterRatio = options.jitterRatio ?? 0.2;
  const maxElapsedMs = options.maxElapsedMs;
  const random = options.random ?? Math.random;

  assertNonNegativeInteger(maxAttempts, "maxAttempts");
  assertNonNegativeFinite(initialDelayMs, "initialDelayMs");
  assertPositiveFinite(maxDelayMs, "maxDelayMs");
  assertPositiveFinite(factor, "factor");
  if (factor < 1) {
    throw new TransportError(`factor must be >= 1, got ${factor}`);
  }
  assertNonNegativeFinite(jitterRatio, "jitterRatio");
  if (jitterRatio > 1) {
    throw new TransportError(`jitterRatio must be <= 1, got ${jitterRatio}`);
  }
  if (initialDelayMs > maxDelayMs) {
    throw new TransportError(
      `initialDelayMs ${initialDelayMs} exceeds maxDelayMs ${maxDelayMs}`,
    );
  }
  if (maxElapsedMs !== undefined) {
    assertNonNegativeInteger(maxElapsedMs, "maxElapsedMs");
  }

  return {
    shouldRetry(context): boolean {
      assertNonNegativeInteger(context.attempt, "context.attempt");
      assertNonNegativeInteger(context.elapsedMs, "context.elapsedMs");
      if (context.attempt > maxAttempts) {
        return false;
      }
      if (maxElapsedMs !== undefined && context.elapsedMs > maxElapsedMs) {
        return false;
      }
      return true;
    },

    nextDelayMs(context): number {
      assertNonNegativeInteger(context.attempt, "context.attempt");
      const exponent = Math.max(0, context.attempt - 1);
      let delay = initialDelayMs * Math.pow(factor, exponent);
      if (!Number.isFinite(delay)) {
        delay = maxDelayMs;
      }
      delay = Math.min(delay, maxDelayMs);

      if (jitterRatio === 0 || delay === 0) {
        return Math.round(delay);
      }

      const randomValue = random();
      if (
        !Number.isFinite(randomValue) ||
        randomValue < 0 ||
        randomValue >= 1
      ) {
        throw new TransportError(
          `random() must return a value in [0, 1), got ${randomValue}`,
        );
      }

      const jitter = delay * jitterRatio;
      const minDelay = delay - jitter;
      const maxDelay = delay + jitter;
      const jittered = minDelay + ((maxDelay - minDelay) * randomValue);
      return Math.max(0, Math.round(jittered));
    },
  };
}

export async function connectWithReconnect<T>(
  connect: () => Promise<T>,
  options: ConnectWithReconnectOptions,
): Promise<T> {
  if (!options.policy) {
    throw new TransportError(
      "connectWithReconnect requires a reconnect policy",
    );
  }

  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  let attempt = 0;

  while (true) {
    throwIfAborted(options.signal);

    try {
      return await connect();
    } catch (error) {
      attempt += 1;
      const elapsedMs = Math.max(0, now() - startedAtMs);
      const context: ReconnectPolicyContext = {
        attempt,
        elapsedMs,
        error,
      };

      if (!options.policy.shouldRetry(context)) {
        throw error;
      }

      const rawDelayMs = options.policy.nextDelayMs(context);
      assertNonNegativeFinite(rawDelayMs, "reconnect delay");
      const delayMs = Math.round(rawDelayMs);

      if (options.onRetry) {
        await options.onRetry({
          ...context,
          delayMs,
        });
      }

      await sleep(delayMs, options.signal);
    }
  }
}
