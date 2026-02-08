import { type RpcClientTransportLike, RpcConnectionPool } from "../advanced.ts";
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

// ---------------------------------------------------------------------------
// warmupStats() returns correct stats when all connections succeed
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool warmupStats() shows all succeeded when warmup succeeds", async () => {
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
    // Before whenReady(), stats should show requested=3, but succeeded/failed may be 0
    const statsBefore = pool.warmupStats();
    assertEquals(statsBefore.requested, 3);

    await withTimeout(pool.whenReady(), 1000, "whenReady");

    // After whenReady(), all should have succeeded
    const statsAfter = pool.warmupStats();
    assertEquals(statsAfter.requested, 3);
    assertEquals(statsAfter.succeeded, 3);
    assertEquals(statsAfter.failed, 0);

    assertEquals(createCount, 3);
    assertEquals(pool.stats.idle, 3);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// warmupStats() returns correct stats when some connections fail
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool warmupStats() shows failures when some warmup connections fail", async () => {
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
    await withTimeout(pool.whenReady(), 1000, "whenReady with failures");

    const stats = pool.warmupStats();
    assertEquals(stats.requested, 4);
    assertEquals(stats.succeeded, 2); // attempts 2 and 4
    assertEquals(stats.failed, 2); // attempts 1 and 3

    assertEquals(attempt, 4);
    assertEquals(pool.stats.idle, 2);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// warmupStats() returns zero stats when minConnections=0
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool warmupStats() returns zeros when minConnections=0", async () => {
  const factory = () => Promise.resolve(makeConn());
  const pool = new RpcConnectionPool(factory, {
    minConnections: 0,
    maxConnections: 4,
  });

  try {
    await withTimeout(pool.whenReady(), 100, "whenReady with minConnections=0");

    const stats = pool.warmupStats();
    assertEquals(stats.requested, 0);
    assertEquals(stats.succeeded, 0);
    assertEquals(stats.failed, 0);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// warmupStats() shows all failures when all warmup connections fail
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool warmupStats() shows all failed when all warmup connections fail", async () => {
  let attempt = 0;
  const factory = () => {
    attempt += 1;
    // First 3 attempts (warmup) fail, subsequent attempts succeed
    if (attempt <= 3) {
      return Promise.reject(new Error("warmup failed"));
    }
    return Promise.resolve(makeConn(attempt));
  };

  const pool = new RpcConnectionPool(factory, {
    minConnections: 3,
    maxConnections: 8,
  });

  try {
    await withTimeout(pool.whenReady(), 1000, "whenReady with all failures");

    const stats = pool.warmupStats();
    assertEquals(stats.requested, 3);
    assertEquals(stats.succeeded, 0);
    assertEquals(stats.failed, 3);

    assertEquals(attempt, 3);
    assertEquals(pool.stats.idle, 0);
    assertEquals(pool.stats.total, 0);

    // Pool should still work on-demand
    const conn = await pool.acquire();
    assert(conn !== undefined, "expected on-demand connection to succeed");
    assertEquals(attempt, 4);
    pool.release(conn);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// warmupStats() can be called before whenReady() resolves
// ---------------------------------------------------------------------------

Deno.test("RpcConnectionPool warmupStats() can be called before whenReady() resolves", async () => {
  const factory = () => {
    // Slow connection factory to ensure we can call warmupStats before ready
    return new Promise<RpcClientTransportLike>((resolve) => {
      setTimeout(() => resolve(makeConn()), 50);
    });
  };

  const pool = new RpcConnectionPool(factory, {
    minConnections: 2,
    maxConnections: 4,
  });

  try {
    // Call warmupStats immediately
    const statsBefore = pool.warmupStats();
    assertEquals(statsBefore.requested, 2);
    // succeeded and failed may still be 0 or partially complete

    await withTimeout(pool.whenReady(), 1000, "whenReady");

    const statsAfter = pool.warmupStats();
    assertEquals(statsAfter.requested, 2);
    assertEquals(statsAfter.succeeded, 2);
    assertEquals(statsAfter.failed, 0);
  } finally {
    await pool.close();
  }
});
