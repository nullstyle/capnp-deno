import {
  InMemoryRpcHarnessTransport,
  instantiatePeer,
  ProtocolError,
  RpcServerBridge,
  RpcServerRuntime,
  SessionRpcClientTransport,
  type WasmPeer,
} from "../mod.ts";
import { assert, assertEquals } from "./test_utils.ts";

const wasmPath = new URL("../generated/capnp_deno.wasm", import.meta.url);
const INTERFACE_ID = 0x1234n;
const MASK_30 = 0x3fff_ffffn;

function encodeSingleU32StructMessage(value: number): Uint8Array {
  const out = new Uint8Array(24);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, 0, true);
  view.setUint32(4, 2, true);
  view.setBigUint64(8, 0x0000_0001_0000_0000n, true);
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

async function withRealServer(
  run: (args: {
    peer: WasmPeer;
    bridge: RpcServerBridge;
    runtime: RpcServerRuntime;
    client: SessionRpcClientTransport;
  }) => Promise<void>,
): Promise<void> {
  const { peer } = await instantiatePeer(wasmPath, {}, {
    expectedVersion: 1,
    requireVersionExport: true,
  });

  const transport = new InMemoryRpcHarnessTransport();
  const bridge = new RpcServerBridge();
  const runtime = new RpcServerRuntime(peer, transport, bridge, {
    hostCallPump: {
      enabled: true,
      maxCallsPerInboundFrame: 64,
      maxCallsTotal: 20_000,
      failOnLimit: true,
    },
  });
  const client = new SessionRpcClientTransport(runtime.session, transport, {
    interfaceId: INTERFACE_ID,
    nextQuestionId: 1,
    autoStart: false,
  });

  try {
    await runtime.start();
    await run({ peer, bridge, runtime, client });
  } finally {
    await runtime.close();
  }
}

Deno.test("real wasm service flow: bootstrap -> host dispatch -> explicit finish/release", async () => {
  await withRealServer(async ({ bridge, client }) => {
    const bootstrap = await client.bootstrap();
    bridge.exportCapability({
      interfaceId: INTERFACE_ID,
      dispatch(methodId, params, ctx) {
        assertEquals(methodId, 7);
        assertEquals(ctx.target.tag, 0);
        assertEquals(ctx.capability.capabilityIndex, bootstrap.capabilityIndex);
        const value = decodeSingleU32StructMessage(params);
        return encodeSingleU32StructMessage(value + 1);
      },
    }, {
      capabilityIndex: bootstrap.capabilityIndex,
      referenceCount: 2,
    });

    let questionId = -1;
    const response = await client.callRaw(
      bootstrap,
      7,
      encodeSingleU32StructMessage(41),
      {
        autoFinish: false,
        onQuestionId(id) {
          questionId = id;
        },
      },
    );
    assertEquals(decodeSingleU32StructMessage(response.contentBytes), 42);
    assert(questionId > 0, `expected call question id, got: ${questionId}`);

    await client.finish(questionId, {
      releaseResultCaps: true,
      requireEarlyCancellation: false,
    });
    await client.release(bootstrap, 1);
  });
});

Deno.test("real wasm service flow: guarded soak/fault loop", async () => {
  await withRealServer(async ({ bridge, client, runtime }) => {
    const bootstrap = await client.bootstrap();
    let dispatchCount = 0;

    bridge.exportCapability({
      interfaceId: INTERFACE_ID,
      dispatch(_methodId, params) {
        dispatchCount += 1;
        if (dispatchCount % 9 === 0) {
          throw new Error("fault injection");
        }
        const value = decodeSingleU32StructMessage(params);
        return encodeSingleU32StructMessage(value + 1000);
      },
    }, {
      capabilityIndex: bootstrap.capabilityIndex,
    });

    let success = 0;
    let injectedFailures = 0;
    for (let i = 0; i < 120; i += 1) {
      const payload = encodeSingleU32StructMessage(i);
      try {
        const out = await client.call(bootstrap, 7, payload, {
          timeoutMs: 2_000,
        });
        assertEquals(decodeSingleU32StructMessage(out), i + 1000);
        success += 1;
      } catch (error) {
        if (
          error instanceof ProtocolError &&
          /fault injection/i.test(error.message)
        ) {
          injectedFailures += 1;
          continue;
        }
        throw error;
      }
    }

    assertEquals(dispatchCount, 120);
    assertEquals(injectedFailures, Math.floor(120 / 9));
    assertEquals(success + injectedFailures, 120);
    assertEquals(runtime.totalHostCallsPumped, 120);
  });
});
