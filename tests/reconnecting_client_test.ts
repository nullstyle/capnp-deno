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

Deno.test("ReconnectingRpcClientTransport validates capability pointer ranges", async () => {
  const client: RpcClientTransportLike = {
    call: () => Promise.resolve(new Uint8Array([0x01])),
    close: () => Promise.resolve(),
  };

  const transport = new ReconnectingRpcClientTransport({
    connect: () => Promise.resolve(client),
    reconnect: reconnectOptions(),
  });

  try {
    let thrown: unknown;
    try {
      await transport.call({ capabilityIndex: -1 }, 0, EMPTY);
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof SessionError &&
        /capabilityIndex must be a non-negative 32-bit integer/i.test(
          thrown.message,
        ),
      `expected capability validation SessionError, got: ${String(thrown)}`,
    );
  } finally {
    await transport.close();
  }
});

Deno.test("ReconnectingRpcClientTransport reports missing finish/release support", async () => {
  const client: RpcClientTransportLike = {
    call: () => Promise.resolve(new Uint8Array([0x01])),
  };

  const transport = new ReconnectingRpcClientTransport({
    connect: () => Promise.resolve(client),
    reconnect: reconnectOptions(),
  });

  try {
    let finishErr: unknown;
    try {
      await transport.finish(1);
    } catch (error) {
      finishErr = error;
    }
    assert(
      finishErr instanceof SessionError &&
        /does not support finish\(\)/i.test(finishErr.message),
      `expected missing finish support error, got: ${String(finishErr)}`,
    );

    let releaseErr: unknown;
    try {
      await transport.release({ capabilityIndex: 2 }, 1);
    } catch (error) {
      releaseErr = error;
    }
    assert(
      releaseErr instanceof SessionError &&
        /does not support release\(\)/i.test(releaseErr.message),
      `expected missing release support error, got: ${String(releaseErr)}`,
    );
  } finally {
    await transport.close();
  }
});

Deno.test("ReconnectingRpcClientTransport honors shouldReconnectError override", async () => {
  let connectCount = 0;
  const seenErrors: unknown[] = [];
  const client: RpcClientTransportLike = {
    call: () => Promise.reject(new TransportError("dropped")),
    close: () => Promise.resolve(),
  };

  const transport = new ReconnectingRpcClientTransport({
    connect: () => {
      connectCount += 1;
      return Promise.resolve(client);
    },
    reconnect: reconnectOptions(),
    shouldReconnectError: (error) => {
      seenErrors.push(error);
      return false;
    },
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
      `expected original transport error, got: ${String(thrown)}`,
    );
    assertEquals(connectCount, 1);
    assertEquals(seenErrors.length, 1);
    assert(
      seenErrors[0] instanceof TransportError,
      `expected TransportError callback input, got: ${String(seenErrors[0])}`,
    );
  } finally {
    await transport.close();
  }
});

Deno.test("ReconnectingRpcClientTransport surfaces reconnect close failures", async () => {
  let connectCount = 0;
  let closeCalls = 0;
  const client1: RpcClientTransportLike = {
    call: () => Promise.reject(new TransportError("connection dropped")),
    close: () => {
      closeCalls += 1;
      if (closeCalls === 1) {
        return Promise.reject(new Error("close exploded"));
      }
      return Promise.resolve();
    },
  };
  const client2: RpcClientTransportLike = {
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
    let thrown: unknown;
    try {
      await transport.call({ capabilityIndex: 1 }, 0, EMPTY);
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof SessionError &&
        /rpc client close failed/i.test(thrown.message) &&
        /close exploded/i.test(thrown.message),
      `expected reconnect close failure, got: ${String(thrown)}`,
    );
    assertEquals(connectCount, 1);
    assertEquals(closeCalls, 1);
  } finally {
    await transport.close();
  }
});

Deno.test("ReconnectingRpcClientTransport retries calls even when no bootstrap was established", async () => {
  const calls: Array<{ client: number; capabilityIndex: number }> = [];
  let connectCount = 0;

  const client1: RpcClientTransportLike = {
    call: (capability) => {
      calls.push({ client: 1, capabilityIndex: capability.capabilityIndex });
      return Promise.reject(new TransportError("connection dropped"));
    },
    close: () => Promise.resolve(),
  };
  const client2: RpcClientTransportLike = {
    call: (capability) => {
      calls.push({ client: 2, capabilityIndex: capability.capabilityIndex });
      return Promise.resolve(new Uint8Array([0x7a]));
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
    const response = await transport.call({ capabilityIndex: 77 }, 5, EMPTY);
    assertEquals(response[0], 0x7a);
    assertEquals(connectCount, 2);
    assertEquals(
      JSON.stringify(calls),
      JSON.stringify([
        { client: 1, capabilityIndex: 77 },
        { client: 2, capabilityIndex: 77 },
      ]),
    );
    assertEquals(transport.bootstrapCapability, null);
  } finally {
    await transport.close();
  }
});

Deno.test("ReconnectingRpcClientTransport normalizes retry-call failures after reconnect", async () => {
  let connectCount = 0;
  const client1: RpcClientTransportLike = {
    call: () => Promise.reject(new TransportError("connection dropped")),
    close: () => Promise.resolve(),
  };
  const client2: RpcClientTransportLike = {
    call: () => Promise.reject(new Error("retry exploded")),
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
    let thrown: unknown;
    try {
      await transport.call({ capabilityIndex: 1 }, 0, EMPTY);
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof SessionError &&
        /rpc call retry failed/i.test(thrown.message) &&
        /retry exploded/i.test(thrown.message),
      `expected normalized retry failure, got: ${String(thrown)}`,
    );
    assertEquals(connectCount, 2);
  } finally {
    await transport.close();
  }
});

Deno.test("ReconnectingRpcClientTransport can disable bootstrap remap via rebootstrapOnReconnect=false", async () => {
  let connectCount = 0;
  let secondCallCount = 0;
  const client1: RpcClientTransportLike = {
    bootstrap: () => Promise.resolve({ capabilityIndex: 10 }),
    call: () => Promise.reject(new TransportError("connection dropped")),
    close: () => Promise.resolve(),
  };
  const client2: RpcClientTransportLike = {
    bootstrap: () => Promise.resolve({ capabilityIndex: 20 }),
    call: () => {
      secondCallCount += 1;
      return Promise.resolve(new Uint8Array([0x01]));
    },
    close: () => Promise.resolve(),
  };

  const transport = new ReconnectingRpcClientTransport({
    connect: () => {
      connectCount += 1;
      return Promise.resolve(connectCount === 1 ? client1 : client2);
    },
    reconnect: reconnectOptions(),
    rebootstrapOnReconnect: false,
  });

  try {
    const bootstrap = await transport.bootstrap();
    let thrown: unknown;
    try {
      await transport.call(bootstrap, 3, EMPTY);
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof SessionError &&
        /rebootstrapOnReconnect is disabled/i.test(thrown.message),
      `expected bootstrap remap policy error, got: ${String(thrown)}`,
    );
    assertEquals(connectCount, 2);
    assertEquals(secondCallCount, 0);
  } finally {
    await transport.close();
  }
});

Deno.test("ReconnectingRpcClientTransport remap callback can receive null current bootstrap when rebootstrap is disabled", async () => {
  let connectCount = 0;
  let remapCurrentBootstrap: number | null = -1;
  let remapPreviousBootstrap: number | null = -1;
  const client1: RpcClientTransportLike = {
    bootstrap: () => Promise.resolve({ capabilityIndex: 10 }),
    call: () => Promise.reject(new TransportError("connection dropped")),
    close: () => Promise.resolve(),
  };
  const client2: RpcClientTransportLike = {
    call: (capability) => {
      if (capability.capabilityIndex !== 77) {
        return Promise.reject(new Error("expected remapped capability"));
      }
      return Promise.resolve(new Uint8Array([0x33]));
    },
    close: () => Promise.resolve(),
  };

  const transport = new ReconnectingRpcClientTransport({
    connect: () => {
      connectCount += 1;
      return Promise.resolve(connectCount === 1 ? client1 : client2);
    },
    reconnect: reconnectOptions(),
    rebootstrapOnReconnect: false,
    remapCapabilityOnReconnect: (context) => {
      remapPreviousBootstrap =
        context.previousBootstrapCapability?.capabilityIndex ?? null;
      remapCurrentBootstrap =
        context.currentBootstrapCapability?.capabilityIndex ?? null;
      return { capabilityIndex: 77 };
    },
  });

  try {
    await transport.bootstrap();
    const out = await transport.call({ capabilityIndex: 99 }, 8, EMPTY);
    assertEquals(out[0], 0x33);
    assertEquals(remapPreviousBootstrap, 10);
    assertEquals(remapCurrentBootstrap, null);
    assertEquals(connectCount, 2);
  } finally {
    await transport.close();
  }
});

Deno.test("ReconnectingRpcClientTransport can skip reconnect for finish/release via shouldReconnectError", async () => {
  let connectCount = 0;
  let closeCalls = 0;
  const client: RpcClientTransportLike = {
    call: () => Promise.resolve(new Uint8Array([0x00])),
    finish: () => Promise.reject(new Error("finish exploded")),
    release: () => Promise.reject(new Error("release exploded")),
    close: () => {
      closeCalls += 1;
      return Promise.resolve();
    },
  };

  const transport = new ReconnectingRpcClientTransport({
    connect: () => {
      connectCount += 1;
      return Promise.resolve(client);
    },
    reconnect: reconnectOptions(),
    shouldReconnectError: () => false,
  });

  try {
    let finishErr: unknown;
    try {
      await transport.finish(7);
    } catch (error) {
      finishErr = error;
    }
    assert(
      finishErr instanceof SessionError &&
        /rpc finish failed/i.test(finishErr.message),
      `expected non-retriable finish error, got: ${String(finishErr)}`,
    );

    let releaseErr: unknown;
    try {
      await transport.release({ capabilityIndex: 9 }, 1);
    } catch (error) {
      releaseErr = error;
    }
    assert(
      releaseErr instanceof SessionError &&
        /rpc release failed/i.test(releaseErr.message),
      `expected non-retriable release error, got: ${String(releaseErr)}`,
    );

    assertEquals(connectCount, 1);
    assertEquals(closeCalls, 0);
  } finally {
    await transport.close();
  }

  assertEquals(closeCalls, 1);
});

Deno.test("ReconnectingRpcClientTransport surfaces bootstrap/connect/closed edge cases", async () => {
  const noBootstrapTransport = new ReconnectingRpcClientTransport({
    connect: () =>
      Promise.resolve({
        call: () => Promise.resolve(new Uint8Array([0x00])),
        close: () => Promise.resolve(),
      }),
    reconnect: reconnectOptions(),
  });

  try {
    let missingBootstrapErr: unknown;
    try {
      await noBootstrapTransport.bootstrap();
    } catch (error) {
      missingBootstrapErr = error;
    }
    assert(
      missingBootstrapErr instanceof SessionError &&
        /does not support bootstrap\(\)/i.test(missingBootstrapErr.message),
      `expected missing bootstrap support error, got: ${
        String(missingBootstrapErr)
      }`,
    );
  } finally {
    await noBootstrapTransport.close();
  }

  const bootstrapFailureTransport = new ReconnectingRpcClientTransport({
    connect: () =>
      Promise.resolve({
        bootstrap: () => Promise.reject("bootstrap exploded"),
        call: () => Promise.resolve(new Uint8Array([0x00])),
        close: () => Promise.resolve(),
      }),
    reconnect: reconnectOptions(),
  });

  try {
    let bootstrapErr: unknown;
    try {
      await bootstrapFailureTransport.bootstrap();
    } catch (error) {
      bootstrapErr = error;
    }
    assert(
      bootstrapErr instanceof SessionError &&
        /rpc bootstrap failed/i.test(bootstrapErr.message) &&
        /bootstrap exploded/i.test(bootstrapErr.message),
      `expected normalized bootstrap failure, got: ${String(bootstrapErr)}`,
    );
  } finally {
    await bootstrapFailureTransport.close();
  }

  const connectFailureTransport = new ReconnectingRpcClientTransport({
    connect: () => Promise.reject(new Error("dial exploded")),
    reconnect: {
      policy: {
        shouldRetry: () => false,
        nextDelayMs: () => 0,
      },
      sleep: async (_delayMs: number) => {},
    },
  });

  let connectErr: unknown;
  try {
    await connectFailureTransport.call({ capabilityIndex: 1 }, 0, EMPTY);
  } catch (error) {
    connectErr = error;
  }
  assert(
    connectErr instanceof TransportError &&
      /reconnect connect attempt failed/i.test(connectErr.message) &&
      /dial exploded/i.test(connectErr.message),
    `expected connect failure normalization, got: ${String(connectErr)}`,
  );
  await connectFailureTransport.close();

  const closedTransport = new ReconnectingRpcClientTransport({
    connect: () =>
      Promise.resolve({
        call: () => Promise.resolve(new Uint8Array([0x00])),
      }),
    reconnect: reconnectOptions(),
  });
  await closedTransport.close();

  let closedErr: unknown;
  try {
    await closedTransport.call({ capabilityIndex: 1 }, 0, EMPTY);
  } catch (error) {
    closedErr = error;
  }
  assert(
    closedErr instanceof SessionError &&
      /reconnecting client transport is closed/i.test(closedErr.message),
    `expected closed transport guard, got: ${String(closedErr)}`,
  );
});
