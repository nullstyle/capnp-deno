# Streaming RPC

Generated Cap'n Proto methods declared as `-> stream` use regular RPC
Call/Return messages with client-side flow control. They are application-level
RPC streams, not raw TCP/WebSocket/WebTransport byte streams.

## Sender Backpressure

Generated helpers such as `createCounterSinkAddStreamSender(...)` return a
`StreamSender`. The sender accepts up to `maxInFlight` calls at a time. Once the
window is full, `send()` waits for the oldest accepted call to complete before
starting another call.

```ts
const sender = createCounterSinkAddStreamSender(counter, {
  maxInFlight: 4,
});

for (const value of values) {
  await sender.send(value);
}
await sender.flush();
```

Use `waitForCapacity()` when producing the next item is expensive and should not
happen until the sender has room:

```ts
for (;;) {
  await sender.waitForCapacity();
  const next = await readNextChunk();
  if (next === null) break;
  await sender.send(next);
}
await sender.flush();
```

`waitForCapacity({ signal })` aborts only the wait. It does not cancel accepted
stream calls. Use `cancel(reason)` to abort the stream itself.

## State And Counters

`StreamSender` exposes lightweight state for tests, diagnostics, and producer
coordination:

- `state`: `open`, `draining`, `canceling`, `canceled`, or `failed`
- `maxInFlight`: configured in-flight window
- `inFlight`: accepted calls still waiting for ordered completion
- `totalSent`: calls accepted into the window
- `totalReceived`: calls drained in order

The sender drains responses in call order. A later call can complete on the wire
first, but its response callback is held until earlier calls have drained.

## Cancellation

`cancel(reason?)` aborts accepted calls, rejects future sends, and drains the
accepted calls so `inFlight` returns to zero. Server handlers receive
`RpcCallContext.signal`; generated clients pass the sender's per-call signal
through to each streaming RPC call.

```ts
const controller = new AbortController();
const sender = createCounterSinkAddStreamSender(counter, {
  maxInFlight: 2,
  signal: controller.signal,
});

await sender.send(1);
await sender.send(2);
await sender.cancel("no more values");
```

On the server, check `ctx.signal` before committing expensive work:

```ts
async add(value: number, ctx: RpcCallContext): Promise<void> {
  await waitForStorage();
  if (ctx.signal.aborted) return;
  this.total += value;
}
```

If `onError` is not provided, the first failed or canceled in-flight call is
reported by `send()`, `flush()`, or `cancel()` after cleanup. If `onError` is
provided, the sender treats handled call failures as drained progress.

## Recommended Defaults

Start with `maxInFlight: 4` for network transports. Raise it only after testing
with realistic server latency and payload sizes. A very large window can hide
backpressure and move memory pressure into the transport queues.

Use the debug tracer when diagnosing stream stalls or cancellations:

```ts
const debug = createRpcDebugTracer({ log: true });
using counter = await connect(CounterSink, transport, { debug });
```

The tracer records redacted `Call`, `Finish`, and `Return` summaries, including
early-cancellation `Finish` frames.
