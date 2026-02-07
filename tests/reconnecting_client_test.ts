import {
  ReconnectingRpcClientTransport,
  type RpcClientTransportLike,
  SessionError,
  TransportError,
} from "../mod.ts";
import { assert, assertEquals } from "./test_utils.ts";

const EMPTY = new Uint8Array();

function reconnectOptions() {
  return {
    policy: {
      shouldRetry: (_ctx: unknown) => true,
      nextDelayMs: (_ctx: unknown) => 0,
    },
    sleep: async (_delayMs: number) => {
      // no-op for deterministic tests
    },
  };
}

Deno.test("ReconnectingRpcClientTransport retries dropped bootstrap-cap calls with rebootstrap", async () => {
  const calls: Array<{ client: number; capabilityIndex: number }> = [];
  let connectCount = 0;

  const client1: RpcClientTransportLike = {
    bootstrap: () => Promise.resolve({ capabilityIndex: 10 }),
    call: (capability) => {
      calls.push({ client: 1, capabilityIndex: capability.capabilityIndex });
      return Promise.reject(new TransportError("connection dropped"));
    },
    close: () => Promise.resolve(),
  };

  const client2: RpcClientTransportLike = {
    bootstrap: () => Promise.resolve({ capabilityIndex: 20 }),
    call: (capability) => {
      calls.push({ client: 2, capabilityIndex: capability.capabilityIndex });
      return Promise.resolve(new Uint8Array([0xaa]));
    },
    close: () => Promise.resolve(),
  };

  const transport = new ReconnectingRpcClientTransport({
    connect: () => {
      connectCount += 1;
      return Promise.resolve(connectCount === 1 ? client1 : client2);
    },
    reconnect: reconnectOptions(),
  });

  try {
    const bootstrap = await transport.bootstrap();
    assertEquals(bootstrap.capabilityIndex, 10);

    const response = await transport.call(bootstrap, 0, EMPTY);
    assertEquals(response[0], 0xaa);
    assertEquals(connectCount, 2);
    assertEquals(
      JSON.stringify(calls),
      JSON.stringify([
        { client: 1, capabilityIndex: 10 },
        { client: 2, capabilityIndex: 20 },
      ]),
    );
    assertEquals(transport.bootstrapCapability?.capabilityIndex, 20);
  } finally {
    await transport.close();
  }
});

Deno.test("ReconnectingRpcClientTransport rejects retry for non-bootstrap capability after reconnect", async () => {
  let connectCount = 0;
  const client1: RpcClientTransportLike = {
    bootstrap: () => Promise.resolve({ capabilityIndex: 10 }),
    call: () => Promise.reject(new TransportError("connection dropped")),
    close: () => Promise.resolve(),
  };
  const client2: RpcClientTransportLike = {
    bootstrap: () => Promise.resolve({ capabilityIndex: 20 }),
    call: () => Promise.resolve(new Uint8Array([0x01])),
    close: () => Promise.resolve(),
  };

  const transport = new ReconnectingRpcClientTransport({
    connect: () => {
      connectCount += 1;
      return Promise.resolve(connectCount === 1 ? client1 : client2);
    },
    reconnect: reconnectOptions(),
  });

  try {
    await transport.bootstrap();

    let thrown: unknown;
    try {
      await transport.call({ capabilityIndex: 99 }, 0, EMPTY);
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof SessionError &&
        /non-bootstrap capability/i.test(thrown.message),
      `expected non-bootstrap reconnect error, got: ${String(thrown)}`,
    );
    assertEquals(connectCount, 2);
  } finally {
    await transport.close();
  }
});

Deno.test("ReconnectingRpcClientTransport remaps non-bootstrap capability via callback", async () => {
  const calls: Array<{ client: number; capabilityIndex: number }> = [];
  const remapContexts: Array<{
    capabilityIndex: number;
    previousBootstrap: number | null;
    currentBootstrap: number | null;
    methodOrdinal: number;
    errorKind: string;
  }> = [];
  let connectCount = 0;

  const client1: RpcClientTransportLike = {
    bootstrap: () => Promise.resolve({ capabilityIndex: 10 }),
    call: (capability) => {
      calls.push({ client: 1, capabilityIndex: capability.capabilityIndex });
      return Promise.reject(new TransportError("connection dropped"));
    },
    close: () => Promise.resolve(),
  };

  const client2: RpcClientTransportLike = {
    bootstrap: () => Promise.resolve({ capabilityIndex: 20 }),
    call: (capability) => {
      calls.push({ client: 2, capabilityIndex: capability.capabilityIndex });
      if (capability.capabilityIndex !== 77) {
        return Promise.reject(new Error("expected remapped capability 77"));
      }
      return Promise.resolve(new Uint8Array([0x55]));
    },
    close: () => Promise.resolve(),
  };

  const transport = new ReconnectingRpcClientTransport({
    connect: () => {
      connectCount += 1;
      return Promise.resolve(connectCount === 1 ? client1 : client2);
    },
    reconnect: reconnectOptions(),
    remapCapabilityOnReconnect: (context) => {
      remapContexts.push({
        capabilityIndex: context.capability.capabilityIndex,
        previousBootstrap:
          context.previousBootstrapCapability?.capabilityIndex ??
            null,
        currentBootstrap: context.currentBootstrapCapability?.capabilityIndex ??
          null,
        methodOrdinal: context.methodOrdinal,
        errorKind: context.error instanceof TransportError
          ? "transport"
          : "other",
      });
      return { capabilityIndex: 77 };
    },
  });

  try {
    await transport.bootstrap();

    const response = await transport.call({ capabilityIndex: 99 }, 7, EMPTY);
    assertEquals(response[0], 0x55);
    assertEquals(connectCount, 2);
    assertEquals(
      JSON.stringify(calls),
      JSON.stringify([
        { client: 1, capabilityIndex: 99 },
        { client: 2, capabilityIndex: 77 },
      ]),
    );
    assertEquals(
      JSON.stringify(remapContexts),
      JSON.stringify([{
        capabilityIndex: 99,
        previousBootstrap: 10,
        currentBootstrap: 20,
        methodOrdinal: 7,
        errorKind: "transport",
      }]),
    );
    assertEquals(transport.bootstrapCapability?.capabilityIndex, 20);
  } finally {
    await transport.close();
  }
});

Deno.test("ReconnectingRpcClientTransport fails non-bootstrap retry when remap callback returns null", async () => {
  let connectCount = 0;

  const client1: RpcClientTransportLike = {
    bootstrap: () => Promise.resolve({ capabilityIndex: 10 }),
    call: () => Promise.reject(new TransportError("connection dropped")),
    close: () => Promise.resolve(),
  };
  const client2: RpcClientTransportLike = {
    bootstrap: () => Promise.resolve({ capabilityIndex: 20 }),
    call: () => Promise.resolve(new Uint8Array([0x01])),
    close: () => Promise.resolve(),
  };

  const transport = new ReconnectingRpcClientTransport({
    connect: () => {
      connectCount += 1;
      return Promise.resolve(connectCount === 1 ? client1 : client2);
    },
    reconnect: reconnectOptions(),
    remapCapabilityOnReconnect: () => null,
  });

  try {
    await transport.bootstrap();
    let thrown: unknown;
    try {
      await transport.call({ capabilityIndex: 99 }, 1, EMPTY);
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof SessionError &&
        /did not provide a replacement/i.test(thrown.message),
      `expected remap replacement error, got: ${String(thrown)}`,
    );
    assertEquals(connectCount, 2);
  } finally {
    await transport.close();
  }
});

Deno.test("ReconnectingRpcClientTransport does not retry in-flight calls when disabled", async () => {
  let connectCount = 0;
  const client: RpcClientTransportLike = {
    call: () => Promise.reject(new TransportError("connection dropped")),
    close: () => Promise.resolve(),
  };

  const transport = new ReconnectingRpcClientTransport({
    connect: () => {
      connectCount += 1;
      return Promise.resolve(client);
    },
    reconnect: reconnectOptions(),
    retryInFlightCalls: false,
  });

  try {
    let thrown: unknown;
    try {
      await transport.call({ capabilityIndex: 1 }, 0, EMPTY);
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof TransportError,
      `expected original transport error when retry disabled, got: ${
        String(thrown)
      }`,
    );
    assertEquals(connectCount, 1);
  } finally {
    await transport.close();
  }
});

Deno.test("ReconnectingRpcClientTransport reports finish/release failures as non-retriable", async () => {
  let connectCount = 0;
  const client1: RpcClientTransportLike = {
    finish: () => Promise.reject(new TransportError("finish failed")),
    release: () => Promise.reject(new TransportError("release failed")),
    close: () => Promise.resolve(),
    call: () => Promise.resolve(new Uint8Array([0x00])),
  };
  const client2: RpcClientTransportLike = {
    close: () => Promise.resolve(),
    call: () => Promise.resolve(new Uint8Array([0x00])),
  };

  const transport = new ReconnectingRpcClientTransport({
    connect: () => {
      connectCount += 1;
      return Promise.resolve(connectCount === 1 ? client1 : client2);
    },
    reconnect: reconnectOptions(),
  });

  try {
    let finishErr: unknown;
    try {
      await transport.finish(42);
    } catch (error) {
      finishErr = error;
    }
    assert(
      finishErr instanceof SessionError &&
        /question IDs are connection-scoped/i.test(finishErr.message),
      `expected finish reconnect semantic error, got: ${String(finishErr)}`,
    );

    // Force a fresh first client for release coverage.
    await transport.close();

    const transport2 = new ReconnectingRpcClientTransport({
      connect: () => {
        connectCount += 1;
        return Promise.resolve(connectCount === 3 ? client1 : client2);
      },
      reconnect: reconnectOptions(),
    });

    try {
      let releaseErr: unknown;
      try {
        await transport2.release({ capabilityIndex: 7 });
      } catch (error) {
        releaseErr = error;
      }
      assert(
        releaseErr instanceof SessionError &&
          /capability references are connection-scoped/i.test(
            releaseErr.message,
          ),
        `expected release reconnect semantic error, got: ${String(releaseErr)}`,
      );
    } finally {
      await transport2.close();
    }
  } finally {
    // no-op if already closed
    await transport.close();
  }
});

Deno.test("ReconnectingRpcClientTransport survives repeated reconnect churn on bootstrap capability calls", async () => {
  const closed: number[] = [];
  let connectCount = 0;

  const transport = new ReconnectingRpcClientTransport({
    connect: () => {
      connectCount += 1;
      const generation = connectCount;
      let callCount = 0;
      const failOnCall = generation === 1 ? 1 : 2;
      const client: RpcClientTransportLike = {
        bootstrap: () => Promise.resolve({ capabilityIndex: generation * 10 }),
        call: () => {
          callCount += 1;
          if (callCount === failOnCall) {
            return Promise.reject(
              new TransportError(`connection dropped (gen=${generation})`),
            );
          }
          return Promise.resolve(new Uint8Array([generation]));
        },
        close: () => {
          closed.push(generation);
          return Promise.resolve();
        },
      };
      return Promise.resolve(client);
    },
    reconnect: reconnectOptions(),
  });

  try {
    await transport.bootstrap();

    const seenGenerations: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const cap = transport.bootstrapCapability;
      assert(cap !== null, "expected bootstrap capability");
      const response = await transport.call(cap, 0, EMPTY);
      seenGenerations.push(response[0]);
    }

    assertEquals(connectCount, 7);
    assertEquals(
      JSON.stringify(seenGenerations),
      JSON.stringify([2, 3, 4, 5, 6, 7]),
    );
  } finally {
    await transport.close();
  }

  assertEquals(closed.length, 7);
  assertEquals(
    JSON.stringify(closed),
    JSON.stringify([1, 2, 3, 4, 5, 6, 7]),
  );
});

Deno.test("ReconnectingRpcClientTransport remaps non-bootstrap capability across repeated reconnect churn", async () => {
  const remapHistory: Array<{
    previousBootstrap: number | null;
    currentBootstrap: number | null;
    capability: number;
    methodOrdinal: number;
  }> = [];
  let connectCount = 0;

  const transport = new ReconnectingRpcClientTransport({
    connect: () => {
      connectCount += 1;
      const generation = connectCount;
      const client: RpcClientTransportLike = {
        bootstrap: () => Promise.resolve({ capabilityIndex: generation * 10 }),
        call: (capability) => {
          if (capability.capabilityIndex === 99) {
            return Promise.reject(
              new TransportError(`connection dropped (gen=${generation})`),
            );
          }
          if (capability.capabilityIndex !== 100 + generation) {
            return Promise.reject(
              new Error(
                `expected remapped capability ${
                  100 + generation
                }, got ${capability.capabilityIndex}`,
              ),
            );
          }
          return Promise.resolve(new Uint8Array([generation]));
        },
        close: () => Promise.resolve(),
      };
      return Promise.resolve(client);
    },
    reconnect: reconnectOptions(),
    remapCapabilityOnReconnect: (context) => {
      remapHistory.push({
        previousBootstrap:
          context.previousBootstrapCapability?.capabilityIndex ?? null,
        currentBootstrap: context.currentBootstrapCapability?.capabilityIndex ??
          null,
        capability: context.capability.capabilityIndex,
        methodOrdinal: context.methodOrdinal,
      });
      const currentBootstrap = context.currentBootstrapCapability;
      assert(
        currentBootstrap !== null,
        "expected current bootstrap capability",
      );
      return { capabilityIndex: 100 + (currentBootstrap.capabilityIndex / 10) };
    },
  });

  try {
    await transport.bootstrap();

    const seenGenerations: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const response = await transport.call({ capabilityIndex: 99 }, 7, EMPTY);
      seenGenerations.push(response[0]);
    }

    assertEquals(connectCount, 6);
    assertEquals(
      JSON.stringify(seenGenerations),
      JSON.stringify([2, 3, 4, 5, 6]),
    );
    assertEquals(remapHistory.length, 5);
    for (const entry of remapHistory) {
      assertEquals(entry.capability, 99);
      assertEquals(entry.methodOrdinal, 7);
      assert(entry.previousBootstrap !== null, "expected previous bootstrap");
      assert(entry.currentBootstrap !== null, "expected current bootstrap");
      assert(
        entry.previousBootstrap !== entry.currentBootstrap,
        "expected bootstrap to change after reconnect",
      );
    }
  } finally {
    await transport.close();
  }
});
