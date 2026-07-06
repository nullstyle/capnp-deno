import {
  createStreamSender,
  type StreamCallFn,
  type StreamSendContext,
} from "../../src/rpc/session/streaming.ts";
import { assert, assertEquals, deferred, withTimeout } from "../test_utils.ts";

function makeCallFn(
  responses: Uint8Array[] | ((index: number) => Uint8Array),
  options?: { delayMs?: number; failAt?: Set<number> },
): { callFn: StreamCallFn; callCount: () => number } {
  let count = 0;
  const callFn: StreamCallFn = async (_params) => {
    const idx = count++;
    if (options?.delayMs) {
      await new Promise((r) => setTimeout(r, options.delayMs));
    }
    if (options?.failAt?.has(idx)) {
      throw new Error(`call ${idx} failed`);
    }
    return typeof responses === "function"
      ? responses(idx)
      : responses[idx % responses.length];
  };
  return { callFn, callCount: () => count };
}

Deno.test("StreamSender sends and flushes correctly", async () => {
  const response = new Uint8Array([0x42]);
  const { callFn, callCount } = makeCallFn([response]);
  const received: number[] = [];

  const sender = createStreamSender(callFn, {
    maxInFlight: 4,
    onResponse: (_resp, index) => {
      received.push(index);
    },
  });

  for (let i = 0; i < 10; i++) {
    await sender.send(new Uint8Array([i]));
  }
  await sender.flush();

  assertEquals(callCount(), 10);
  assertEquals(sender.totalSent, 10);
  assertEquals(sender.totalReceived, 10);
  assertEquals(sender.inFlight, 0);
  assertEquals(
    JSON.stringify(received),
    JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
  );
  assertEquals(sender.state, "open");
  assertEquals(sender.maxInFlight, 4);
});

Deno.test("StreamSender enforces maxInFlight window", async () => {
  let maxConcurrent = 0;
  let concurrent = 0;
  const response = new Uint8Array([1]);

  const callFn: StreamCallFn = async (_params) => {
    concurrent++;
    if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    await new Promise((r) => setTimeout(r, 10));
    concurrent--;
    return response;
  };

  const sender = createStreamSender(callFn, { maxInFlight: 3 });

  for (let i = 0; i < 12; i++) {
    await sender.send(new Uint8Array([i]));
  }
  await sender.flush();

  assertEquals(sender.totalSent, 12);
  assertEquals(sender.totalReceived, 12);
  assert(
    maxConcurrent <= 3,
    `max concurrent was ${maxConcurrent}, expected <= 3`,
  );
});

Deno.test("StreamSender propagates errors on flush when no onError", async () => {
  const { callFn } = makeCallFn(
    [new Uint8Array([1])],
    { failAt: new Set([3]) },
  );

  const sender = createStreamSender(callFn, { maxInFlight: 2 });

  for (let i = 0; i < 6; i++) {
    try {
      await sender.send(new Uint8Array([i]));
    } catch {
      break;
    }
  }

  let thrown = false;
  try {
    await sender.flush();
  } catch (error) {
    thrown = true;
    assert(error instanceof Error);
    assert(error.message.includes("call 3 failed"));
  }
  assert(thrown, "expected error to propagate on flush");
});

Deno.test("StreamSender calls onError for failed calls", async () => {
  const { callFn } = makeCallFn(
    [new Uint8Array([1])],
    { failAt: new Set([2]) },
  );

  const errors: Array<{ error: unknown; index: number }> = [];
  const sender = createStreamSender(callFn, {
    maxInFlight: 8,
    onError: (error, index) => {
      errors.push({ error, index });
    },
  });

  for (let i = 0; i < 5; i++) {
    await sender.send(new Uint8Array([i]));
  }
  await sender.flush();

  assertEquals(errors.length, 1);
  assertEquals(errors[0].index, 2);
  assert(errors[0].error instanceof Error);
  assertEquals(sender.totalSent, 5);
  assertEquals(sender.totalReceived, 5);
});

Deno.test("StreamSender records callback failures once and enters failed state", async () => {
  const sender = createStreamSender(
    () => Promise.resolve(new Uint8Array([1])),
    {
      maxInFlight: 1,
      onResponse: () => {
        throw new Error("progress callback failed");
      },
    },
  );

  await sender.send(new Uint8Array([1]));

  let thrown: unknown;
  try {
    await sender.flush();
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof Error && thrown.message === "progress callback failed",
    `expected callback failure, got ${String(thrown)}`,
  );
  assertEquals(sender.totalReceived, 1);
  assertEquals(sender.inFlight, 0);
  assertEquals(sender.state, "failed");
});

Deno.test("StreamSender waitForCapacity resolves after ordered drain", async () => {
  const first = deferred<Uint8Array>();
  const second = deferred<Uint8Array>();
  const responses = [first, second];
  const received: number[] = [];

  const sender = createStreamSender<Uint8Array, Uint8Array>(
    (_params, context) => responses[context.index].promise,
    {
      maxInFlight: 2,
      onResponse: (_response, index) => {
        received.push(index);
      },
    },
  );

  await sender.send(new Uint8Array([1]));
  await sender.send(new Uint8Array([2]));
  assertEquals(sender.inFlight, 2);
  assertEquals(sender.totalSent, 2);

  let capacityResolved = false;
  const capacity = sender.waitForCapacity().then(() => {
    capacityResolved = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(capacityResolved, false);
  assertEquals(sender.inFlight, 2);
  assertEquals(sender.state, "draining");

  first.resolve(new Uint8Array([1]));
  await withTimeout(capacity, 1_000, "wait for stream capacity");

  assertEquals(capacityResolved, true);
  assertEquals(sender.inFlight, 1);
  assertEquals(received.join(","), "0");

  second.resolve(new Uint8Array([2]));
  await sender.flush();
  assertEquals(received.join(","), "0,1");
  assertEquals(sender.state, "open");
});

Deno.test("StreamSender waitForCapacity abort does not free window capacity", async () => {
  const ac = new AbortController();
  const callAbort = deferred<unknown>();

  const sender = createStreamSender<Uint8Array, Uint8Array>(
    (_params, context) =>
      new Promise<Uint8Array>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => {
          callAbort.resolve(context.signal.reason);
          reject(context.signal.reason);
        }, { once: true });
      }),
    {
      maxInFlight: 1,
      onError: () => {},
    },
  );

  await sender.send(new Uint8Array([1]));
  assertEquals(sender.inFlight, 1);

  const waiting = sender.waitForCapacity({ signal: ac.signal });
  ac.abort(new Error("producer stopped waiting"));

  let thrown: unknown;
  try {
    await waiting;
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof Error && thrown.message === "producer stopped waiting",
    `expected producer abort reason, got ${String(thrown)}`,
  );
  assertEquals(sender.inFlight, 1);
  assertEquals(sender.state, "open");

  await sender.cancel("cleanup");
  assertEquals(await callAbort.promise, "cleanup");
  assertEquals(sender.inFlight, 0);
  assertEquals(sender.state, "canceled");
});

Deno.test("StreamSender rejects invalid maxInFlight", () => {
  let thrown = false;
  try {
    createStreamSender(() => Promise.resolve(new Uint8Array()), {
      maxInFlight: 0,
    });
  } catch (error) {
    thrown = true;
    assert(error instanceof Error);
    assert(error.message.includes("maxInFlight"));
  }
  assert(thrown);
});

Deno.test({
  name: "StreamSender respects abort signal",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const ac = new AbortController();
  const { callFn } = makeCallFn([new Uint8Array([1])], { delayMs: 100 });

  const sender = createStreamSender(callFn, {
    maxInFlight: 2,
    signal: ac.signal,
  });

  await sender.send(new Uint8Array([1]));
  ac.abort();

  let thrown = false;
  try {
    await sender.send(new Uint8Array([2]));
  } catch (error) {
    thrown = true;
    assert(error instanceof Error);
    assert(error.message.includes("aborted"));
  }
  assert(thrown, "expected abort error");
});

Deno.test("StreamSender with maxInFlight=1 processes sequentially", async () => {
  const order: number[] = [];
  let idx = 0;

  const callFn: StreamCallFn = async (_params) => {
    const myIdx = idx++;
    await new Promise((r) => setTimeout(r, 5));
    order.push(myIdx);
    return new Uint8Array([myIdx]);
  };

  const sender = createStreamSender(callFn, { maxInFlight: 1 });

  for (let i = 0; i < 5; i++) {
    await sender.send(new Uint8Array([i]));
  }
  await sender.flush();

  assertEquals(JSON.stringify(order), JSON.stringify([0, 1, 2, 3, 4]));
  assertEquals(sender.totalSent, 5);
  assertEquals(sender.totalReceived, 5);
});

Deno.test("StreamSender supports typed params/results and per-send context", async () => {
  interface Chunk {
    value: number;
  }

  const contexts: StreamSendContext[] = [];
  const responses: string[] = [];
  const sender = createStreamSender<Chunk, string>(
    (chunk, context) => {
      contexts.push(context);
      return Promise.resolve(`chunk-${context.index}-${chunk.value}`);
    },
    {
      maxInFlight: 2,
      onResponse: (response) => {
        responses.push(response);
      },
    },
  );

  await sender.send({ value: 7 });
  await sender.send({ value: 9 });
  await sender.flush();

  assertEquals(responses.join(","), "chunk-0-7,chunk-1-9");
  assertEquals(contexts.length, 2);
  assertEquals(contexts[0].index, 0);
  assertEquals(contexts[1].index, 1);
  assertEquals(contexts[0].signal.aborted, false);
  assertEquals(sender.inFlight, 0);
});

Deno.test("StreamSender cancel aborts in-flight calls and rejects future sends", async () => {
  const started = deferred<void>();
  const errors: Array<{ error: unknown; index: number }> = [];
  let aborted = false;

  const sender = createStreamSender<Uint8Array, Uint8Array>(
    (_params, context) =>
      new Promise<Uint8Array>((resolve, reject) => {
        started.resolve();
        context.signal.addEventListener("abort", () => {
          aborted = true;
          reject(context.signal.reason);
        }, { once: true });
        context.signal.throwIfAborted?.();
        void resolve;
      }),
    {
      onError: (error, index) => {
        errors.push({ error, index });
      },
    },
  );

  await sender.send(new Uint8Array([1]));
  await started.promise;
  await sender.cancel("stop streaming");

  assertEquals(aborted, true);
  assertEquals(sender.inFlight, 0);
  assertEquals(sender.totalSent, 1);
  assertEquals(sender.totalReceived, 1);
  assertEquals(errors.length, 1);
  assertEquals(errors[0].index, 0);

  let thrown: unknown;
  try {
    await sender.send(new Uint8Array([2]));
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof Error && /stream canceled/i.test(thrown.message),
    `expected stream canceled error, got: ${String(thrown)}`,
  );
});

Deno.test("StreamSender cancel rejects a send blocked on backpressure", async () => {
  const firstStarted = deferred<void>();
  let callCount = 0;
  const errors: Array<{ error: unknown; index: number }> = [];

  const sender = createStreamSender<Uint8Array, Uint8Array>(
    (_params, context) => {
      callCount++;
      if (context.index === 0) {
        firstStarted.resolve();
      }
      return new Promise<Uint8Array>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => {
          reject(context.signal.reason);
        }, { once: true });
      });
    },
    {
      maxInFlight: 1,
      onError: (error, index) => {
        errors.push({ error, index });
      },
    },
  );

  await sender.send(new Uint8Array([1]));
  await firstStarted.promise;

  const blockedSend = sender.send(new Uint8Array([2]));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(callCount, 1);
  assertEquals(sender.inFlight, 1);
  assertEquals(sender.state, "draining");

  await sender.cancel("stop while blocked");

  let thrown: unknown;
  try {
    await blockedSend;
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof Error && /stream canceled/i.test(thrown.message),
    `expected blocked send cancellation, got ${String(thrown)}`,
  );
  assertEquals(callCount, 1);
  assertEquals(sender.inFlight, 0);
  assertEquals(sender.state, "canceled");
  assertEquals(errors.length, 1);
  assertEquals(errors[0].index, 0);
});

Deno.test("StreamSender cancel without onError rejects after clearing in-flight calls", async () => {
  const started = deferred<void>();
  let aborted = false;

  const sender = createStreamSender<Uint8Array, Uint8Array>(
    (_params, context) =>
      new Promise<Uint8Array>((resolve, reject) => {
        started.resolve();
        context.signal.addEventListener("abort", () => {
          aborted = true;
          reject(context.signal.reason);
        }, { once: true });
        void resolve;
      }),
  );

  await sender.send(new Uint8Array([1]));
  await started.promise;

  let thrown: unknown;
  try {
    await sender.cancel("cancel without handler");
  } catch (error) {
    thrown = error;
  }

  assertEquals(aborted, true);
  assertEquals(sender.inFlight, 0);
  assertEquals(sender.totalSent, 1);
  assertEquals(sender.totalReceived, 1);
  assertEquals(thrown, "cancel without handler");
});
