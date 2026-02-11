import { createRpcServiceToken, RpcPeer } from "../mod.ts";
import { assert, assertEquals } from "./test_utils.ts";

Deno.test("createRpcServiceToken returns a frozen token", () => {
  const token = createRpcServiceToken({
    interfaceId: 0x1234n,
    interfaceName: "Ping",
    bootstrapClient: () => Promise.resolve({ ping: () => Promise.resolve() }),
    registerServer: () => ({ capabilityIndex: 0 }),
  });

  assertEquals(token.interfaceId, 0x1234n);
  assertEquals(token.interfaceName, "Ping");
  assert(Object.isFrozen(token));
});

Deno.test("RpcPeer.close delegates to transport close", async () => {
  let closeCount = 0;
  const peer = new RpcPeer({
    role: "server",
    transport: {
      start() {},
      send() {},
      close() {
        closeCount += 1;
      },
    },
    remoteAddress: { hostname: "127.0.0.1", port: 4000, transport: "tcp" },
  });

  await peer.close();
  assertEquals(closeCount, 1);
  assertEquals(peer.toString(), "[RpcPeer server:127.0.0.1:4000]");
});
