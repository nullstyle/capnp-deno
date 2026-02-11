import { TcpTransport, TransportError } from "../../advanced.ts";
import { assert, assertEquals, deferred, withTimeout } from "../test_utils.ts";

interface FakeConnOptions {
  read?: (buffer: Uint8Array) => Promise<number | null> | number | null;
  write?: (buffer: Uint8Array) => Promise<number> | number;
}

function buildFrame(words: number): Uint8Array {
  const frame = new Uint8Array(8 + words * 8);
  const view = new DataView(frame.buffer);
  view.setUint32(0, 0, true);
  view.setUint32(4, words, true);
  return frame;
}

function createFakeConn(options: FakeConnOptions = {}): {
  conn: Deno.Conn;
  writes: Uint8Array[];
  getReadDeadlineCalls: () => number;
  getCloseCalls: () => number;
} {
  const writes: Uint8Array[] = [];
  let readDeadlineCalls = 0;
  let closeCalls = 0;

  const addr = {
    transport: "tcp",
    hostname: "127.0.0.1",
    port: 9000,
  } as Deno.NetAddr;

  const conn = {
    rid: 1,
    localAddr: addr,
    remoteAddr: addr,
    read(buffer: Uint8Array): Promise<number | null> {
      if (options.read) {
        return Promise.resolve(options.read(buffer));
      }
      return Promise.resolve(null);
    },
    write(buffer: Uint8Array): Promise<number> {
      const copy = new Uint8Array(buffer);
      writes.push(copy);
      if (options.write) {
        return Promise.resolve(options.write(copy));
      }
      return Promise.resolve(copy.byteLength);
    },
    close(): void {
      closeCalls += 1;
    },
    closeWrite(): Promise<void> {
      return Promise.resolve();
    },
    setDeadline(): void {
      // no-op
    },
    setReadDeadline(): void {
      readDeadlineCalls += 1;
    },
    setWriteDeadline(): void {
      // no-op
    },
  } as unknown as Deno.Conn;

  return {
    conn,
    writes,
    getReadDeadlineCalls: () => readDeadlineCalls,
    getCloseCalls: () => closeCalls,
  };
}

async function withPatchedDenoConnect(
  connectImpl: unknown,
  fn: () => Promise<void>,
): Promise<void> {
  const denoMutable = Deno as unknown as { connect?: typeof Deno.connect };
  const original = denoMutable.connect;
  if (connectImpl === undefined) {
    delete denoMutable.connect;
  } else {
    denoMutable.connect = connectImpl as typeof Deno.connect;
  }
  try {
    await fn();
  } finally {
    if (original === undefined) {
      delete denoMutable.connect;
    } else {
      denoMutable.connect = original;
    }
  }
}

Deno.test("TcpTransport enforces maxQueuedOutboundFrames under backpressure", async () => {
  const firstWrite = deferred<number>();
  let writeCalls = 0;
  const fake = createFakeConn({
    write(_buffer) {
      writeCalls += 1;
      if (writeCalls === 1) {
        return firstWrite.promise;
      }
      return 1;
    },
  });

  const transport = new TcpTransport(fake.conn, {
    maxQueuedOutboundFrames: 1,
  });

  try {
    transport.start((_frame) => {});

    const firstSend = transport.send(new Uint8Array([0x01]));

    let thrown: unknown;
    try {
      await transport.send(new Uint8Array([0x02]));
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof Error &&
        /outbound queue frame limit exceeded/i.test(thrown.message),
      `expected queue frame limit error, got: ${String(thrown)}`,
    );

    firstWrite.resolve(1);
    await firstSend;
    assertEquals(fake.writes.length >= 1, true);
  } finally {
    await transport.close();
  }
});

Deno.test("TcpTransport enforces sendTimeoutMs", async () => {
  const neverWrite = deferred<number>();
  const fake = createFakeConn({
    write(_buffer) {
      return neverWrite.promise;
    },
  });

  const transport = new TcpTransport(fake.conn, {
    sendTimeoutMs: 20,
  });

  try {
    transport.start((_frame) => {});

    let thrown: unknown;
    try {
      await transport.send(new Uint8Array([0xaa]));
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof Error && /send timed out/i.test(thrown.message),
      `expected send timeout error, got: ${String(thrown)}`,
    );
  } finally {
    await transport.close();
    neverWrite.resolve(1);
  }
});

Deno.test("TcpTransport converts read idle timeout failures", async () => {
  const seenError = deferred<unknown>();
  const fake = createFakeConn({
    read(_buffer) {
      throw new Deno.errors.TimedOut("timed out");
    },
  });

  const transport = new TcpTransport(fake.conn, {
    readIdleTimeoutMs: 10,
    onError: (error) => seenError.resolve(error),
  });

  try {
    transport.start((_frame) => {});
    const err = await withTimeout(
      seenError.promise,
      1000,
      "tcp read idle error",
    );

    assert(
      err instanceof Error &&
        /read idle timeout/i.test(err.message),
      `expected read idle timeout error, got: ${String(err)}`,
    );

    assertEquals(fake.getReadDeadlineCalls() > 0, true);
  } finally {
    await transport.close();
    assertEquals(fake.getCloseCalls() > 0, true);
  }
});

Deno.test("TcpTransport validates inbound frameLimits", async () => {
  const seenError = deferred<unknown>();
  const frame = buildFrame(2);
  let readCount = 0;
  const fake = createFakeConn({
    read(buffer) {
      if (readCount > 0) return null;
      readCount += 1;
      buffer.set(frame);
      return frame.byteLength;
    },
  });

  const transport = new TcpTransport(fake.conn, {
    frameLimits: {
      maxTraversalWords: 1,
    },
    onError: (error) => seenError.resolve(error),
  });

  try {
    transport.start((_frame) => {});
    const err = await withTimeout(
      seenError.promise,
      1000,
      "tcp frame limits error callback",
    );
    assert(
      err instanceof Error &&
        /traversal words .* exceeds configured limit/i.test(err.message),
      `expected frame limits error, got: ${String(err)}`,
    );
  } finally {
    await transport.close();
  }
});

Deno.test("TcpTransport.connect fails when Deno.connect is unavailable", async () => {
  await withPatchedDenoConnect(undefined, async () => {
    let thrown: unknown;
    try {
      await TcpTransport.connect("127.0.0.1", 9000);
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof TransportError &&
        /Deno\.connect is unavailable/i.test(thrown.message),
      `expected unavailable connect TransportError, got: ${String(thrown)}`,
    );
  });
});

Deno.test("TcpTransport.connect normalizes dial failures", async () => {
  await withPatchedDenoConnect(
    () => Promise.reject(new Error("dial exploded")),
    async () => {
      let thrown: unknown;
      try {
        await TcpTransport.connect("127.0.0.1", 9001);
      } catch (error) {
        thrown = error;
      }

      assert(
        thrown instanceof TransportError &&
          /tcp connect failed/i.test(thrown.message) &&
          /dial exploded/i.test(thrown.message),
        `expected normalized dial failure, got: ${String(thrown)}`,
      );
    },
  );
});

Deno.test("TcpTransport.connect times out and closes late successful dials", async () => {
  const dial = deferred<Deno.Conn>();
  const fake = createFakeConn();

  await withPatchedDenoConnect(() => dial.promise, async () => {
    const connectPromise = TcpTransport.connect("127.0.0.1", 9002, {
      connectTimeoutMs: 10,
    }).then((transport) => ({ ok: true as const, transport })).catch((
      error,
    ) => ({
      ok: false as const,
      error,
    }));

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    dial.resolve(fake.conn);

    const result = await connectPromise;
    const thrown = result.ok ? undefined : result.error;

    assert(
      thrown instanceof TransportError &&
        /connect timed out/i.test(thrown.message),
      `expected timeout error, got: ${String(thrown)}`,
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assertEquals(fake.getCloseCalls() > 0, true);
  });
});

Deno.test("TcpTransport validates start/send lifecycle guards", async () => {
  const fake = createFakeConn();
  const transport = new TcpTransport(fake.conn);

  let notStartedErr: unknown;
  try {
    await transport.send(new Uint8Array([0x01]));
  } catch (error) {
    notStartedErr = error;
  }
  assert(
    notStartedErr instanceof TransportError &&
      /not started/i.test(notStartedErr.message),
    `expected send-before-start error, got: ${String(notStartedErr)}`,
  );

  transport.start((_frame) => {});
  let alreadyStartedErr: unknown;
  try {
    transport.start((_frame) => {});
  } catch (error) {
    alreadyStartedErr = error;
  }
  assert(
    alreadyStartedErr instanceof TransportError &&
      /already started/i.test(alreadyStartedErr.message),
    `expected start-twice error, got: ${String(alreadyStartedErr)}`,
  );

  await transport.close();
  let closedStartErr: unknown;
  try {
    transport.start((_frame) => {});
  } catch (error) {
    closedStartErr = error;
  }
  assert(
    closedStartErr instanceof TransportError &&
      /is closed/i.test(closedStartErr.message),
    `expected start-after-close error, got: ${String(closedStartErr)}`,
  );
});

Deno.test("TcpTransport enforces maxQueuedOutboundBytes under backpressure", async () => {
  const firstWrite = deferred<number>();
  let writeCalls = 0;
  const fake = createFakeConn({
    write() {
      writeCalls += 1;
      if (writeCalls === 1) return firstWrite.promise;
      return 1;
    },
  });

  const transport = new TcpTransport(fake.conn, {
    maxQueuedOutboundBytes: 2,
  });

  try {
    transport.start((_frame) => {});
    const first = transport.send(new Uint8Array([0xaa, 0xbb]));

    let thrown: unknown;
    try {
      await transport.send(new Uint8Array([0xcc]));
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof TransportError &&
        /queue byte limit exceeded/i.test(thrown.message),
      `expected queue byte limit error, got: ${String(thrown)}`,
    );

    firstWrite.resolve(2);
    await first;
  } finally {
    await transport.close();
  }
});

Deno.test("TcpTransport rejects invalid write results", async () => {
  const fake = createFakeConn({
    write() {
      return 0;
    },
  });
  const transport = new TcpTransport(fake.conn);

  try {
    transport.start((_frame) => {});
    let thrown: unknown;
    try {
      await transport.send(new Uint8Array([0x01]));
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof TransportError &&
        /invalid tcp write result/i.test(thrown.message),
      `expected invalid write result error, got: ${String(thrown)}`,
    );
  } finally {
    await transport.close();
  }
});

Deno.test("TcpTransport normalizes non-timeout read failures", async () => {
  const seenError = deferred<unknown>();
  const fake = createFakeConn({
    read() {
      throw new Error("read exploded");
    },
  });
  const transport = new TcpTransport(fake.conn, {
    onError: (error) => seenError.resolve(error),
  });

  try {
    transport.start((_frame) => {});
    const err = await withTimeout(seenError.promise, 1000, "tcp read failure");
    assert(
      err instanceof TransportError &&
        /tcp read failed/i.test(err.message) &&
        /read exploded/i.test(err.message),
      `expected normalized read failure, got: ${String(err)}`,
    );
  } finally {
    await transport.close();
  }
});

Deno.test("TcpTransport treats connection-reset read failures as remote close", async () => {
  let onErrorCalls = 0;
  const fake = createFakeConn({
    read() {
      throw new Error("Connection reset by peer (os error 54)");
    },
  });
  const transport = new TcpTransport(fake.conn, {
    onError: () => {
      onErrorCalls += 1;
    },
  });

  transport.start((_frame) => {});
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assertEquals(onErrorCalls, 0);
  await transport.close();
});

Deno.test("TcpTransport invokes onClose exactly once on remote disconnect", async () => {
  let onCloseCalls = 0;
  let onErrorCalls = 0;
  const fake = createFakeConn({
    read() {
      return null;
    },
  });
  const transport = new TcpTransport(fake.conn, {
    onClose: () => {
      onCloseCalls += 1;
    },
    onError: () => {
      onErrorCalls += 1;
    },
  });

  transport.start((_frame) => {});
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assertEquals(onCloseCalls, 1);
  assertEquals(onErrorCalls, 0);

  await transport.close();
  assertEquals(onCloseCalls, 1);
});

Deno.test("TcpTransport enforces maxOutboundFrameBytes", async () => {
  const fake = createFakeConn();
  const transport = new TcpTransport(fake.conn, {
    maxOutboundFrameBytes: 2,
  });

  try {
    transport.start((_frame) => {});
    let thrown: unknown;
    try {
      await transport.send(new Uint8Array([0x01, 0x02, 0x03]));
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof TransportError &&
        /outbound frame size 3 exceeds configured limit 2/i.test(
          thrown.message,
        ),
      `expected outbound frame size error, got: ${String(thrown)}`,
    );
  } finally {
    await transport.close();
  }
});

Deno.test("TcpTransport treats timed-out error messages as idle timeout failures", async () => {
  const seenError = deferred<unknown>();
  const fake = createFakeConn({
    read() {
      throw new Error("operation timed out");
    },
  });

  const transport = new TcpTransport(fake.conn, {
    readIdleTimeoutMs: 10,
    onError: (error) => seenError.resolve(error),
  });

  try {
    transport.start((_frame) => {});
    const err = await withTimeout(
      seenError.promise,
      1000,
      "tcp read timeout string error",
    );
    assert(
      err instanceof Error &&
        /read idle timeout/i.test(err.message),
      `expected read idle timeout from timeout-shaped error, got: ${
        String(err)
      }`,
    );
  } finally {
    await transport.close();
  }
});

Deno.test("TcpTransport rejects send after close", async () => {
  const fake = createFakeConn();
  const transport = new TcpTransport(fake.conn);

  transport.start((_frame) => {});
  await transport.close();

  let thrown: unknown;
  try {
    await transport.send(new Uint8Array([0x01]));
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof TransportError &&
      /is closed/i.test(thrown.message),
    `expected send-after-close error, got: ${String(thrown)}`,
  );
});

Deno.test("TcpTransport close timeout path tolerates conn.close failures", async () => {
  const neverRead = deferred<number | null>();
  const fake = createFakeConn({
    read() {
      return neverRead.promise;
    },
  });
  const closeThrowingConn = {
    ...fake.conn,
    close() {
      throw new Error("close exploded");
    },
  } as Deno.Conn;

  const transport = new TcpTransport(closeThrowingConn, {
    closeTimeoutMs: 10,
  });
  transport.start((_frame) => {});

  await withTimeout(transport.close(), 1000, "tcp close timeout path");
  neverRead.resolve(null);
});

Deno.test("TcpTransport propagates send failures through onError and rejects queued frames", async () => {
  const seenErrors: unknown[] = [];
  const fake = createFakeConn({
    write() {
      return Promise.reject(new Error("send exploded"));
    },
  });

  const transport = new TcpTransport(fake.conn, {
    onError: (error) => {
      seenErrors.push(error);
    },
  });

  try {
    transport.start((_frame) => {});
    const first = transport.send(new Uint8Array([0x01]));
    const second = transport.send(new Uint8Array([0x02]));

    let firstErr: unknown;
    let secondErr: unknown;
    try {
      await first;
    } catch (error) {
      firstErr = error;
    }
    try {
      await second;
    } catch (error) {
      secondErr = error;
    }

    assert(
      firstErr instanceof TransportError &&
        /tcp send failed/i.test(firstErr.message),
      `expected first queued send to fail, got: ${String(firstErr)}`,
    );
    assert(
      secondErr instanceof TransportError &&
        /tcp send failed/i.test(secondErr.message),
      `expected queued send rejection after drain failure, got: ${
        String(secondErr)
      }`,
    );

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 1000;
        const tick = (): void => {
          if (seenErrors.length > 0) {
            resolve();
            return;
          }
          if (Date.now() >= deadline) {
            reject(new Error("tcp onError callback was not invoked"));
            return;
          }
          setTimeout(tick, 5);
        };
        tick();
      }),
      1100,
      "tcp onError callback",
    );
  } finally {
    await transport.close();
  }
});

Deno.test("TcpTransport connect timeout tolerates late dial close failures", async () => {
  const lateConn = createFakeConn();
  const dial = deferred<Deno.Conn>();

  const closeThrowingConn = {
    ...lateConn.conn,
    close() {
      throw new Error("late close exploded");
    },
  } as Deno.Conn;

  await withPatchedDenoConnect(() => dial.promise, async () => {
    const pending = TcpTransport.connect("127.0.0.1", 9010, {
      connectTimeoutMs: 10,
    }).then((transport) => ({ ok: true as const, transport })).catch((
      error,
    ) => ({
      ok: false as const,
      error,
    }));

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    dial.resolve(closeThrowingConn);

    const timedOut = await pending;
    const thrown = timedOut.ok ? undefined : timedOut.error;
    assert(
      thrown instanceof TransportError &&
        /connect timed out/i.test(thrown.message),
      `expected timeout with late close handling, got: ${String(thrown)}`,
    );
  });
});

Deno.test("TcpTransport.connect succeeds without timeout when dial resolves", async () => {
  const fake = createFakeConn();

  await withPatchedDenoConnect(
    () => Promise.resolve(fake.conn),
    async () => {
      const transport = await TcpTransport.connect("127.0.0.1", 9020);
      await transport.close();
    },
  );

  assertEquals(fake.getCloseCalls() > 0, true);
});

Deno.test("TcpTransport.connect with timeout still normalizes immediate dial failures", async () => {
  await withPatchedDenoConnect(
    () => {
      const failed = Promise.reject(
        new Error("timeout-mode dial exploded"),
      ) as Promise<Deno.Conn>;
      void failed.catch(() => {
        // local no-op to avoid unhandled rejection races in test scaffolding
      });
      return failed;
    },
    async () => {
      let thrown: unknown;
      try {
        await TcpTransport.connect("127.0.0.1", 9021, {
          connectTimeoutMs: 1000,
        });
      } catch (error) {
        thrown = error;
      }

      assert(
        thrown instanceof TransportError &&
          /tcp connect failed/i.test(thrown.message) &&
          /timeout-mode dial exploded/i.test(thrown.message),
        `expected timeout-mode connect normalization, got: ${String(thrown)}`,
      );
    },
  );
});

Deno.test("TcpTransport read loop tolerates zero-byte reads and continues", async () => {
  const seenFrames: Uint8Array[] = [];
  const frame = buildFrame(1);
  let readCount = 0;
  const fake = createFakeConn({
    read(buffer) {
      if (readCount === 0) {
        readCount += 1;
        return 0;
      }
      if (readCount === 1) {
        readCount += 1;
        buffer.set(frame);
        return frame.byteLength;
      }
      return null;
    },
  });
  const transport = new TcpTransport(fake.conn);

  try {
    transport.start((decoded) => {
      seenFrames.push(new Uint8Array(decoded));
    });
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 1000;
        const tick = (): void => {
          if (seenFrames.length > 0) {
            resolve();
            return;
          }
          if (Date.now() >= deadline) {
            reject(new Error("tcp zero-byte read continuation timed out"));
            return;
          }
          setTimeout(tick, 5);
        };
        tick();
      }),
      1100,
      "tcp zero-byte read continuation",
    );
    assertEquals(seenFrames.length, 1);
    assertEquals(seenFrames[0].byteLength, frame.byteLength);
  } finally {
    await transport.close();
  }
});

Deno.test("TcpTransport close is idempotent", async () => {
  const fake = createFakeConn();
  const transport = new TcpTransport(fake.conn);
  transport.start((_frame) => {});

  await transport.close();
  await transport.close();

  assertEquals(fake.getCloseCalls(), 1);
});

Deno.test("TcpTransport drain loop does not start duplicate loops under rapid send interleaving", async () => {
  // Simulate a write that yields to the event loop, creating a window where
  // a second send() could race with the .finally() block that resets the drain
  // loop state. With the #draining flag fix, only one drain loop should ever
  // be active at a time.
  let concurrentDrains = 0;
  let maxConcurrentDrains = 0;
  let writeCallCount = 0;

  const fake = createFakeConn({
    write(buffer) {
      writeCallCount += 1;
      concurrentDrains += 1;
      if (concurrentDrains > maxConcurrentDrains) {
        maxConcurrentDrains = concurrentDrains;
      }
      // Return a promise that yields to the event loop, giving send() a
      // chance to interleave and potentially start a second drain loop.
      return new Promise<number>((resolve) => {
        setTimeout(() => {
          concurrentDrains -= 1;
          resolve(buffer.byteLength);
        }, 1);
      });
    },
  });

  const transport = new TcpTransport(fake.conn);

  try {
    transport.start((_frame) => {});

    // Fire many sends rapidly without awaiting, so they all queue up and
    // each .finally() re-check could race with the next send() call.
    const sends: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      sends.push(transport.send(new Uint8Array([i])));
    }

    await Promise.all(sends);

    // All 20 frames should have been written exactly once each.
    assertEquals(writeCallCount, 20);
    // The drain loop should never have been running concurrently with itself.
    assertEquals(maxConcurrentDrains, 1);
  } finally {
    await transport.close();
  }
});
