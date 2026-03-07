import { RpcPeer, type RpcTransport } from "@nullstyle/capnp";
import { assert, assertEquals } from "../../tests/test_utils.ts";
import type { PeerEvents } from "./gen/mod.ts";
import { PeerRuntime } from "./runtime.ts";
import {
  DEFAULT_HOST,
  DEFAULT_PATH,
  DEFAULT_PORT,
  DEMO_CERT_HASH,
  DEMO_CERT_PEM,
  DEMO_KEY_PEM,
  formatHex,
} from "./shared.ts";

function createRuntime(): PeerRuntime {
  return new PeerRuntime({
    name: "node-a",
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    path: DEFAULT_PATH,
    tls: {
      certPem: DEMO_CERT_PEM,
      keyPem: DEMO_KEY_PEM,
      certHash: new Uint8Array(DEMO_CERT_HASH),
      certHashHex: formatHex(DEMO_CERT_HASH),
    },
  });
}

function createPeer(id: string): RpcPeer {
  const transport: RpcTransport = {
    start(): void {
      // no-op
    },
    send(): void {
      // no-op
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
  return new RpcPeer({
    role: "client",
    transport,
    id,
  });
}

function createEvents(log: string[]): PeerEvents {
  return {
    system(message: string): Promise<void> {
      log.push(`system:${message}`);
      return Promise.resolve();
    },
  };
}

function assertIncludes(haystack: string, needle: string): void {
  assert(
    haystack.includes(needle),
    `expected "${haystack}" to include "${needle}"`,
  );
}

Deno.test("PeerRuntime local commands work without a live transport", async () => {
  const runtime = createRuntime();
  const logs: string[] = [];
  runtime.print = (message: string): void => {
    logs.push(message);
  };

  assertEquals(runtime.listenUrl, "https://127.0.0.1:4443/p2p");

  await runtime.handleCommand("/listen");
  await runtime.handleCommand("/name node-b");
  await runtime.handleCommand("/disconnect nobody");
  const keepRunning = await runtime.handleCommand("/quit");

  assertEquals(runtime.name, "node-b");
  assertEquals(keepRunning, false);
  assertIncludes(logs[0], "listening on https://127.0.0.1:4443/p2p");
  assertIncludes(logs[1], "local name changed: node-a -> node-b");
  assertIncludes(logs[2], "no outbound peer matches nobody");
});

Deno.test("PeerRuntime tracks inbound peers and peer summaries", async () => {
  const runtime = createRuntime();
  runtime.print = (): void => {
    // ignore logs in this test
  };

  const eventLog: string[] = [];
  const peer = createPeer("peer-1");
  const events = createEvents(eventLog);
  const sessionId = runtime.prepareInbound(peer);

  const connectResult = await runtime.attachInbound(sessionId, peer, events);
  assertEquals(connectResult.localName, "node-a");
  assertEquals(connectResult.peers.length, 0);
  assertEquals(eventLog.length, 1);
  assertIncludes(
    eventLog[0],
    "connected to node-a at https://127.0.0.1:4443/p2p",
  );

  await runtime.renameInbound(sessionId, "alice");
  const peers = runtime.renderPeers();
  assertEquals(peers.length, 1);
  assertIncludes(peers[0], "alice (inbound");

  await runtime.removeInbound(sessionId, "test cleanup");
  assertEquals(runtime.renderPeers()[0], "no connected peers");
});
