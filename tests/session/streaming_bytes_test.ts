import { createStreamSender } from "../../src/rpc/session/streaming.ts";
import { assert, assertEquals, deferred, withTimeout } from "../test_utils.ts";

async function nextMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

Deno.test("stream byte window blocks mixed payloads below the call-count limit", async () => {
  const responses = [deferred<Uint8Array>(), deferred<Uint8Array>()];
  let calls = 0;
  const sender = createStreamSender(() => responses[calls++].promise, {
    maxInFlight: 8,
    maxInFlightBytes: 6,
  });
  await sender.send(new Uint8Array(4));
  let accepted = false;
  const second = sender.send(new Uint8Array(3)).then(() => accepted = true);
  await nextMicrotasks();
  assertEquals(accepted, false);
  assertEquals(calls, 1);
  assertEquals(sender.inFlightBytes, 4);
  assertEquals(sender.maxInFlightBytes, 6);
  responses[0].resolve(new Uint8Array());
  await withTimeout(second, 500, "byte admission");
  assertEquals(sender.inFlightBytes, 3);
  responses[1].resolve(new Uint8Array());
  await sender.flush();
  assertEquals(sender.inFlightBytes, 0);
});

Deno.test("stream rejects an oversized encoded item without consuming a call slot", async () => {
  const sender = createStreamSender(() => Promise.resolve(new Uint8Array()), {
    maxInFlightBytes: 4,
  });
  let error: unknown;
  try {
    await sender.send(new Uint8Array(5));
  } catch (failure) {
    error = failure;
  }
  assert(
    error instanceof Error && /exceeds maxInFlightBytes/.test(error.message),
  );
  assertEquals(sender.inFlight, 0);
  assertEquals(sender.inFlightBytes, 0);
  await sender.send(new Uint8Array(4));
  await sender.flush();
});

Deno.test("stream serializes one candidate while exact encoded bytes await admission", async () => {
  const replies = [deferred<void>(), deferred<void>(), deferred<void>()];
  const encoded: number[] = [];
  const sender = createStreamSender<number, void>(async (size, context) => {
    await context.prepare();
    encoded.push(size);
    await context.reserveBytes(size);
    await replies[context.index].promise;
  }, { maxInFlight: 4, maxInFlightBytes: 6 });
  await sender.send(4);
  const second = sender.send(3);
  const third = sender.send(5);
  await nextMicrotasks();
  assertEquals(encoded.join(","), "4,3");
  assertEquals(sender.inFlightBytes, 4);
  assertEquals(sender.pendingEncodedBytes, 3);
  replies[0].resolve();
  await withTimeout(second, 500, "second encoded admission");
  await nextMicrotasks();
  assertEquals(encoded.join(","), "4,3,5");
  assertEquals(sender.inFlightBytes, 3);
  assertEquals(sender.pendingEncodedBytes, 5);
  replies[1].resolve();
  await withTimeout(third, 500, "third encoded admission");
  replies[2].resolve();
  await sender.flush();
  assertEquals(sender.inFlightBytes, 0);
  assertEquals(sender.pendingEncodedBytes, 0);
});

Deno.test("stream cancellation releases admitted bytes and its waiting encoded candidate", async () => {
  let encoded = 0;
  const sender = createStreamSender<number, void>(async (size, context) => {
    await context.prepare();
    encoded++;
    await context.reserveBytes(size);
    await new Promise<void>((_, reject) => {
      if (context.signal.aborted) reject(context.signal.reason);
      else {context.signal.addEventListener("abort", () =>
          reject(context.signal.reason), { once: true });}
    });
  }, { maxInFlight: 4, maxInFlightBytes: 6, onError: () => {} });
  await sender.send(4);
  const second = sender.send(4).then(() => undefined, (error) => error);
  const third = sender.send(4).then(() => undefined, (error) => error);
  await nextMicrotasks();
  assertEquals(encoded, 2);
  await withTimeout(sender.cancel("done"), 500, "byte-window cancellation");
  assert(await second instanceof Error);
  assert(await third instanceof Error);
  assertEquals(sender.inFlight, 0);
  assertEquals(sender.inFlightBytes, 0);
  assertEquals(sender.pendingEncodedBytes, 0);
});

Deno.test("stream waitForCapacity respects an explicitly requested byte count", async () => {
  const reply = deferred<Uint8Array>();
  const sender = createStreamSender(() => reply.promise, {
    maxInFlight: 8,
    maxInFlightBytes: 8,
  });
  await sender.send(new Uint8Array(7));
  await sender.waitForCapacity({ byteLength: 1 });
  let available = false;
  const capacity = sender.waitForCapacity({ byteLength: 2 }).then(() =>
    available = true
  );
  await nextMicrotasks();
  assertEquals(available, false);
  reply.resolve(new Uint8Array());
  await withTimeout(capacity, 500, "byte capacity wait");
  assertEquals(sender.inFlightBytes, 0);
});

Deno.test("byte admission permits reentrant sends from ordered response callbacks", async () => {
  const first = deferred<void>();
  let calls = 0;
  const sender = createStreamSender<number, void>(async (size, context) => {
    await context.prepare();
    await context.reserveBytes(size);
    if (calls++ === 0) await first.promise;
  }, {
    maxInFlight: 4,
    maxInFlightBytes: 4,
    onResponse: async (_value, index) => {
      if (index === 0) await sender.send(4);
    },
  });
  await sender.send(4);
  const second = sender.send(4);
  first.resolve();
  await withTimeout(second, 500, "reentrant byte admission");
  await withTimeout(sender.flush(), 500, "reentrant byte flush");
  assertEquals(calls, 3);
  assertEquals(sender.inFlightBytes, 0);
  assertEquals(sender.pendingEncodedBytes, 0);
});
