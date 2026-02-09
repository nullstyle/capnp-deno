/**
 * GAP-10: TCP RPC interop test.
 *
 * Validates a complete RPC flow over real TCP using the real WASM peer on the
 * server side. The client uses raw frame encoding/decoding to send and receive
 * Cap'n Proto RPC messages, exercising the full TCP framing + wire format
 * pipeline without a client-side WASM peer.
 */

import {
  decodeReturnFrame,
  encodeBootstrapRequestFrame,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  instantiatePeer,
  RpcServerBridge,
  RpcServerRuntime,
  TcpServerListener,
  TcpTransport,
} from "../advanced.ts";
import { assert, assertEquals } from "./test_utils.ts";

const wasmPath = new URL("../generated/capnp_deno.wasm", import.meta.url);
const INTERFACE_ID = 0xABCD_1234n;
const MASK_30 = 0x3fff_ffffn;

// ---------------------------------------------------------------------------
// Helpers: encode/decode a simple struct message with a single UInt32 field
// ---------------------------------------------------------------------------

function encodeSingleU32StructMessage(value: number): Uint8Array {
  const out = new Uint8Array(24);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, 0, true); // segment count - 1
  view.setUint32(4, 2, true); // 2 words
  view.setBigUint64(8, 0x0000_0001_0000_0000n, true); // struct pointer: 1 data word
  view.setUint32(16, value >>> 0, true);
  return out;
}

function signed30(value: bigint): number {
  const raw = Number(value & MASK_30);
  return (raw & (1 << 29)) !== 0 ? raw - (1 << 30) : raw;
}

function decodeSingleU32StructMessage(frame: Uint8Array): number {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const root = view.getBigUint64(8, true);
  const offset = signed30((root >> 2n) & MASK_30);
  const dataWord = 1 + offset;
  return view.getUint32(8 + (dataWord * 8), true);
}

// ---------------------------------------------------------------------------
// Helper: collect frames from a TCP transport
// ---------------------------------------------------------------------------

class FrameCollector {
  #frames: Uint8Array[] = [];
  #waiters: Array<(frame: Uint8Array) => void> = [];

  onFrame(frame: Uint8Array): void {
    const copy = new Uint8Array(frame);
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter(copy);
    } else {
      this.#frames.push(copy);
    }
  }

  nextFrame(timeoutMs = 5_000): Promise<Uint8Array> {
    const queued = this.#frames.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for frame (${timeoutMs}ms)`)),
        timeoutMs,
      );
      this.#waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Test: full TCP RPC round-trip with real WASM server peer
// ---------------------------------------------------------------------------

Deno.test("TCP RPC interop: bootstrap + call + response over real TCP", async () => {
  // --- Server setup ---
  const serverListener = new TcpServerListener({
    port: 0,
    hostname: "127.0.0.1",
  });
  const addr = serverListener.addr as Deno.NetAddr;

  let serverRuntime: RpcServerRuntime | undefined;

  const serverReady = (async () => {
    for await (const tcpTransport of serverListener.accept()) {
      const { peer } = await instantiatePeer(wasmPath, {}, {
        expectedVersion: 1,
        requireVersionExport: true,
      });

      const bridge = new RpcServerBridge();
      const runtime = new RpcServerRuntime(peer, tcpTransport, bridge, {
        hostCallPump: {
          enabled: true,
          maxCallsPerInboundFrame: 64,
          maxCallsTotal: 20_000,
          failOnLimit: true,
        },
        session: {
          onError: (error) => {
            // Suppress expected errors during teardown
            if (
              error instanceof Error &&
              /closed|reset|broken/.test(error.message)
            ) {
              return;
            }
            console.error("Server session error:", error);
          },
        },
      });
      await runtime.start();

      bridge.exportCapability({
        interfaceId: INTERFACE_ID,
        dispatch(_methodId, params) {
          const value = decodeSingleU32StructMessage(params);
          return encodeSingleU32StructMessage(value + 1);
        },
      }, {
        capabilityIndex: 0,
        referenceCount: 10,
      });

      serverRuntime = runtime;
      // Only accept one connection for this test
      return;
    }
  })();

  try {
    // --- Client setup: raw TCP + manual frame encoding ---
    const clientTcp = await TcpTransport.connect(addr.hostname, addr.port);
    const collector = new FrameCollector();
    clientTcp.start((frame) => collector.onFrame(frame));

    // Wait for server to be ready
    await serverReady;

    // --- Bootstrap ---
    const bootstrapQuestionId = 1;
    await clientTcp.send(encodeBootstrapRequestFrame({
      questionId: bootstrapQuestionId,
    }));

    const bootstrapResponse = decodeReturnFrame(await collector.nextFrame());
    assertEquals(bootstrapResponse.answerId, bootstrapQuestionId);
    assert(
      bootstrapResponse.kind === "results",
      "expected results, not exception",
    );
    assert(
      bootstrapResponse.capTable.length > 0,
      "expected capability in bootstrap response cap table",
    );
    const bootstrapCapId = bootstrapResponse.capTable[0].id;

    // Finish the bootstrap question
    await clientTcp.send(encodeFinishFrame({
      questionId: bootstrapQuestionId,
      releaseResultCaps: false,
    }));

    // --- Call: send a method call and check the response ---
    const callQuestionId = 2;
    await clientTcp.send(encodeCallRequestFrame({
      questionId: callQuestionId,
      target: { tag: 0, importedCap: bootstrapCapId },
      interfaceId: INTERFACE_ID,
      methodId: 0,
      paramsContent: encodeSingleU32StructMessage(41),
    }));

    const callResponse = decodeReturnFrame(await collector.nextFrame());
    assertEquals(callResponse.answerId, callQuestionId);
    assert(callResponse.kind === "results", "expected results, not exception");
    assertEquals(decodeSingleU32StructMessage(callResponse.contentBytes), 42);

    // Finish the call question
    await clientTcp.send(encodeFinishFrame({
      questionId: callQuestionId,
      releaseResultCaps: true,
    }));

    // --- Multiple calls ---
    for (let i = 0; i < 10; i++) {
      const qId = 10 + i;
      await clientTcp.send(encodeCallRequestFrame({
        questionId: qId,
        target: { tag: 0, importedCap: bootstrapCapId },
        interfaceId: INTERFACE_ID,
        methodId: 0,
        paramsContent: encodeSingleU32StructMessage(i * 100),
      }));

      const resp = decodeReturnFrame(await collector.nextFrame());
      assertEquals(resp.answerId, qId);
      assert(resp.kind === "results", `call ${i}: expected results`);
      assertEquals(
        decodeSingleU32StructMessage(resp.contentBytes),
        i * 100 + 1,
      );

      await clientTcp.send(encodeFinishFrame({
        questionId: qId,
        releaseResultCaps: true,
      }));
    }

    // --- Release the bootstrap capability ---
    await clientTcp.send(encodeReleaseFrame({
      id: bootstrapCapId,
      referenceCount: 1,
    }));

    // Brief delay for server to process release
    await new Promise((resolve) => setTimeout(resolve, 50));

    // --- Cleanup ---
    clientTcp.close();
    if (serverRuntime) {
      await serverRuntime.close().catch(() => {});
    }
  } finally {
    serverListener.close();
  }
});
