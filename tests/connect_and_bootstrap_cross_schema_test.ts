import {
  connectAndBootstrap,
  InMemoryRpcHarnessTransport,
  RpcServerRuntime,
  SessionRpcClientTransport,
} from "../src/mod.ts";
import {
  bootstrapPingerClient,
  registerPingerServer,
} from "./fixtures/generated/typegate_fixture_rpc.ts";
import {
  bootstrapPingerClient as bootstrapPingExampleClient,
  PingerInterfaceId as PingExampleInterfaceId,
  registerPingerServer as registerPingExampleServer,
} from "../examples/ping/gen/schema_types.ts";
import { PingerInterfaceId } from "./fixtures/generated/typegate_fixture_rpc.ts";
import { assertEquals } from "./test_utils.ts";

interface RuntimeWithClientTransport {
  runtime: RpcServerRuntime;
  clientTransport: SessionRpcClientTransport;
}

async function createPingExampleFlow(): Promise<RuntimeWithClientTransport> {
  const transport = new InMemoryRpcHarnessTransport();
  const runtime = await RpcServerRuntime.createWithRoot(
    transport,
    registerPingExampleServer,
    {
      ping() {
        return {};
      },
    },
    { autoStart: true },
  );

  const clientTransport = new SessionRpcClientTransport(
    runtime.session,
    transport,
    {
      interfaceId: PingExampleInterfaceId,
      autoStart: false,
    },
  );

  return { runtime, clientTransport };
}

async function createPingerFlow(): Promise<RuntimeWithClientTransport> {
  const transport = new InMemoryRpcHarnessTransport();
  const runtime = await RpcServerRuntime.createWithRoot(
    transport,
    registerPingerServer,
    {
      ping() {
        return {};
      },
    },
    { autoStart: true },
  );

  const clientTransport = new SessionRpcClientTransport(
    runtime.session,
    transport,
    {
      interfaceId: PingerInterfaceId,
      autoStart: false,
    },
  );

  return { runtime, clientTransport };
}

Deno.test("connectAndBootstrap composes cleanly across generated schemas", async () => {
  const pingExampleFlow = await createPingExampleFlow();
  const pingerFlow = await createPingerFlow();

  try {
    const { client: pingExample } = await connectAndBootstrap(
      () => Promise.resolve(pingExampleFlow.clientTransport),
      bootstrapPingExampleClient,
    );
    const { client: pinger } = await connectAndBootstrap(
      () => Promise.resolve(pingerFlow.clientTransport),
      bootstrapPingerClient,
    );

    const pingExampleResult = await pingExample.ping({ p: null });
    assertEquals(typeof pingExampleResult, "object");

    const pingResult = await pinger.ping({});
    assertEquals(typeof pingResult, "object");
  } finally {
    await pingExampleFlow.runtime.close();
    await pingerFlow.runtime.close();
  }
});
