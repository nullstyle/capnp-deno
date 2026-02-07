export function assert(
  condition: boolean,
  message = "assertion failed",
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function assertEquals<T>(
  actual: T,
  expected: T,
  label = "values are not equal",
): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${label}: expected=${String(expected)} actual=${String(actual)}`,
    );
  }
}

export function assertBytes(
  actual: Uint8Array,
  expected: number[],
  label = "byte arrays differ",
): void {
  if (actual.length !== expected.length) {
    throw new Error(
      `${label}: expected len=${expected.length} actual len=${actual.length}`,
    );
  }
  for (let i = 0; i < actual.length; i += 1) {
    if (actual[i] !== expected[i]) {
      throw new Error(
        `${label}: mismatch at ${i}: expected=${expected[i]} actual=${
          actual[i]
        }`,
      );
    }
  }
}

export function assertThrows(fn: () => void, pattern?: RegExp): void {
  let thrown: unknown = undefined;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  if (thrown === undefined) {
    throw new Error("expected function to throw");
  }
  if (pattern && !(thrown instanceof Error && pattern.test(thrown.message))) {
    throw new Error(
      `error message did not match ${pattern}: ${String(thrown)}`,
    );
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = "operation",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}
