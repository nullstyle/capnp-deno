import { createStreamSender, type StreamCallFn } from "../src/rpc/streaming.ts";
import { assert, assertEquals } from "./test_utils.ts";

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
