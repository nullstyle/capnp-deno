import { RpcAcceptedTransportQueue } from "../../src/rpc/transports/internal/accept.ts";
import { assertEquals } from "../test_utils.ts";

Deno.test("RpcAcceptedTransportQueue.close closes buffered accepted transports", async () => {
  let closeCount = 0;

  function accepted(id: string) {
    return {
      id,
      transport: {
        start(): void {
          // no-op
        },
        send(): Promise<void> {
          return Promise.resolve();
        },
        close(): Promise<void> {
          closeCount += 1;
          return Promise.resolve();
        },
      },
    };
  }

  const queue = new RpcAcceptedTransportQueue();
  queue.push(accepted("one"));
  queue.push(accepted("two"));

  await queue.close();

  assertEquals(closeCount, 2);

  const seen: string[] = [];
  for await (const value of queue.accept()) {
    seen.push(value.id ?? "");
  }
  assertEquals(seen.length, 0);
});
