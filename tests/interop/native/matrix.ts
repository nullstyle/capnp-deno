import {
  CapnpError,
  CapnpFrameFramer,
  connect,
  type RpcStub,
  type RpcTransport,
  serve,
  serveConnection,
  TcpTransport,
} from "../../../src/advanced.ts";
import { assert, assertEquals, withTimeout } from "../../test_utils.ts";
import {
  BatchedCancellationTransport,
  CancellationAudit,
} from "./cancellation_audit.ts";
import {
  createDoublerServer,
  type Doubler,
  Interop,
  type InteropService,
} from "./gen/interop_types.ts";

// These programs are built by scripts/native_interop.ts from pinned sources.
const [zig, cpp] = Deno.args;
if (!zig || !cpp) throw new Error("matrix.ts needs Zig and C++ endpoint paths");

class PipeTransport implements RpcTransport {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #closed = false;
  #notified = false;
  #observers = new Set<() => void | Promise<void>>();
  #pending: Promise<void> = Promise.resolve();
  failure: unknown;

  constructor(child: Deno.ChildProcess) {
    this.#reader = child.stdout.getReader();
    this.#writer = child.stdin.getWriter();
  }
  start(onFrame: (frame: Uint8Array) => void | Promise<void>): void {
    this.#pending = this.#read(onFrame).catch((error) => {
      if (!this.#closed) this.failure = error;
    }).finally(() => this.#notify());
  }
  async #read(
    onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): Promise<void> {
    const framer = new CapnpFrameFramer({ maxFrameBytes: 2 * 1024 * 1024 });
    while (!this.#closed) {
      const { value, done } = await this.#reader.read();
      if (done) {
        assertEquals(
          framer.bufferedBytes(),
          0,
          "native peer truncated a frame",
        );
        return;
      }
      framer.push(value);
      let frame;
      while ((frame = framer.popFrame()) !== null) await onFrame(frame);
    }
  }
  send(frame: Uint8Array): Promise<void> {
    return this.#writer.write(frame);
  }
  subscribeClose(observer: () => void | Promise<void>): () => void {
    if (this.#notified) {
      void observer();
      return () => {};
    }
    this.#observers.add(observer);
    return () => {
      this.#observers.delete(observer);
    };
  }
  #notify(): void {
    if (this.#notified) return;
    this.#notified = true;
    this.#closed = true;
    for (const observer of this.#observers) void observer();
    this.#observers.clear();
  }
  async close(): Promise<void> {
    this.#closed = true;
    await this.#writer.close().catch(() => {});
    await this.#reader.cancel().catch(() => {});
    // Do not await #pending here: onFrame can initiate session teardown.
    this.#notify();
  }
  async drained(): Promise<void> {
    await this.#pending;
    if (this.failure) throw this.failure;
  }
}

function launch(
  binary: string,
  args: string[],
  pipes = false,
): Deno.ChildProcess {
  return new Deno.Command(binary, {
    args,
    stdin: pipes ? "piped" : "null",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
}

async function terminated(child: Deno.ChildProcess): Promise<void> {
  const status = await withTimeout(child.status, 10_000, "native process exit");
  assert(status.success, `native process exited ${status.code}`);
}

async function stop(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill("SIGKILL");
  } catch { /* already exited */ }
  await child.status;
}

async function consume(
  transport: RpcTransport,
  cooperative: boolean,
): Promise<void> {
  const audit = new CancellationAudit();
  const client = await connect(Interop, audit.wrap(transport, true));
  let callbacks = 0;
  const doubler: Doubler = {
    compute(value) {
      callbacks++;
      return Promise.resolve(value * 2);
    },
    fail() {
      return Promise.reject(new Error("InteropExpectedFailure"));
    },
    hold() {
      throw new Error("unexpected callback hold");
    },
    holdStatus() {
      throw new Error("unexpected callback holdStatus");
    },
  };
  try {
    assertEquals(await client.echo(41), 42);
    assertEquals(await client.invoke(doubler), 42);
    assertEquals(callbacks, 1);
    const child = await client.child();
    try {
      assertEquals(await child.compute(21), 42);
      const controller = new AbortController();
      let holdSettled = false;
      const hold = child.hold(doubler, { signal: controller.signal }).then(
        () => {
          holdSettled = true;
          return null;
        },
        (error: unknown) => {
          holdSettled = true;
          return error;
        },
      );
      const beforeCancellation = await child.holdStatus(false);
      assert(
        beforeCancellation.started && beforeCancellation.active &&
          !beforeCancellation.canceled,
      );
      assertEquals(
        holdSettled,
        false,
        "cancel only after remote confirms pending handler",
      );
      controller.abort();
      assert(
        await withTimeout(hold, 2_000, "pending RPC cancellation") !== null,
      );
      const afterCancellation = await child.holdStatus(true);
      assert(afterCancellation.started && !afterCancellation.active);
      assertEquals(afterCancellation.canceled, cooperative);
      assertEquals(
        await child.compute(21),
        42,
        "same capability recovers after cancellation",
      );
      let thrown: unknown;
      try {
        await child.fail();
      } catch (error) {
        thrown = error;
      }
      assert(
        thrown instanceof CapnpError,
        `expected typed remote error: ${thrown}`,
      );
      assert(String(thrown).includes("InteropExpectedFailure"));
      assertEquals(await child.compute(21), 42);
    } finally {
      await child.close();
    }
    let regularFailed = false;
    try {
      await client.fail();
    } catch (error) {
      regularFailed = String(error).includes("InteropExpectedFailure");
    }
    assert(regularFailed);
    assertEquals(await client.echo(41), 42);
    // Queue regular barrier before acknowledging the delayed stream items.
    const first = client.push(1);
    const second = client.push(2);
    const result = await client.barrier();
    await Promise.all([first, second]);
    assertEquals(result.sum, 3n);
    assertEquals(result.count, 2);
    audit.check();
  } finally {
    await client.close();
  }
}

function service(): { implementation: InteropService; check(): void } {
  let sum = 0n;
  let count = 0;
  let callbackCount = 0;
  let barrierSeen = false;
  let holdStarted = false;
  let holdActive = false;
  let holdCanceled = false;
  let holdCleanup: Promise<void> | undefined;
  const implementation: InteropService = {
    echo(value) {
      return value + 1;
    },
    async invoke(cap) {
      callbackCount++;
      try {
        return await cap.compute(21);
      } finally {
        if ("close" in cap) await cap.close();
      }
    },
    child(ctx) {
      // The non-streaming convenience adapter omits call contexts. Register
      // the generated dispatch directly to observe cancellation of this child.
      return ctx.exportCapability!(createDoublerServer({
        compute: ({ value }) => ({ value: value * 2 }),
        fail: () => {
          throw new Error("InteropExpectedFailure");
        },
        hold({ cap }, ctx) {
          assert(!holdStarted);
          assert(cap !== null);
          ctx.retainParamCaps!();
          holdStarted = true;
          holdActive = true;
          holdCleanup = (async () => {
            try {
              await new Promise<void>((resolve) => {
                ctx.signal.addEventListener("abort", () => {
                  holdCanceled = true;
                  resolve();
                }, { once: true });
              });
            } finally {
              await cap.close();
              holdActive = false;
            }
          })();
          return holdCleanup.then(() => ({}));
        },
        async holdStatus({ release }) {
          if (release) {
            await withTimeout(
              holdCleanup!,
              2_000,
              "remote pending handler cancellation",
            );
          }
          return {
            started: holdStarted,
            active: holdActive,
            canceled: holdCanceled,
          };
        },
      })) as unknown as RpcStub<Doubler>;
    },
    fail() {
      throw new Error("InteropExpectedFailure");
    },
    async push(value) {
      assertEquals(value, count + 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      count++;
      sum += BigInt(value);
    },
    barrier() {
      assertEquals(count, 2, "regular call overtook stream completion");
      barrierSeen = true;
      return { sum, count };
    },
  };
  return {
    implementation,
    check() {
      assertEquals(sum, 3n);
      assertEquals(count, 2);
      assertEquals(callbackCount, 1);
      assert(barrierSeen);
      assert(holdStarted && holdCanceled && !holdActive);
    },
  };
}

async function denoToZig(): Promise<void> {
  const child = launch(zig, ["server"], true);
  const transport = new PipeTransport(child);
  try {
    await consume(transport, false);
    await terminated(child);
    await transport.drained();
  } finally {
    await transport.close();
    await stop(child);
  }
}

async function zigToDeno(): Promise<void> {
  const child = launch(zig, ["client"], true);
  const transport = new PipeTransport(child);
  const state = service();
  const audit = new CancellationAudit();
  const handle = await serveConnection(
    Interop,
    { transport: audit.wrap(transport, false) },
    state.implementation,
  );
  try {
    await terminated(child);
    await transport.drained();
    state.check();
    audit.check();
  } finally {
    await handle.close();
    await transport.close();
    await stop(child);
  }
  assertEquals(handle.stats.activeConnections, 0);
  assert(handle.closed);
}

async function cppToDeno(): Promise<void> {
  const listener = TcpTransport.listen({ port: 0, hostname: "127.0.0.1" });
  const address = listener.addr as Deno.NetAddr;
  const state = service();
  const audit = new CancellationAudit();
  const handle = serve(Interop, {
    get closed() {
      return listener.closed;
    },
    close: () => listener.close(),
    async *accept() {
      for await (const accepted of listener.accept()) {
        yield { transport: audit.wrap(accepted.transport, false) };
      }
    },
  }, state.implementation);
  const child = launch(cpp, ["client", `127.0.0.1:${address.port}`]);
  try {
    await terminated(child);
    state.check();
    audit.check();
  } finally {
    await handle.close();
    await stop(child);
  }
  assertEquals(handle.stats.activeConnections, 0);
  assert(handle.closed);
}

async function denoToCpp(): Promise<void> {
  const child = launch(cpp, ["server"]);
  try {
    const reader = child.stdout.getReader();
    const first = await withTimeout(reader.read(), 10_000, "C++ listen port");
    assert(first.value !== undefined && !first.done);
    let line = new TextDecoder().decode(first.value);
    while (!line.includes("\n")) {
      const next = await reader.read();
      assert(!next.done);
      line += new TextDecoder().decode(next.value);
    }
    reader.releaseLock();
    const port = Number(line.trim());
    assert(Number.isInteger(port) && port > 0 && port <= 65535);
    const transport = new BatchedCancellationTransport(
      await TcpTransport.connect("127.0.0.1", port),
    );
    await consume(transport, true);
    transport.check();
    await terminated(child);
  } finally {
    await stop(child);
  }
}

for (
  const [label, run] of [
    ["Deno → native Zig (framed pipes)", denoToZig],
    ["native Zig → Deno (framed pipes)", zigToDeno],
    ["Deno → native C++ (TCP)", denoToCpp],
    ["native C++ → Deno (TCP)", cppToDeno],
  ] as const
) {
  if (Deno.args[2] === "cpp-only" && !label.includes("C++")) continue;
  await withTimeout(run(), 20_000, label);
  console.log(
    `${label}: unary, callback, returned cap, pending cancellation/Finish/Release, error recovery, stream barrier, cleanup passed`,
  );
}
