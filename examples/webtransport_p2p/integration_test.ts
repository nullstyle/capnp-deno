import { assert, assertEquals, withTimeout } from "../../tests/test_utils.ts";
import { PeerRuntime } from "./runtime.ts";
import {
  DEMO_CERT_HASH,
  DEMO_CERT_PEM,
  DEMO_KEY_PEM,
  formatHex,
} from "./shared.ts";

function isWebTransportAvailable(): boolean {
  return typeof WebTransport !== "undefined" &&
    "QuicEndpoint" in Deno &&
    "upgradeWebTransport" in Deno;
}

function createRuntime(name: string, port: number): PeerRuntime {
  return new PeerRuntime({
    name,
    host: "127.0.0.1",
    port,
    path: "/p2p",
    tls: {
      certPem: DEMO_CERT_PEM,
      keyPem: DEMO_KEY_PEM,
      certHash: new Uint8Array(DEMO_CERT_HASH),
      certHashHex: formatHex(DEMO_CERT_HASH),
    },
  });
}

async function getFreePort(): Promise<number> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  try {
    return (listener.addr as Deno.NetAddr).port;
  } finally {
    listener.close();
  }
}

async function waitFor(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 5_000) {
      throw new Error(`${label} timed out`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

Deno.test("PeerRuntime auto-connects back so both peers can chat", async () => {
  if (!isWebTransportAvailable()) {
    return;
  }

  const alicePort = await getFreePort();
  const bobPort = await getFreePort();
  const alice = createRuntime("alice", alicePort);
  const bob = createRuntime("bob", bobPort);
  const aliceLogs: string[] = [];
  const bobLogs: string[] = [];

  alice.print = (message: string): void => {
    aliceLogs.push(message);
  };
  bob.print = (message: string): void => {
    bobLogs.push(message);
  };

  await alice.start();
  await bob.start();
  try {
    await bob.connect(alice.listenUrl);
    await alice.broadcast("hello from alice");
    await withTimeout(
      waitFor(
        () => bobLogs.some((line) => line.includes("alice: hello from alice")),
        "reverse chat delivery",
      ),
      6_000,
      "reverse chat delivery",
    );

    assertEquals(
      bobLogs.some((line) => line.includes("alice: hello from alice")),
      true,
    );
    assertEquals(
      aliceLogs.some((line) =>
        line.includes("connected to bob @ https://127.0.0.1:")
      ),
      true,
    );
  } finally {
    await bob.close();
    await alice.close();
  }
});
