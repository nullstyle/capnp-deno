import {
  MessagePortTransport,
  MiddlewareTransport,
  type RpcTransport,
  serveConnection,
  SessionError,
  TransportError,
} from "../../src/advanced.ts";
import { Pinger } from "../../examples/ping/gen/schema_types.ts";
import { assert, assertEquals, deferred, withTimeout } from "../test_utils.ts";

class CloseObservableTransport implements RpcTransport {
  closed = false;
  onStart?: () => Promise<void>;
  readonly observers = new Set<() => void | Promise<void>>();
  readonly previousObservers: Array<() => void | Promise<void>> = [];

  start(): void | Promise<void> {
    if (this.closed) throw new TransportError("test transport closed");
    return this.onStart?.();
  }

  send(): void {
    if (this.closed) throw new TransportError("test transport closed");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const observer of [...this.observers]) void observer();
    this.observers.clear();
  }

  subscribeClose(observer: () => void | Promise<void>): () => void {
    this.previousObservers.push(observer);
    if (this.closed) void observer();
    else this.observers.add(observer);
    return () => this.observers.delete(observer);
  }
}

class DisposablePinger {
  disposeCount = 0;
  readonly disposed = deferred<void>();

  ping(): Promise<void> {
    return Promise.resolve();
  }

  [Symbol.asyncDispose](): Promise<void> {
    this.disposeCount++;
    this.disposed.resolve();
    return Promise.resolve();
  }
}

for (const wrapped of [false, true]) {
  Deno.test(`service lifetime follows ${wrapped ? "wrapped" : "custom"} transport closure`, async () => {
    const inner = new CloseObservableTransport();
    const transport = wrapped ? new MiddlewareTransport(inner, []) : inner;
    const server = new DisposablePinger();
    const handle = await serveConnection(
      Pinger,
      { transport, id: "service-lifecycle" },
      () => server,
    );
    try {
      inner.close();
      await withTimeout(
        server.disposed.promise,
        500,
        "automatic service disposal",
      );
      assertEquals(handle.closed, true);
      assertEquals(handle.runtime.closed, true);
      assertEquals(server.disposeCount, 1);
      assertEquals(inner.observers.size, 0);
      // A notification queued before unsubscribe may still arrive afterward.
      for (const observer of inner.previousObservers) await observer();
      await handle.close();
      assertEquals(server.disposeCount, 1);
    } finally {
      await handle.close();
    }
  });
}

Deno.test("service explicit close removes all transport subscriptions", async () => {
  const transport = new CloseObservableTransport();
  const server = new DisposablePinger();
  const handle = await serveConnection(Pinger, { transport }, () => server);
  assert(transport.observers.size > 0);
  await handle.close();
  await handle.close();
  assertEquals(transport.observers.size, 0);
  assertEquals(server.disposeCount, 1);
});

for (const alreadyClosed of [false, true]) {
  Deno.test(`service rejects transport closure ${alreadyClosed ? "before" : "during"} factory initialization`, async () => {
    const transport = new CloseObservableTransport();
    const server = new DisposablePinger();
    const factoryStarted = deferred<void>();
    const releaseFactory = deferred<void>();
    if (alreadyClosed) transport.close();
    const pending = serveConnection(Pinger, { transport }, async () => {
      factoryStarted.resolve();
      await releaseFactory.promise;
      return server;
    });
    const outcome = pending.then(
      (handle) => ({ handle, error: undefined }),
      (error: unknown) => ({ handle: undefined, error }),
    );
    if (!alreadyClosed) {
      await factoryStarted.promise;
      transport.close();
    }
    releaseFactory.resolve();
    const result = await withTimeout(outcome, 500, "closed factory rejection");
    try {
      assert(result.error instanceof SessionError);
      assert(/closed during initialization/i.test(result.error.message));
      assertEquals(transport.observers.size, 0);
      // A resolved factory result must never outlive failed initialization.
      assertEquals(server.disposeCount, 1);
    } finally {
      await result.handle?.close();
    }
  });
}

Deno.test("service removes transport subscriptions after factory failure", async () => {
  const transport = new CloseObservableTransport();
  const failure = new Error("factory rejected");
  let thrown: unknown;
  try {
    await serveConnection(Pinger, { transport }, () => Promise.reject(failure));
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof Error && /factory rejected/.test(thrown.message));
  assertEquals(transport.closed, true);
  assertEquals(transport.observers.size, 0);
});

Deno.test("service observes local MessagePort transport closure", async () => {
  const channel = new MessageChannel();
  const transport = new MessagePortTransport(channel.port1, {
    closePortOnClose: true,
  });
  const server = new DisposablePinger();
  const handle = await serveConnection(Pinger, { transport }, () => server);
  try {
    await transport.close();
    await withTimeout(
      server.disposed.promise,
      500,
      "MessagePort service disposal",
    );
    assertEquals(handle.closed, true);
    assertEquals(handle.runtime.closed, true);
    assertEquals(server.disposeCount, 1);
  } finally {
    await handle.close();
    channel.port1.close();
    channel.port2.close();
  }
});

Deno.test("service rejects closure while the real runtime is starting", async () => {
  const transport = new CloseObservableTransport();
  const started = deferred<void>();
  const releaseStart = deferred<void>();
  transport.onStart = () => {
    started.resolve();
    return releaseStart.promise;
  };
  const server = new DisposablePinger();
  const pending = serveConnection(Pinger, { transport }, () => server);
  const outcome = pending.then(
    (handle) => ({ handle, error: undefined }),
    (error: unknown) => ({ handle: undefined, error }),
  );
  await withTimeout(started.promise, 500, "runtime starting");
  transport.close();
  releaseStart.resolve();
  const result = await withTimeout(outcome, 500, "runtime startup rejection");
  try {
    assert(result.error instanceof SessionError);
    assert(/closed during initialization/i.test(result.error.message));
    assertEquals(server.disposeCount, 1);
    assertEquals(transport.observers.size, 0);
  } finally {
    await result.handle?.close();
  }
});
