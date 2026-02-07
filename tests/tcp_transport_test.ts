import { TcpTransport } from "../mod.ts";
import { assert, assertEquals, deferred, withTimeout } from "./test_utils.ts";

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
