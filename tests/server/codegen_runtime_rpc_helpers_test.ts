import {
  connectAndBootstrap,
  type RpcBootstrapClientTransport,
  type RpcCallOptions,
} from "../../src/rpc/server/rpc_runtime.ts";
import type { CapabilityPointer } from "../../src/encoding/runtime.ts";
import { assertEquals } from "../test_utils.ts";

class MockBootstrapTransport implements RpcBootstrapClientTransport {
  closeCalls = 0;
  lastBootstrapOptions: RpcCallOptions | undefined;

  bootstrap(options?: RpcCallOptions): Promise<CapabilityPointer> {
    this.lastBootstrapOptions = options;
    return Promise.resolve({ capabilityIndex: 0 });
  }

  call(
    _capability: CapabilityPointer,
    _methodId: number,
    _params: Uint8Array,
    _options?: RpcCallOptions,
  ): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array());
  }

  close(): void {
    this.closeCalls += 1;
  }
}

Deno.test("connectAndBootstrap returns typed client with connected transport", async () => {
  const transport = new MockBootstrapTransport();

  const result = await connectAndBootstrap(
    () => Promise.resolve(transport),
    async (rpc, options) => {
      await rpc.bootstrap(options);
      return {
        ping(): number {
          return 42;
        },
      };
    },
    { timeoutMs: 25 },
  );

  assertEquals(result.transport, transport);
  assertEquals(result.client.ping(), 42);
  assertEquals(transport.closeCalls, 0);
  assertEquals(transport.lastBootstrapOptions?.timeoutMs, 25);
});

Deno.test("connectAndBootstrap closes transport when bootstrap factory throws", async () => {
  const transport = new MockBootstrapTransport();
  const expected = new Error("bootstrap failed");

  let thrown: unknown = undefined;
  try {
    await connectAndBootstrap(
      () => Promise.resolve(transport),
      () => {
        return Promise.reject(expected);
      },
    );
  } catch (error) {
    thrown = error;
  }

  assertEquals(thrown, expected);
  assertEquals(transport.closeCalls, 1);
});

Deno.test("connectAndBootstrap keeps original bootstrap error when close fails", async () => {
  const expected = new Error("bootstrap failed");
  const closeFailure = new Error("close failed");

  const transport: RpcBootstrapClientTransport = {
    bootstrap(): Promise<CapabilityPointer> {
      return Promise.resolve({ capabilityIndex: 0 });
    },
    call(): Promise<Uint8Array> {
      return Promise.resolve(new Uint8Array());
    },
    close(): Promise<void> {
      return Promise.reject(closeFailure);
    },
  };

  let thrown: unknown = undefined;
  try {
    await connectAndBootstrap(
      () => Promise.resolve(transport),
      () => {
        return Promise.reject(expected);
      },
    );
  } catch (error) {
    thrown = error;
  }

  assertEquals(thrown, expected);
});
