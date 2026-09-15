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
  maxInFlightBytes: 256 * 1024,
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

### Exact encoded byte admission

`maxInFlightBytes` limits admitted **parameter-message bytes**, including their
Cap'n Proto segment table. It excludes RPC envelopes, capability descriptors,
transport queues, and caller-owned input objects. The default is unlimited.
Generated helpers encode each item once and reserve its exact length before the
transport can assign a question. A single item larger than the budget is
rejected without sending it. Callback capabilities exported during a rejected
preparation are rolled back locally.

Preparation is serialized: at most one encoded candidate waits outside the
admitted budget, while the count window bounds pending calls. Thus this is not a
whole-heap limit. `pendingEncodedBytes` reports that candidate separately. Avoid
unbounded concurrent `send()` calls retaining producer-owned objects; await
sends or use `waitForCapacity({ byteLength: knownEncodedSize })` before
expensive work. With no size given, a capacity wait checks for at least one
available byte.

For raw `Uint8Array` calls, the sender uses `params.byteLength`. A custom typed
call function using a byte limit must call `context.prepare()` before encoding,
then `await context.reserveBytes(encoded.byteLength)` before sending. Generated
helpers provide that contract automatically; custom call functions remain
responsible for obeying it and their abort signal.

The byte charge remains until ordered response processing retires the call.
Server acknowledgments follow handler completion. A regular generated method
waits for previously accepted streaming work on the same interface; it does not
wait for items still blocked in a producer's sender before reaching the server.

## State And Counters

`StreamSender` exposes lightweight state for tests, diagnostics, and producer
coordination:

- `state`: `open`, `draining`, `canceling`, `canceled`, or `failed`
- `maxInFlight`: configured in-flight window
- `inFlight`: calls being prepared or waiting for ordered completion
- `maxInFlightBytes`: configured parameter-message byte budget, or `null`
- `inFlightBytes`: admitted parameter-message bytes awaiting ordered completion
- `pendingEncodedBytes`: the single candidate waiting for byte admission
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

## Server input budget

Configure `runtime.bridgeOptions.maxRetainedInputFrameBytes` on `serve()` or
`serveConnection()` to bound incoming Call-frame bytes held by unfinished
dispatches. Direct `RpcServerBridge` construction accepts the same option. This
separate budget counts the full incoming frame, including its RPC envelope; it
is not the sender's parameter-message budget. The default is unlimited.

Excess calls receive an exception before a dispatch is registered. Finish,
Release, and other control frames continue to run. Bridge stats expose
`retainedInputFrameBytes`, `maxRetainedInputFrameBytes`, and
`rejectedInputFrames`. A Finish or shutdown aborts handlers, but its byte charge
remains until the handler actually returns: cancellation cannot force
application code to release objects it keeps. Runtime shutdown closes its bridge
and drops exported services.

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
