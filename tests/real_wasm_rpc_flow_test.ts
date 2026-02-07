import {
  instantiatePeer,
  RpcSession,
  type RpcTransport,
  type WasmPeer,
} from "../mod.ts";
import {
  BOOTSTRAP_Q1_INBOUND,
  BOOTSTRAP_Q1_OUTBOUND,
  BOOTSTRAP_Q1_SUCCESS_INBOUND,
  BOOTSTRAP_Q1_SUCCESS_OUTBOUND,
  CALL_BOOTSTRAP_CAP_Q2_INBOUND,
  CALL_BOOTSTRAP_CAP_Q2_OUTBOUND,
  CALL_UNKNOWN_CAP_Q2_INBOUND,
  CALL_UNKNOWN_CAP_Q2_OUTBOUND,
} from "./fixtures/rpc_frames.ts";
import { assertBytes, assertEquals } from "./test_utils.ts";

const wasmPath = new URL(
  "../.artifacts/capnp_deno.wasm",
  import.meta.url,
);

class MockTransport implements RpcTransport {
  readonly sent: Uint8Array[] = [];
  #onFrame: ((frame: Uint8Array) => void | Promise<void>) | null = null;

  start(
    onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): void {
    this.#onFrame = onFrame;
  }

  send(frame: Uint8Array): void {
    this.sent.push(new Uint8Array(frame));
  }

  close(): void {}

  async emit(frame: Uint8Array): Promise<void> {
    if (!this.#onFrame) throw new Error("transport not started");
    await this.#onFrame(frame);
  }
}

async function withPeer(
  run: (instance: WebAssembly.Instance, peer: WasmPeer) => void | Promise<void>,
): Promise<void> {
  const { instance, peer } = await instantiatePeer(wasmPath, {}, {
    expectedVersion: 1,
    requireVersionExport: true,
  });
  try {
    await run(instance, peer);
  } finally {
    peer.close();
  }
}

function enableBootstrapStub(
  instance: WebAssembly.Instance,
  peer: WasmPeer,
): void {
  const raw = instance.exports as Record<string, unknown>;
  const fn = raw.capnp_peer_set_bootstrap_stub;
  if (typeof fn !== "function") {
    throw new Error("missing capnp_peer_set_bootstrap_stub export");
  }
  const ok = (fn as (handle: number) => number)(peer.handle);
  if (ok !== 1) {
    const err = peer.abi.exports.capnp_last_error_code();
    const msg = err === 0
      ? "capnp_peer_set_bootstrap_stub failed"
      : `capnp_peer_set_bootstrap_stub failed with code=${err}`;
    throw new Error(msg);
  }
}

Deno.test("real wasm peer bootstrap/call flow matches wire fixtures", async () => {
  await withPeer((_instance, peer) => {
    const bootstrapOutbound = peer.pushFrame(BOOTSTRAP_Q1_INBOUND);
    assertEquals(bootstrapOutbound.length, 1);
    assertBytes(bootstrapOutbound[0], Array.from(BOOTSTRAP_Q1_OUTBOUND));

    const callOutbound = peer.pushFrame(CALL_UNKNOWN_CAP_Q2_INBOUND);
    assertEquals(callOutbound.length, 1);
    assertBytes(callOutbound[0], Array.from(CALL_UNKNOWN_CAP_Q2_OUTBOUND));

    assertEquals(peer.drainOutgoingFrames().length, 0);
  });
});

Deno.test("real wasm peer successful bootstrap/call flow matches fixtures", async () => {
  await withPeer((instance, peer) => {
    enableBootstrapStub(instance, peer);

    const bootstrapOutbound = peer.pushFrame(BOOTSTRAP_Q1_SUCCESS_INBOUND);
    assertEquals(bootstrapOutbound.length, 1);
    assertBytes(
      bootstrapOutbound[0],
      Array.from(BOOTSTRAP_Q1_SUCCESS_OUTBOUND),
    );

    const callOutbound = peer.pushFrame(CALL_BOOTSTRAP_CAP_Q2_INBOUND);
    assertEquals(callOutbound.length, 1);
    assertBytes(callOutbound[0], Array.from(CALL_BOOTSTRAP_CAP_Q2_OUTBOUND));

    assertEquals(peer.drainOutgoingFrames().length, 0);
  });
});

Deno.test("RpcSession pumps real wasm peer using successful bootstrap fixture", async () => {
  await withPeer(async (instance, peer) => {
    enableBootstrapStub(instance, peer);

    const transport = new MockTransport();
    const session = new RpcSession(peer, transport);

    try {
      await session.start();
      await transport.emit(BOOTSTRAP_Q1_SUCCESS_INBOUND);
      await session.flush();

      assertEquals(transport.sent.length, 1);
      assertBytes(transport.sent[0], Array.from(BOOTSTRAP_Q1_SUCCESS_OUTBOUND));
    } finally {
      await session.close();
    }
  });
});
