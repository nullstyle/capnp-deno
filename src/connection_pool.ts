import { SessionError } from "./errors.ts";
import type { RpcClientTransportLike } from "./reconnecting_client.ts";
import {
  assertNonNegativeFinite,
  assertNonNegativeInteger,
  assertPositiveInteger,
} from "./validation.ts";

/**
 * Configuration options for {@link RpcConnectionPool}.
 */
export interface RpcConnectionPoolOptions {
  /** Minimum number of connections to keep in the pool. Defaults to 0. */
  minConnections?: number;
  /** Maximum number of connections allowed. Defaults to 8. */
  maxConnections?: number;
  /** Time in milliseconds before an idle connection is closed. Defaults to 30000. */
  idleTimeoutMs?: number;
  /** Time in milliseconds to wait for a connection when the pool is exhausted. Defaults to 5000. */
  acquireTimeoutMs?: number;
  /**
   * Optional callback to validate that an idle connection is still healthy
   * before reusing it. Return `true` if the connection is healthy, `false`
   * otherwise. May be synchronous or asynchronous.
   */
  healthCheck?: (
    conn: RpcClientTransportLike,
  ) => boolean | Promise<boolean>;
  /**
   * Time in milliseconds a connection must have been idle before a health
   * check is performed on acquire. Connections idle for less than this
   * duration are assumed healthy and returned immediately. Defaults to 10000.
   * Only meaningful when {@link healthCheck} is configured.
   */
  healthCheckIdleMs?: number;
}

/**
 * Pool statistics returned by {@link RpcConnectionPool.stats}.
 */
export interface RpcConnectionPoolStats {
  /** Total number of connections managed by the pool (idle + active). */
  total: number;
  /** Number of idle connections available for acquisition. */
  idle: number;
  /** Number of connections currently in use. */
  active: number;
  /** Number of pending acquire requests waiting for a connection. */
  pending: number;
}

/**
 * Warm-up statistics returned by {@link RpcConnectionPool.warmupStats}.
 */
export interface RpcConnectionPoolWarmupStats {
  /** Number of warm-up connections requested (same as minConnections). */
  requested: number;
  /** Number of warm-up connections that successfully connected. */
  succeeded: number;
  /** Number of warm-up connections that failed. */
  failed: number;
}

interface IdleEntry {
  conn: RpcClientTransportLike;
  timer: ReturnType<typeof setTimeout>;
  /** Timestamp (ms since epoch) when the connection was placed into the idle pool. */
  lastUsedAt: number;
}

interface PendingAcquire {
  resolve: (conn: RpcClientTransportLike) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Whether this entry has already been resolved or rejected. */
  settled: boolean;
}

/**
 * A connection pool for managing multiple RPC client transport connections.
 *
 * The pool lazily creates connections up to the configured maximum, reuses
 * idle connections, and closes connections that have been idle for longer
 * than `idleTimeoutMs`. When the pool is at capacity, {@link acquire} will
 * block until a connection is released or `acquireTimeoutMs` is exceeded.
 *
 * On construction, if `minConnections` is greater than 0, the pool will
 * pre-warm by creating that many connections eagerly. Warm-up is best-effort:
 * individual connection failures during warm-up are silently ignored, and
 * {@link whenReady} will resolve even if some or all warm-up connections fail.
 * Use {@link warmupStats} to inspect warm-up success/failure counts after
 * {@link whenReady} resolves.
 *
 * Implements `Disposable` and `AsyncDisposable` so it can be used with `using`
 * and `await using` declarations.
 *
 * @example
 * ```ts
 * const pool = new RpcConnectionPool(
 *   () => createMyTransport(),
 *   { maxConnections: 4, idleTimeoutMs: 10000 },
 * );
 * const conn = await pool.acquire();
 * try {
 *   // use conn...
 * } finally {
 *   pool.release(conn);
 * }
 * await pool.close();
 * ```
 */
export class RpcConnectionPool implements Disposable, AsyncDisposable {
  readonly #connect: () => Promise<RpcClientTransportLike>;
  readonly #minConnections: number;
  readonly #maxConnections: number;
  readonly #idleTimeoutMs: number;
  readonly #acquireTimeoutMs: number;
  readonly #healthCheck?: (
    conn: RpcClientTransportLike,
  ) => boolean | Promise<boolean>;
  readonly #healthCheckIdleMs: number;

  #idle: Map<RpcClientTransportLike, IdleEntry> = new Map();
  #active: Set<RpcClientTransportLike> = new Set();
  #pending: PendingAcquire[] = [];
  #pendingSettled = 0;
  #closed = false;
  #closePromise?: Promise<void>;
  #warmupComplete: Promise<void>;
  #warmupRequested = 0;
  #warmupSucceeded = 0;
  #warmupFailed = 0;

  constructor(
    connect: () => Promise<RpcClientTransportLike>,
    options: RpcConnectionPoolOptions = {},
  ) {
    this.#connect = connect;
    this.#minConnections = options.minConnections ?? 0;
    this.#maxConnections = options.maxConnections ?? 8;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 30000;
    this.#acquireTimeoutMs = options.acquireTimeoutMs ?? 5000;
    this.#healthCheck = options.healthCheck;
    this.#healthCheckIdleMs = options.healthCheckIdleMs ?? 10000;

    assertNonNegativeInteger(this.#minConnections, "minConnections");
    assertPositiveInteger(this.#maxConnections, "maxConnections");
    assertNonNegativeFinite(this.#idleTimeoutMs, "idleTimeoutMs");
    assertNonNegativeFinite(this.#acquireTimeoutMs, "acquireTimeoutMs");
    assertNonNegativeFinite(this.#healthCheckIdleMs, "healthCheckIdleMs");

    if (this.#minConnections > this.#maxConnections) {
      throw new SessionError(
        "minConnections must not exceed maxConnections",
      );
    }

    if (this.#minConnections > 0) {
      this.#warmupRequested = this.#minConnections;
      this.#warmupComplete = this.#warmUp();
    } else {
      this.#warmupComplete = Promise.resolve();
    }
  }

  /**
   * Current pool statistics.
   */
  get stats(): RpcConnectionPoolStats {
    return {
      total: this.#idle.size + this.#active.size,
      idle: this.#idle.size,
      active: this.#active.size,
      pending: this.#pending.length - this.#pendingSettled,
    };
  }

  /**
   * Returns a promise that resolves when all warm-up connections have been
   * established (or attempted). If `minConnections` is 0 the returned
   * promise is already resolved.
   *
   * **Important**: Warm-up is best-effort. Individual warm-up failures do not
   * cause the promise to reject. Connections that fail during warm-up are
   * silently skipped and will be created on demand via {@link acquire}.
   * After `whenReady()` resolves, use {@link warmupStats} to inspect how
   * many warm-up connections succeeded vs. failed.
   */
  whenReady(): Promise<void> {
    return this.#warmupComplete;
  }

  /**
   * Returns warm-up statistics showing how many warm-up connections were
   * requested, succeeded, and failed.
   *
   * This is useful for inspecting warm-up results after {@link whenReady}
   * resolves, since warm-up failures are silently ignored (best-effort).
   */
  warmupStats(): RpcConnectionPoolWarmupStats {
    return {
      requested: this.#warmupRequested,
      succeeded: this.#warmupSucceeded,
      failed: this.#warmupFailed,
    };
  }

  /**
   * Acquire a connection from the pool.
   *
   * If an idle connection is available it is returned immediately. If the pool
   * has capacity, a new connection is created. Otherwise the call blocks until
   * a connection is released or the acquire timeout expires.
   *
   * @returns A pooled connection.
   * @throws {SessionError} If the pool is closed, the acquire times out, or
   *   connection creation fails.
   */
  async acquire(): Promise<RpcClientTransportLike> {
    if (this.#closed) {
      throw new SessionError("connection pool is closed");
    }

    // Try to reuse an idle connection (Map iteration is insertion-ordered / FIFO).
    while (this.#idle.size > 0) {
      const { value: entry } = this.#idle.values().next() as {
        value: IdleEntry;
      };
      this.#idle.delete(entry.conn);
      clearTimeout(entry.timer);

      // If a health check is configured and the connection has been idle
      // longer than the threshold, validate it before handing it out.
      if (this.#healthCheck) {
        const idleDuration = Date.now() - entry.lastUsedAt;
        if (idleDuration >= this.#healthCheckIdleMs) {
          let healthy: boolean;
          try {
            healthy = await this.#healthCheck(entry.conn);
          } catch {
            healthy = false;
          }

          if (!healthy) {
            // Discard the unhealthy connection and try the next idle one.
            this.#closeConnection(entry.conn);
            continue;
          }
        }
      }

      this.#active.add(entry.conn);
      return entry.conn;
    }

    // Try to create a new connection if under the limit.
    if (this.#active.size < this.#maxConnections) {
      return await this.#createConnection();
    }

    // At capacity -- wait for a release.
    return await new Promise<RpcClientTransportLike>((resolve, reject) => {
      const entry: PendingAcquire = {
        resolve,
        reject,
        timer: setTimeout(() => {
          if (entry.settled) return;
          entry.settled = true;
          this.#pendingSettled++;
          reject(
            new SessionError(
              `connection pool acquire timed out after ${this.#acquireTimeoutMs}ms`,
            ),
          );
        }, this.#acquireTimeoutMs),
        settled: false,
      };
      this.#pending.push(entry);
    });
  }

  /**
   * Release a connection back to the pool.
   *
   * If there are pending acquire requests the connection is handed off
   * directly. Otherwise the connection is placed into the idle set with
   * an idle timeout timer.
   *
   * @param conn - The connection to release, which must have been obtained
   *   via {@link acquire}.
   */
  release(conn: RpcClientTransportLike): void {
    if (!this.#active.has(conn)) {
      return;
    }
    this.#active.delete(conn);

    if (this.#closed) {
      this.#closeConnection(conn);
      return;
    }

    // Hand off to a pending waiter if one exists, skipping any that
    // have already been settled (e.g. by a concurrent timeout).
    while (this.#pending.length > 0) {
      const waiter = this.#pending.shift()!;
      if (waiter.settled) {
        this.#pendingSettled--;
        continue;
      }
      waiter.settled = true;
      clearTimeout(waiter.timer);
      this.#active.add(conn);
      waiter.resolve(conn);
      this.#compactPending();
      return;
    }

    // Return to idle pool with a timeout.
    const timer = setTimeout(() => {
      this.#evictIdle(conn);
    }, this.#idleTimeoutMs);
    this.#idle.set(conn, { conn, timer, lastUsedAt: Date.now() });
  }

  /**
   * Close all connections in the pool and reject any pending acquire requests.
   *
   * After calling close, no further operations are allowed on the pool.
   * This method is idempotent -- multiple calls will reuse the same close
   * promise and only perform cleanup once.
   */
  async close(): Promise<void> {
    if (this.#closed) {
      // If already closed, return the existing close promise if available.
      return this.#closePromise ?? Promise.resolve();
    }
    this.#closed = true;

    // Store the close promise so subsequent calls can await it.
    this.#closePromise = this.#doClose();
    await this.#closePromise;
  }

  /**
   * Synchronous dispose implementation for use with `using` declarations.
   *
   * **Important limitation**: Because {@link Symbol.dispose} must be
   * synchronous, this method fires {@link close} in the background without
   * waiting for it to complete. The `#closed` flag is set synchronously
   * (by close()), preventing new acquires immediately, but the actual cleanup
   * (closing connections, rejecting pending requests, waiting for warm-up)
   * happens asynchronously. Resources may not be fully cleaned up when this
   * method returns.
   *
   * For proper async cleanup, use `await using` with {@link Symbol.asyncDispose}
   * or call {@link close} directly and await the result.
   */
  [Symbol.dispose](): void {
    // Fire close() in background without awaiting.
    // close() will set #closed immediately, preventing new acquires.
    void this.close();
  }

  /**
   * Async dispose implementation for use with `await using` declarations.
   *
   * This properly awaits the close operation, ensuring all connections are
   * closed and all pending requests are rejected before returning.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  async #doClose(): Promise<void> {
    // Wait for warm-up to finish so that any in-flight connections are
    // captured and cleaned up below rather than being created after close.
    await this.#warmupComplete;

    // Reject all pending acquires.
    const pendingCopy = this.#pending.splice(0);
    this.#pendingSettled = 0;
    for (const waiter of pendingCopy) {
      clearTimeout(waiter.timer);
      if (!waiter.settled) {
        waiter.reject(new SessionError("connection pool is closed"));
      }
    }

    // Close all idle connections.
    const idleCopy = [...this.#idle.values()];
    this.#idle.clear();
    const closePromises: Promise<void>[] = [];
    for (const entry of idleCopy) {
      clearTimeout(entry.timer);
      closePromises.push(this.#closeConnection(entry.conn));
    }

    // Close all active connections.
    const activeCopy = [...this.#active];
    this.#active.clear();
    for (const conn of activeCopy) {
      closePromises.push(this.#closeConnection(conn));
    }

    await Promise.all(closePromises);
  }

  async #createConnection(): Promise<RpcClientTransportLike> {
    try {
      const conn = await this.#connect();
      this.#active.add(conn);
      return conn;
    } catch (error) {
      // If creation failed and there is still capacity, try once more.
      // This handles transient failures without blocking callers indefinitely.
      throw new SessionError("connection pool: failed to create connection", {
        cause: error,
      });
    }
  }

  async #closeConnection(conn: RpcClientTransportLike): Promise<void> {
    if (!conn.close) return;
    try {
      await conn.close();
    } catch {
      // Swallow close errors -- best effort cleanup.
    }
  }

  #evictIdle(conn: RpcClientTransportLike): void {
    const entry = this.#idle.get(conn);
    if (!entry) return;
    this.#idle.delete(conn);
    clearTimeout(entry.timer);

    // Only close if we are above minConnections.
    const total = this.#idle.size + this.#active.size;
    if (total >= this.#minConnections) {
      this.#closeConnection(conn);
    } else {
      // Re-add with a fresh timer.
      const timer = setTimeout(() => {
        this.#evictIdle(conn);
      }, this.#idleTimeoutMs);
      this.#idle.set(conn, { conn, timer, lastUsedAt: entry.lastUsedAt });
    }
  }

  /**
   * Remove settled entries from the pending array when enough have
   * accumulated. This avoids unbounded growth while keeping the
   * common-case cost O(1).
   */
  #compactPending(): void {
    if (this.#pendingSettled < 16) return;
    this.#pending = this.#pending.filter((e) => !e.settled);
    this.#pendingSettled = 0;
  }

  async #warmUp(): Promise<void> {
    const count = this.#minConnections;
    const promises: Promise<void>[] = [];
    for (let i = 0; i < count; i++) {
      promises.push(
        this.#connect().then(
          (conn) => {
            this.#warmupSucceeded++;
            if (this.#closed) {
              this.#closeConnection(conn);
              return;
            }
            const timer = setTimeout(() => {
              this.#evictIdle(conn);
            }, this.#idleTimeoutMs);
            this.#idle.set(conn, { conn, timer, lastUsedAt: Date.now() });
          },
          () => {
            this.#warmupFailed++;
            // Warm-up failures are silently ignored -- connections will be
            // created on demand when acquire() is called.
          },
        ),
      );
    }
    await Promise.allSettled(promises);
  }
}

/**
 * Execute a function with a connection acquired from the pool.
 *
 * The connection is automatically released back to the pool after `fn`
 * completes. If `fn` throws, the connection is still released (the pool
 * can decide whether to keep or discard it).
 *
 * @param pool - The connection pool to acquire from.
 * @param fn - The function to execute with the acquired connection.
 * @returns The return value of `fn`.
 * @throws Rethrows any error from `fn` after releasing the connection.
 */
export async function withConnection<T>(
  pool: RpcConnectionPool,
  fn: (conn: RpcClientTransportLike) => Promise<T>,
): Promise<T> {
  const conn = await pool.acquire();
  try {
    const result = await fn(conn);
    pool.release(conn);
    return result;
  } catch (error) {
    pool.release(conn);
    throw error;
  }
}
