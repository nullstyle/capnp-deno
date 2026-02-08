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

// ---------------------------------------------------------------------------
// Health check: healthy connections are reused
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool health check reuses healthy connections", async () => {
  let createCount = 0;
  const factory = () => {
    createCount += 1;
    return Promise.resolve(makeConn(createCount));
  };

  const pool = new RpcConnectionPool(factory, {
    maxConnections: 4,
    healthCheck: () => true,
    // Set threshold to 0 so health check always runs on idle connections.
    healthCheckIdleMs: 0,
  });

  try {
    const conn1 = await pool.acquire();
    pool.release(conn1);
    assertEquals(createCount, 1);

    const conn2 = await pool.acquire();
    assert(
      conn1 === conn2,
      "expected the same healthy connection to be reused",
    );
    assertEquals(createCount, 1);
    pool.release(conn2);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// Health check: unhealthy connections are discarded and a new one is created
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool health check discards unhealthy connection and creates new one", async () => {
  let createCount = 0;
  const closedIds: number[] = [];
  const factory = () => {
    createCount += 1;
    const id = createCount;
    const conn: RpcClientTransportLike & { id: number; closed: boolean } = {
      id,
      closed: false,
      call: () => Promise.resolve(EMPTY),
      close() {
        this.closed = true;
        closedIds.push(id);
        return Promise.resolve();
      },
    };
    return Promise.resolve(conn);
  };

  const pool = new RpcConnectionPool(factory, {
    maxConnections: 4,
    healthCheck: () => false, // All idle connections are "unhealthy".
    healthCheckIdleMs: 0,
  });

  try {
    const conn1 = await pool.acquire();
    assertEquals(createCount, 1);
    pool.release(conn1);
    assertEquals(pool.stats.idle, 1);

    // Acquiring again should discard the unhealthy connection and create a new one.
    const conn2 = await pool.acquire();
    assert(conn1 !== conn2, "expected a new connection, not the unhealthy one");
    assertEquals(createCount, 2);
    // The old connection should have been closed.
    assert(closedIds.includes(1), "expected unhealthy connection to be closed");
    assertEquals(pool.stats.idle, 0);
    assertEquals(pool.stats.active, 1);
    pool.release(conn2);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// Health check: only runs after idle threshold is exceeded
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool health check is skipped when idle time is below threshold", async () => {
  let healthCheckCalls = 0;
  let createCount = 0;
  const factory = () => {
    createCount += 1;
    return Promise.resolve(makeConn(createCount));
  };

  const pool = new RpcConnectionPool(factory, {
    maxConnections: 4,
    healthCheck: () => {
      healthCheckCalls += 1;
      // Return false to make it obvious if health check runs unexpectedly --
      // the connection would be discarded.
      return false;
    },
    // Very high threshold so the health check should NOT run.
    healthCheckIdleMs: 60000,
  });

  try {
    const conn1 = await pool.acquire();
    pool.release(conn1);

    // Connection was just released, idle time ~0ms, well below 60000ms threshold.
    const conn2 = await pool.acquire();
    assert(
      conn1 === conn2,
      "expected same connection since health check should not have run",
    );
    assertEquals(
      healthCheckCalls,
      0,
      "health check should not have been called",
    );
    assertEquals(createCount, 1, "no new connection should have been created");
    pool.release(conn2);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// Health check: runs when idle time exceeds threshold
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool health check runs when idle time exceeds threshold", async () => {
  let healthCheckCalls = 0;
  let createCount = 0;
  const factory = () => {
    createCount += 1;
    return Promise.resolve(makeConn(createCount));
  };

  const pool = new RpcConnectionPool(factory, {
    maxConnections: 4,
    idleTimeoutMs: 5000,
    healthCheck: () => {
      healthCheckCalls += 1;
      return true; // Connection is healthy.
    },
    healthCheckIdleMs: 30, // Low threshold so it triggers after a short wait.
  });

  try {
    const conn1 = await pool.acquire();
    pool.release(conn1);

    // Wait long enough to exceed the health check idle threshold.
    await new Promise((r) => setTimeout(r, 60));

    const conn2 = await pool.acquire();
    assert(
      conn1 === conn2,
      "expected same connection since health check passed",
    );
    assertEquals(
      healthCheckCalls,
      1,
      "health check should have been called once",
    );
    assertEquals(createCount, 1, "no new connection should have been created");
    pool.release(conn2);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// Health check: async health check support
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool supports async health checks", async () => {
  let createCount = 0;
  let healthCheckCalls = 0;
  const factory = () => {
    createCount += 1;
    return Promise.resolve(makeConn(createCount));
  };

  const pool = new RpcConnectionPool(factory, {
    maxConnections: 4,
    healthCheck: async () => {
      healthCheckCalls += 1;
      // Simulate an async operation (e.g. a ping).
      await new Promise((r) => setTimeout(r, 5));
      return true;
    },
    healthCheckIdleMs: 0,
  });

  try {
    const conn1 = await pool.acquire();
    pool.release(conn1);

    const conn2 = await pool.acquire();
    assert(
      conn1 === conn2,
      "expected same connection after async health check",
    );
    assertEquals(
      healthCheckCalls,
      1,
      "async health check should have been called",
    );
    assertEquals(createCount, 1);
    pool.release(conn2);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// Health check: async health check that fails discards connection
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool async health check failure discards connection", async () => {
  let createCount = 0;
  const factory = () => {
    createCount += 1;
    return Promise.resolve(makeConn(createCount));
  };

  const pool = new RpcConnectionPool(factory, {
    maxConnections: 4,
    healthCheck: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return false;
    },
    healthCheckIdleMs: 0,
  });

  try {
    const conn1 = await pool.acquire();
    pool.release(conn1);

    const conn2 = await pool.acquire();
    assert(
      conn1 !== conn2,
      "expected new connection after async health check failure",
    );
    assertEquals(createCount, 2);
    pool.release(conn2);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// Health check: exception in health check treated as failure
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool health check exception is treated as failure", async () => {
  let createCount = 0;
  const factory = () => {
    createCount += 1;
    return Promise.resolve(makeConn(createCount));
  };

  const pool = new RpcConnectionPool(factory, {
    maxConnections: 4,
    healthCheck: () => {
      throw new Error("health check exploded");
    },
    healthCheckIdleMs: 0,
  });

  try {
    const conn1 = await pool.acquire();
    pool.release(conn1);

    const conn2 = await pool.acquire();
    assert(
      conn1 !== conn2,
      "expected new connection after health check exception",
    );
    assertEquals(createCount, 2);
    pool.release(conn2);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// Health check: multiple idle connections, first unhealthy, second healthy
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool skips unhealthy idle connections until finding a healthy one", async () => {
  let createCount = 0;
  const closedIds: number[] = [];
  const factory = () => {
    createCount += 1;
    const id = createCount;
    const conn: RpcClientTransportLike & { id: number; closed: boolean } = {
      id,
      closed: false,
      call: () => Promise.resolve(EMPTY),
      close() {
        this.closed = true;
        closedIds.push(id);
        return Promise.resolve();
      },
    };
    return Promise.resolve(conn);
  };

  // Health check: connection with id=1 is unhealthy, id=2 is healthy.
  const pool = new RpcConnectionPool(factory, {
    maxConnections: 4,
    healthCheck: (conn) => {
      const c = conn as RpcClientTransportLike & { id: number };
      return c.id !== 1;
    },
    healthCheckIdleMs: 0,
  });

  try {
    // Create and release two connections so both go idle.
    const conn1 = await pool.acquire();
    const conn2 = await pool.acquire();
    pool.release(conn1); // id=1, goes to idle first
    pool.release(conn2); // id=2, goes to idle second

    assertEquals(pool.stats.idle, 2);

    // On acquire: conn1 (id=1) fails health check, gets closed.
    // conn2 (id=2) passes health check, gets returned.
    const conn3 = await pool.acquire();
    const c3 = conn3 as RpcClientTransportLike & { id: number };
    assertEquals(c3.id, 2, "expected conn with id=2 (the healthy one)");
    assert(closedIds.includes(1), "expected unhealthy conn id=1 to be closed");
    assertEquals(createCount, 2, "no new connections should have been created");
    assertEquals(pool.stats.idle, 0);
    assertEquals(pool.stats.active, 1);
    pool.release(conn3);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// Timeout + release race: settled flag prevents double-resolution
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool timeout+release race does not corrupt FIFO ordering", async () => {
  // Scenario: two pending acquires (P1, P2) are queued against a pool with
  // maxConnections=1. P1 has a very short timeout (10ms) so it will fire
  // before we release. P2 has a long timeout. After P1 times out, we release
  // the connection. Because P1 is already settled, `release()` must skip it
  // and hand the connection to P2, preserving correct FIFO ordering.
  const factory = makeConnFactory();
  const pool = new RpcConnectionPool(factory, {
    maxConnections: 1,
    acquireTimeoutMs: 5000, // default for the pool; we override per-test below
  });

  try {
    const conn = await pool.acquire();
    assertEquals(pool.stats.active, 1);

    // P1: will time out quickly. We create a separate pool to get the short
    // timeout, but it's simpler to just race a manual timer. Instead, we
    // create two pending acquires on the same pool.
    //
    // We cannot directly set per-acquire timeouts, so we create a pool
    // with a very short acquireTimeoutMs and manually orchestrate:

    // Actually, let's use a pool with a short timeout and two pending acquires.
    // Close the current pool and create a fresh one.
    pool.release(conn);
  } finally {
    await pool.close();
  }

  // Fresh pool with short acquire timeout to exercise the race.
  const factory2 = makeConnFactory();
  const pool2 = new RpcConnectionPool(factory2, {
    maxConnections: 1,
    acquireTimeoutMs: 30, // Short timeout for pending acquires
  });

  try {
    // Hold the only connection so subsequent acquires go pending.
    const held = await pool2.acquire();
    assertEquals(pool2.stats.active, 1);

    // Fire off two pending acquires.
    const results: string[] = [];
    const p1 = pool2.acquire().then(
      (c) => {
        results.push("p1:resolved");
        pool2.release(c);
      },
      () => {
        results.push("p1:timeout");
      },
    );
    const p2 = pool2.acquire().then(
      (c) => {
        results.push("p2:resolved");
        pool2.release(c);
      },
      () => {
        results.push("p2:timeout");
      },
    );

    assertEquals(pool2.stats.pending, 2);

    // Wait for both pending acquires to time out.
    await new Promise((r) => setTimeout(r, 100));

    // Both should have timed out.
    assertEquals(pool2.stats.pending, 0);

    // Now release the held connection. Because both pending entries are
    // already settled, release() should skip them and return the connection
    // to the idle pool instead of trying to resolve an already-timed-out
    // waiter (which was the bug).
    pool2.release(held);

    await p1;
    await p2;

    // Both must have timed out.
    assert(
      results.includes("p1:timeout"),
      `expected p1 to timeout, got: ${JSON.stringify(results)}`,
    );
    assert(
      results.includes("p2:timeout"),
      `expected p2 to timeout, got: ${JSON.stringify(results)}`,
    );
    assertEquals(results.length, 2);

    // The released connection should now be idle, not handed to a stale waiter.
    assertEquals(pool2.stats.idle, 1);
    assertEquals(pool2.stats.active, 0);
    assertEquals(pool2.stats.pending, 0);
  } finally {
    await pool2.close();
  }
});

// ---------------------------------------------------------------------------
// Timeout + release race: release before timeout satisfies waiter correctly
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool release before timeout correctly satisfies pending waiter", async () => {
  // Complementary scenario: release happens BEFORE the timeout fires.
  // The waiter should be resolved by release(), and when the timeout
  // later fires it should be a no-op (settled flag is true).
  const factory = makeConnFactory();
  const pool = new RpcConnectionPool(factory, {
    maxConnections: 1,
    acquireTimeoutMs: 2000,
  });

  try {
    const conn = await pool.acquire();

    const acquirePromise = pool.acquire();
    assertEquals(pool.stats.pending, 1);

    // Release immediately -- should satisfy the pending waiter.
    pool.release(conn);

    const conn2 = await withTimeout(acquirePromise, 1000, "pending acquire");
    assert(conn2 !== undefined, "expected connection from pending acquire");
    assertEquals(pool.stats.active, 1);
    assertEquals(pool.stats.pending, 0);

    // Wait past where a timeout would have fired if the settled flag
    // were not working. If the flag is broken, the reject would fire
    // and cause an unhandled rejection.
    await new Promise((r) => setTimeout(r, 50));

    // Pool should still be in a consistent state.
    assertEquals(pool.stats.active, 1);
    assertEquals(pool.stats.pending, 0);
    pool.release(conn2);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// whenReady() resolves after all warm-up connections are created
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool whenReady() resolves after warm-up connections are created", async () => {
  let createCount = 0;
  const factory = () => {
    createCount += 1;
    return Promise.resolve(makeConn(createCount));
  };

  const pool = new RpcConnectionPool(factory, {
    minConnections: 3,
    maxConnections: 4,
  });

  try {
    await withTimeout(pool.whenReady(), 1000, "whenReady");
    assertEquals(createCount, 3);
    assertEquals(pool.stats.idle, 3);
    assertEquals(pool.stats.active, 0);
    assertEquals(pool.stats.total, 3);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// whenReady() resolves even if some warm-up connections fail
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool whenReady() resolves even if some warm-up connections fail", async () => {
  let attempt = 0;
  const factory = () => {
    attempt += 1;
    // Odd attempts fail, even attempts succeed.
    if (attempt % 2 === 1) {
      return Promise.reject(new Error(`warm-up failed #${attempt}`));
    }
    return Promise.resolve(makeConn(attempt));
  };

  const pool = new RpcConnectionPool(factory, {
    minConnections: 4,
    maxConnections: 8,
  });

  try {
    // whenReady() must resolve even though 2 of 4 connections failed.
    await withTimeout(pool.whenReady(), 1000, "whenReady with failures");
    assertEquals(attempt, 4);
    // Only the even attempts succeeded.
    assertEquals(pool.stats.idle, 2);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// whenReady() resolves immediately if minConnections=0
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool whenReady() resolves immediately if minConnections=0", async () => {
  const factory = makeConnFactory();
  const pool = new RpcConnectionPool(factory, {
    minConnections: 0,
    maxConnections: 4,
  });

  try {
    // Should resolve without delay since there is nothing to warm up.
    await withTimeout(pool.whenReady(), 100, "whenReady with minConnections=0");
    assertEquals(pool.stats.total, 0);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// close() after construction doesn't leak warm-up connections
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool close() after construction doesn't leak warm-up connections", async () => {
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
    minConnections: 3,
    maxConnections: 4,
  });

  // Close immediately after construction -- warm-up is in flight.
  await pool.close();

  // close() awaits warmupComplete, so all warm-up connections should have
  // been created and then closed during cleanup.
  assertEquals(createCount, 3);
  assertEquals(closedIds.length, 3);
  assertEquals(pool.stats.total, 0);
});
