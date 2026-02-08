import {
  type RpcClientTransportLike,
  RpcConnectionPool,
  SessionError,
  withConnection,
} from "../mod.ts";
import { assert, assertEquals, withTimeout } from "./test_utils.ts";

const EMPTY = new Uint8Array();

function makeConn(
  id = 0,
): RpcClientTransportLike & { id: number; closed: boolean } {
  return {
    id,
    closed: false,
    call: () => Promise.resolve(EMPTY),
    close() {
      this.closed = true;
      return Promise.resolve();
    },
  };
}

let connCounter = 0;
function makeConnFactory(): () => Promise<
  RpcClientTransportLike & { id: number; closed: boolean }
> {
  connCounter = 0;
  return () => {
    connCounter += 1;
    return Promise.resolve(makeConn(connCounter));
  };
}

// ---------------------------------------------------------------------------
// Basic acquire/release lifecycle
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool basic acquire and release lifecycle", async () => {
  const factory = makeConnFactory();
  const pool = new RpcConnectionPool(factory, { maxConnections: 2 });

  try {
    const conn = await pool.acquire();
    assertEquals(pool.stats.active, 1);
    assertEquals(pool.stats.idle, 0);
    assertEquals(pool.stats.total, 1);
    assertEquals(pool.stats.pending, 0);

    pool.release(conn);
    assertEquals(pool.stats.active, 0);
    assertEquals(pool.stats.idle, 1);
    assertEquals(pool.stats.total, 1);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// Reuse of idle connections
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool reuses idle connections instead of creating new ones", async () => {
  let createCount = 0;
  const factory = () => {
    createCount += 1;
    return Promise.resolve(makeConn(createCount));
  };
  const pool = new RpcConnectionPool(factory, { maxConnections: 4 });

  try {
    const conn1 = await pool.acquire();
    pool.release(conn1);
    assertEquals(createCount, 1);

    const conn2 = await pool.acquire();
    assert(conn1 === conn2, "expected the same connection to be reused");
    assertEquals(createCount, 1);
    pool.release(conn2);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// Max connections enforced (acquire blocks when at limit)
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool enforces maxConnections and blocks acquire", async () => {
  const factory = makeConnFactory();
  const pool = new RpcConnectionPool(factory, {
    maxConnections: 1,
    acquireTimeoutMs: 2000,
  });

  try {
    const conn1 = await pool.acquire();
    assertEquals(pool.stats.active, 1);

    // Second acquire should block since we're at max.
    const acquirePromise = pool.acquire();
    assertEquals(pool.stats.pending, 1);

    // Release first connection -- pending acquire should resolve.
    pool.release(conn1);

    const conn2 = await withTimeout(acquirePromise, 1000, "pending acquire");
    assert(conn2 !== undefined, "expected connection from pending acquire");
    assertEquals(pool.stats.active, 1);
    assertEquals(pool.stats.pending, 0);
    pool.release(conn2);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// Acquire timeout when pool exhausted
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool acquire times out when pool is exhausted", async () => {
  const factory = makeConnFactory();
  const pool = new RpcConnectionPool(factory, {
    maxConnections: 1,
    acquireTimeoutMs: 50,
  });

  try {
    const conn = await pool.acquire();
    let thrown: unknown;
    try {
      await pool.acquire();
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof SessionError &&
        /acquire timed out/i.test(thrown.message),
      `expected acquire timeout SessionError, got: ${String(thrown)}`,
    );
    assertEquals(pool.stats.pending, 0);
    pool.release(conn);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// Idle timeout closes unused connections
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool idle timeout closes unused connections", async () => {
  const closedIds: number[] = [];
  let createCount = 0;
  const factory = () => {
    createCount += 1;
    const id = createCount;
    const conn: RpcClientTransportLike = {
      call: () => Promise.resolve(EMPTY),
      close: () => {
        closedIds.push(id);
        return Promise.resolve();
      },
    };
    return Promise.resolve(conn);
  };

  const pool = new RpcConnectionPool(factory, {
    maxConnections: 4,
    idleTimeoutMs: 50,
  });

  try {
    const conn = await pool.acquire();
    pool.release(conn);
    assertEquals(pool.stats.idle, 1);

    // Wait for idle timeout to fire.
    await new Promise((r) => setTimeout(r, 120));
    assertEquals(pool.stats.idle, 0);
    assertEquals(closedIds.length, 1);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// Close rejects pending acquires
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool close rejects pending acquires", async () => {
  const factory = makeConnFactory();
  const pool = new RpcConnectionPool(factory, {
    maxConnections: 1,
    acquireTimeoutMs: 5000,
  });

  const conn = await pool.acquire();
  const acquirePromise = pool.acquire();
  assertEquals(pool.stats.pending, 1);

  // Close the pool while an acquire is pending.
  await pool.close();
  pool.release(conn);

  let thrown: unknown;
  try {
    await acquirePromise;
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof SessionError &&
      /connection pool is closed/i.test(thrown.message),
    `expected pool closed SessionError, got: ${String(thrown)}`,
  );
});

// ---------------------------------------------------------------------------
// Connection failure during acquire
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool reports connection creation failure", async () => {
  let attempt = 0;
  const factory = () => {
    attempt += 1;
    return Promise.reject(new Error(`dial failed attempt ${attempt}`));
  };

  const pool = new RpcConnectionPool(factory, { maxConnections: 2 });

  try {
    let thrown: unknown;
    try {
      await pool.acquire();
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof SessionError &&
        /failed to create connection/i.test(thrown.message),
      `expected creation failure SessionError, got: ${String(thrown)}`,
    );
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// withConnection helper releases on success
// ---------------------------------------------------------------------------

Deno.test("withConnection releases connection on success", async () => {
  const factory = makeConnFactory();
  const pool = new RpcConnectionPool(factory, { maxConnections: 2 });

  try {
    const result = await withConnection(pool, (_conn) => {
      assertEquals(pool.stats.active, 1);
      return Promise.resolve(42);
    });

    assertEquals(result, 42);
    assertEquals(pool.stats.active, 0);
    assertEquals(pool.stats.idle, 1);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// withConnection helper releases on error
// ---------------------------------------------------------------------------

Deno.test("withConnection releases connection on error", async () => {
  const factory = makeConnFactory();
  const pool = new RpcConnectionPool(factory, { maxConnections: 2 });

  try {
    let thrown: unknown;
    try {
      await withConnection(pool, (_conn) => {
        assertEquals(pool.stats.active, 1);
        throw new Error("boom");
      });
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof Error && thrown.message === "boom",
      `expected original error to propagate, got: ${String(thrown)}`,
    );
    assertEquals(pool.stats.active, 0);
    assertEquals(pool.stats.idle, 1);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// Stats tracking is accurate
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool stats are accurate throughout lifecycle", async () => {
  const factory = makeConnFactory();
  const pool = new RpcConnectionPool(factory, {
    maxConnections: 3,
    acquireTimeoutMs: 2000,
  });

  try {
    assertEquals(pool.stats.total, 0);
    assertEquals(pool.stats.idle, 0);
    assertEquals(pool.stats.active, 0);
    assertEquals(pool.stats.pending, 0);

    const c1 = await pool.acquire();
    const c2 = await pool.acquire();
    assertEquals(pool.stats.total, 2);
    assertEquals(pool.stats.active, 2);
    assertEquals(pool.stats.idle, 0);

    const c3 = await pool.acquire();
    assertEquals(pool.stats.total, 3);
    assertEquals(pool.stats.active, 3);

    // At max, next acquire goes pending.
    const pendingPromise = pool.acquire();
    assertEquals(pool.stats.pending, 1);

    pool.release(c2);
    const c4 = await withTimeout(pendingPromise, 1000, "pending acquire");
    assertEquals(pool.stats.pending, 0);
    assertEquals(pool.stats.active, 3);
    assertEquals(pool.stats.idle, 0);

    pool.release(c1);
    pool.release(c3);
    pool.release(c4);
    assertEquals(pool.stats.active, 0);
    assertEquals(pool.stats.idle, 3);
    assertEquals(pool.stats.total, 3);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// Concurrent acquire/release operations
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool handles concurrent acquire/release operations", async () => {
  const factory = makeConnFactory();
  const pool = new RpcConnectionPool(factory, {
    maxConnections: 3,
    acquireTimeoutMs: 2000,
  });

  try {
    // Fire off 6 concurrent acquires with max 3 connections.
    const results: number[] = [];
    const tasks = Array.from({ length: 6 }, (_, i) =>
      (async () => {
        const conn = await pool.acquire();
        results.push(i);
        // Simulate some async work.
        await new Promise((r) => setTimeout(r, 10));
        pool.release(conn);
      })());

    await withTimeout(
      Promise.all(tasks),
      5000,
      "concurrent acquire/release",
    );

    assertEquals(results.length, 6);
    assertEquals(pool.stats.active, 0);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// Min connections pre-warming
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool pre-warms minConnections", async () => {
  let createCount = 0;
  const factory = () => {
    createCount += 1;
    return Promise.resolve(makeConn(createCount));
  };

  const pool = new RpcConnectionPool(factory, {
    minConnections: 2,
    maxConnections: 4,
  });

  try {
    // Allow micro-tasks to settle for warm-up.
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(createCount, 2);
    assertEquals(pool.stats.idle, 2);
    assertEquals(pool.stats.active, 0);
    assertEquals(pool.stats.total, 2);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// Acquire after close throws
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool acquire after close throws", async () => {
  const factory = makeConnFactory();
  const pool = new RpcConnectionPool(factory);

  await pool.close();

  let thrown: unknown;
  try {
    await pool.acquire();
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof SessionError &&
      /connection pool is closed/i.test(thrown.message),
    `expected pool closed SessionError, got: ${String(thrown)}`,
  );
});

// ---------------------------------------------------------------------------
// Double close is a no-op
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool double close is a no-op", async () => {
  const factory = makeConnFactory();
  const pool = new RpcConnectionPool(factory);
  const conn = await pool.acquire();
  pool.release(conn);

  await pool.close();
  await pool.close(); // Should not throw.
});

// ---------------------------------------------------------------------------
// Symbol.dispose delegates to close
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool Symbol.dispose delegates to close", async () => {
  const factory = makeConnFactory();
  const pool = new RpcConnectionPool(factory);
  const conn = await pool.acquire();
  pool.release(conn);

  pool[Symbol.dispose]();

  // Allow any promises to settle.
  await new Promise((r) => setTimeout(r, 10));

  let thrown: unknown;
  try {
    await pool.acquire();
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof SessionError &&
      /connection pool is closed/i.test(thrown.message),
    `expected pool closed after dispose, got: ${String(thrown)}`,
  );
});

// ---------------------------------------------------------------------------
// Release of unknown connection is a no-op
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool releasing unknown connection is a no-op", async () => {
  const factory = makeConnFactory();
  const pool = new RpcConnectionPool(factory, { maxConnections: 2 });

  try {
    const stranger = makeConn(999);
    pool.release(stranger); // Should not throw or affect stats.
    assertEquals(pool.stats.total, 0);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// minConnections must not exceed maxConnections
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool rejects minConnections > maxConnections", () => {
  let thrown: unknown;
  try {
    new RpcConnectionPool(
      () => Promise.resolve(makeConn()),
      { minConnections: 5, maxConnections: 2 },
    );
  } catch (error) {
    thrown = error;
  }

  assert(
    thrown instanceof SessionError &&
      /minConnections must not exceed maxConnections/i.test(thrown.message),
    `expected validation SessionError, got: ${String(thrown)}`,
  );
});

// ---------------------------------------------------------------------------
// Close while connections are active
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool close closes active connections", async () => {
  const closedIds: number[] = [];
  let createCount = 0;
  const factory = () => {
    createCount += 1;
    const id = createCount;
    const conn: RpcClientTransportLike = {
      call: () => Promise.resolve(EMPTY),
      close: () => {
        closedIds.push(id);
        return Promise.resolve();
      },
    };
    return Promise.resolve(conn);
  };

  const pool = new RpcConnectionPool(factory, { maxConnections: 2 });
  const c1 = await pool.acquire();
  const c2 = await pool.acquire();
  assertEquals(pool.stats.active, 2);

  await pool.close();
  // Active connections should have been closed.
  assertEquals(closedIds.length, 2);

  // Releasing after close should not throw.
  pool.release(c1);
  pool.release(c2);
});

// ---------------------------------------------------------------------------
// Warm-up failure is silently ignored
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool warm-up failure is silently ignored", async () => {
  let attempt = 0;
  const factory = () => {
    attempt += 1;
    if (attempt <= 2) {
      return Promise.reject(new Error("warm-up failed"));
    }
    return Promise.resolve(makeConn(attempt));
  };

  const pool = new RpcConnectionPool(factory, {
    minConnections: 2,
    maxConnections: 4,
  });

  try {
    // Allow warm-up promises to settle.
    await new Promise((r) => setTimeout(r, 50));

    // Warm-up failed, but pool should still work on-demand.
    assertEquals(pool.stats.idle, 0);
    const conn = await pool.acquire();
    assert(conn !== undefined, "expected on-demand connection to succeed");
    pool.release(conn);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// Pending acquire resolves in FIFO order
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool resolves pending acquires in FIFO order", async () => {
  const factory = makeConnFactory();
  const pool = new RpcConnectionPool(factory, {
    maxConnections: 1,
    acquireTimeoutMs: 2000,
  });

  try {
    const conn = await pool.acquire();
    const order: number[] = [];

    const p1 = pool.acquire().then((c) => {
      order.push(1);
      pool.release(c);
    });
    const p2 = pool.acquire().then((c) => {
      order.push(2);
      pool.release(c);
    });

    assertEquals(pool.stats.pending, 2);
    pool.release(conn);

    await withTimeout(Promise.all([p1, p2]), 2000, "FIFO pending acquires");
    assertEquals(JSON.stringify(order), JSON.stringify([1, 2]));
  } finally {
    await pool.close();
  }
});
