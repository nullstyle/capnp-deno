// Regression tests for StreamSender re-entrancy and send/cancel atomicity.
//
// Finding 1: the drain lock must not be held across user onResponse/onError
// callbacks, otherwise send()/flush()/waitForCapacity()/cancel() awaited from
// inside a callback deadlocks on the drain that invoked the callback.
//
// Finding 2: send()'s capacity check and window push must share one
// synchronous segment, otherwise unawaited concurrent sends overshoot
// maxInFlight and a same-task cancel() can strand an accepted call.
//
// Every await here is wrapped in withTimeout so a regression fails fast
// instead of hanging the suite.

import {
  createStreamSender,
  type StreamCallFn,
} from "../../src/rpc/session/streaming.ts";
import { assert, assertEquals, withTimeout } from "../test_utils.ts";

const REENTRANCY_TIMEOUT_MS = 2_000;

Deno.test("StreamSender send() from inside onResponse with a full window completes", async () => {
  const received: number[] = [];
  const callFn: StreamCallFn = async (_params) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return new Uint8Array([1]);
  };

  const sender = createStreamSender(callFn, {
    maxInFlight: 2,
    onResponse: async (_response, index) => {
      received.push(index);
      if (index === 0) {
        // First send fills the window back to maxInFlight; the second one
        // must drain re-entrantly to find a slot.
        await sender.send(new Uint8Array([2]));
        await sender.send(new Uint8Array([3]));
      }
    },
  });

  await withTimeout(sender.send(new Uint8Array([0])), REENTRANCY_TIMEOUT_MS);
  await withTimeout(sender.send(new Uint8Array([1])), REENTRANCY_TIMEOUT_MS);
  await withTimeout(
    sender.flush(),
    REENTRANCY_TIMEOUT_MS,
    "flush with re-entrant send in onResponse",
  );

  assertEquals(received.join(","), "0,1,2,3");
  assertEquals(sender.totalSent, 4);
  assertEquals(sender.totalReceived, 4);
  assertEquals(sender.inFlight, 0);
  assertEquals(sender.state, "open");
});

Deno.test("StreamSender flush() from inside onResponse completes", async () => {
  const received: number[] = [];
  const callFn: StreamCallFn = async (_params) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return new Uint8Array([1]);
  };

  const sender = createStreamSender(callFn, {
    maxInFlight: 2,
    onResponse: async (_response, index) => {
      received.push(index);
      if (index === 0) {
        await sender.flush();
      }
    },
  });

  await withTimeout(sender.send(new Uint8Array([0])), REENTRANCY_TIMEOUT_MS);
  await withTimeout(sender.send(new Uint8Array([1])), REENTRANCY_TIMEOUT_MS);
  await withTimeout(
    sender.flush(),
    REENTRANCY_TIMEOUT_MS,
    "flush with re-entrant flush in onResponse",
  );

  assertEquals(received.join(","), "0,1");
  assertEquals(sender.totalReceived, 2);
  assertEquals(sender.inFlight, 0);
  assertEquals(sender.state, "open");
});

Deno.test("StreamSender awaited cancel() from inside onResponse completes", async () => {
  const errors: number[] = [];
  const callFn: StreamCallFn = (_params, context) => {
    if (context.index === 0) {
      return Promise.resolve(new Uint8Array([0]));
    }
    return new Promise<Uint8Array>((_resolve, reject) => {
      context.signal.addEventListener("abort", () => {
        reject(context.signal.reason);
      }, { once: true });
    });
  };

  let cancelCompleted = false;
  const sender = createStreamSender(callFn, {
    maxInFlight: 2,
    onResponse: async (_response, index) => {
      if (index === 0) {
        await sender.cancel("stop from onResponse");
        cancelCompleted = true;
      }
    },
    onError: (_error, index) => {
      errors.push(index);
    },
  });

  await withTimeout(sender.send(new Uint8Array([0])), REENTRANCY_TIMEOUT_MS);
  await withTimeout(sender.send(new Uint8Array([1])), REENTRANCY_TIMEOUT_MS);
  await withTimeout(
    sender.flush(),
    REENTRANCY_TIMEOUT_MS,
    "flush with re-entrant cancel in onResponse",
  );

  assertEquals(cancelCompleted, true);
  assertEquals(errors.join(","), "1");
  assertEquals(sender.inFlight, 0);
  assertEquals(sender.totalReceived, 2);
  assertEquals(sender.state, "canceled");
});

Deno.test("StreamSender caps unawaited concurrent sends at maxInFlight", async () => {
  let concurrent = 0;
  let peakConcurrent = 0;
  let calls = 0;

  const callFn: StreamCallFn = async (_params) => {
    calls++;
    concurrent++;
    if (concurrent > peakConcurrent) peakConcurrent = concurrent;
    await new Promise((resolve) => setTimeout(resolve, 2));
    concurrent--;
    return new Uint8Array([1]);
  };

  const sender = createStreamSender(callFn, { maxInFlight: 1 });

  const sends: Promise<void>[] = [];
  for (let i = 0; i < 5; i++) {
    sends.push(sender.send(new Uint8Array([i])));
  }

  await withTimeout(
    Promise.all(sends),
    REENTRANCY_TIMEOUT_MS,
    "unawaited concurrent sends",
  );
  await withTimeout(sender.flush(), REENTRANCY_TIMEOUT_MS, "flush");

  assertEquals(calls, 5);
  assertEquals(
    peakConcurrent,
    1,
    `peak concurrent callFn invocations was ${peakConcurrent}, expected 1`,
  );
  assertEquals(sender.totalSent, 5);
  assertEquals(sender.totalReceived, 5);
  assertEquals(sender.inFlight, 0);
  assertEquals(sender.state, "open");
});

Deno.test("StreamSender cancel() in the same task as send() leaves no stranded call", async () => {
  let started = 0;
  let sawAbort = false;
  const errors: number[] = [];

  const sender = createStreamSender<Uint8Array, Uint8Array>(
    (_params, context) => {
      started++;
      return new Promise<Uint8Array>((_resolve, reject) => {
        if (context.signal.aborted) {
          sawAbort = true;
          reject(context.signal.reason);
          return;
        }
        context.signal.addEventListener("abort", () => {
          sawAbort = true;
          reject(context.signal.reason);
        }, { once: true });
      });
    },
    {
      maxInFlight: 2,
      onError: (_error, index) => {
        errors.push(index);
      },
    },
  );

  // No await between the two calls: send() is issued strictly before
  // cancel() in the same task, so it must be accepted first and then
  // canceled — never accepted after the cancel sweep.
  const sendPromise = sender.send(new Uint8Array([1]));
  const cancelPromise = sender.cancel("stop");

  await withTimeout(
    sendPromise,
    REENTRANCY_TIMEOUT_MS,
    "send issued before same-task cancel",
  );
  await withTimeout(cancelPromise, REENTRANCY_TIMEOUT_MS, "same-task cancel");

  assertEquals(started, 1);
  assert(sawAbort, "expected the accepted call to observe the cancel abort");
  assertEquals(errors.join(","), "0");
  assertEquals(sender.inFlight, 0);
  assertEquals(sender.totalSent, 1);
  assertEquals(sender.totalReceived, 1);
  assertEquals(sender.state, "canceled");

  let thrown: unknown;
  try {
    await sender.send(new Uint8Array([2]));
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof Error && /stream canceled/i.test(thrown.message),
    `expected post-cancel send rejection, got ${String(thrown)}`,
  );
});
