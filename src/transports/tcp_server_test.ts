import {
  TcpServerListener,
  TcpTransport,
} from "./tcp.ts";
import { assert, assertEquals, withTimeout } from "../../tests/test_utils.ts";

Deno.test("TcpServerListener binds and exposes addr", () => {
  const listener = new TcpServerListener({ port: 0, hostname: "127.0.0.1" });
  try {
    const addr = listener.addr as Deno.NetAddr;
    assertEquals(addr.transport, "tcp");
    assertEquals(addr.hostname, "127.0.0.1");
    assert(addr.port > 0, "expected a bound port > 0");
  } finally {
    listener.close();
  }
});

Deno.test("TcpServerListener.close is idempotent", () => {
  const listener = new TcpServerListener({ port: 0, hostname: "127.0.0.1" });
  listener.close();
  // Second close should not throw.
  listener.close();
});

Deno.test("TcpServerListener.accept yields TcpTransport for each connection", async () => {
  const listener = new TcpServerListener({ port: 0, hostname: "127.0.0.1" });
  const addr = listener.addr as Deno.NetAddr;

  const accepted: TcpTransport[] = [];
  const acceptLoop = (async () => {
    for await (const transport of listener.accept()) {
      accepted.push(transport);
      if (accepted.length >= 2) {
        break;
      }
    }
  })();

  // Connect two clients.
  const client1 = await TcpTransport.connect("127.0.0.1", addr.port);
  const client2 = await TcpTransport.connect("127.0.0.1", addr.port);

  await withTimeout(acceptLoop, 5000, "accept loop");

  assertEquals(accepted.length, 2);
  assert(accepted[0] instanceof TcpTransport, "expected TcpTransport instance");
  assert(accepted[1] instanceof TcpTransport, "expected TcpTransport instance");

  // Clean up all connections.
  await client1.close();
  await client2.close();
  await accepted[0].close();
  await accepted[1].close();
  listener.close();
});

Deno.test("TcpServerListener.accept terminates when listener is closed", async () => {
  const listener = new TcpServerListener({ port: 0, hostname: "127.0.0.1" });

  const acceptLoop = (async () => {
    const results: TcpTransport[] = [];
    for await (const transport of listener.accept()) {
      results.push(transport);
    }
    return results;
  })();

  // Close the listener while accept is waiting.
  // Small delay to ensure accept() is blocked on listener.accept().
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  listener.close();

  const results = await withTimeout(acceptLoop, 5000, "accept loop after close");
  assertEquals(results.length, 0);
});

Deno.test("TcpServerListener passes transportOptions to accepted transports", async () => {
  const transportOptions = { readBufferSize: 1024 };
  const listener = new TcpServerListener({
    port: 0,
    hostname: "127.0.0.1",
    transportOptions,
  });
  const addr = listener.addr as Deno.NetAddr;

  const acceptLoop = (async () => {
    for await (const transport of listener.accept()) {
      return transport;
    }
    return null;
  })();

  const client = await TcpTransport.connect("127.0.0.1", addr.port);
  const serverTransport = await withTimeout(acceptLoop, 5000, "accept single");

  assert(serverTransport !== null, "expected a transport to be yielded");
  assertEquals(serverTransport!.options.readBufferSize, 1024);

  await client.close();
  await serverTransport!.close();
  listener.close();
});

Deno.test("TcpServerListener emits observability events", () => {
  const events: string[] = [];
  const observability = {
    onEvent(event: { name: string }) {
      events.push(event.name);
    },
  };

  const listener = new TcpServerListener({
    port: 0,
    hostname: "127.0.0.1",
    observability,
  });

  assert(events.includes("rpc.transport.tcp.listen"), "expected listen event");

  listener.close();

  assert(
    events.includes("rpc.transport.tcp.listen_close"),
    "expected listen_close event",
  );
});

Deno.test("TcpServerListener emits accept observability event", async () => {
  const events: string[] = [];
  const observability = {
    onEvent(event: { name: string }) {
      events.push(event.name);
    },
  };

  const listener = new TcpServerListener({
    port: 0,
    hostname: "127.0.0.1",
    observability,
  });
  const addr = listener.addr as Deno.NetAddr;

  const acceptLoop = (async () => {
    for await (const transport of listener.accept()) {
      return transport;
    }
    return null;
  })();

  const client = await TcpTransport.connect("127.0.0.1", addr.port);
  const serverTransport = await withTimeout(acceptLoop, 5000, "accept single");

  assert(
    events.includes("rpc.transport.tcp.accept"),
    "expected accept event",
  );

  await client.close();
  await serverTransport!.close();
  listener.close();
});
