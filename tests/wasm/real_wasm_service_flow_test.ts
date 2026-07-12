import {
  CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
  InMemoryRpcHarnessTransport,
  instantiatePeer,
  ProtocolError,
  RpcServerBridge,
  RpcServerRuntime,
  SessionRpcClientTransport,
  type WasmPeer,
} from "../../src/advanced.ts";
import { Pinger, type Ponger } from "../../examples/ping/gen/schema_types.ts";
import { assert, assertEquals, withTimeout } from "../test_utils.ts";

const wasmPath = new URL("../../generated/capnp_deno.wasm", import.meta.url);
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

function encodeU32AndCapPointerStructMessage(
  value: number,
  capTableIndex: number,
): Uint8Array {
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, 0, true);
  view.setUint32(4, 3, true);
  view.setBigUint64(8, 0x0001_0001_0000_0000n, true);
  view.setUint32(16, value >>> 0, true);
  view.setBigUint64(24, (BigInt(capTableIndex) << 32n) | 3n, true);
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
    const bootstrap = await client.bootstrap({
      finish: { releaseResultCaps: false },
    });
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

Deno.test("real wasm service flow: cap-bearing results cross the host-call bridge", async () => {
  await withRealServer(async ({ bridge, client, runtime }) => {
    const bootstrap = await client.bootstrap({
      finish: { releaseResultCaps: false },
    });
    let rootDispatchCount = 0;
    let childDispatchCount = 0;

    bridge.exportCapability({
      interfaceId: INTERFACE_ID,
      dispatch(methodId, params, ctx) {
        if (methodId === 12) {
          childDispatchCount += 1;
          return encodeSingleU32StructMessage(
            decodeSingleU32StructMessage(params) + 7,
          );
        }

        rootDispatchCount += 1;
        assertEquals(methodId, 11);
        assertEquals(decodeSingleU32StructMessage(params), 500);
        assertEquals(ctx.paramsCapTable.length, 0);

        return {
          content: encodeU32AndCapPointerStructMessage(501, 0),
          capTable: [{
            tag: CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
            id: bootstrap.capabilityIndex,
          }],
          releaseParamCaps: false,
        };
      },
    }, {
      capabilityIndex: bootstrap.capabilityIndex,
      referenceCount: 2,
    });

    const rootResponse = await client.callRaw(
      bootstrap,
      11,
      encodeSingleU32StructMessage(500),
      {
        finish: { releaseResultCaps: false },
        timeoutMs: 2_000,
      },
    );

    assertEquals(decodeSingleU32StructMessage(rootResponse.contentBytes), 501);
    assertEquals(rootResponse.releaseParamCaps, false);
    assertEquals(rootResponse.noFinishNeeded, false);
    assertEquals(rootResponse.capTable.length, 1);
    assertEquals(
      rootResponse.capTable[0].tag,
      CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
    );

    const child = { capabilityIndex: rootResponse.capTable[0].id };
    const childResponse = await client.call(
      child,
      12,
      encodeSingleU32StructMessage(600),
    );
    assertEquals(decodeSingleU32StructMessage(childResponse), 607);

    await client.release(child, 1);
    await client.release(bootstrap, 1);
    assertEquals(rootDispatchCount, 1);
    assertEquals(childDispatchCount, 1);
    assertEquals(runtime.totalHostCallsPumped, 2);
  });
});

Deno.test("real wasm generated callbacks: cap-bearing params call back before the original call returns", async () => {
  await withRealServer(async ({ bridge, client }) => {
    const bootstrap = await client.bootstrap({
      finish: { releaseResultCaps: false },
      timeoutMs: 2_000,
    });

    let callbackStarted = false;
    let callbackFinished = false;
    let pingResolved = false;
    let callbackSawPendingPing = false;
    const callbackValues: number[] = [];

    Pinger.registerServer(bridge, {
      async ping(ponger) {
        callbackStarted = true;
        await ponger.pong(123);
        callbackFinished = true;
      },
    }, {
      capabilityIndex: bootstrap.capabilityIndex,
      referenceCount: 2,
    });

    const pinger = await Pinger.bootstrapClient({
      bootstrap: () => Promise.resolve(bootstrap),
      call: (capability, methodId, params, options) =>
        client.call(capability, methodId, params, options),
      callRaw: (capability, methodId, params, options) =>
        client.callRaw(capability, methodId, params, options),
      finish: (questionId, options) => client.finish(questionId, options),
      release: (capability, referenceCount) =>
        client.release(capability, referenceCount),
      exportCapability: (dispatch, options) =>
        client.exportCapability(dispatch, options),
    });

    const localPonger: Ponger = {
      pong(value) {
        callbackSawPendingPing = !pingResolved;
        callbackValues.push(value);
        return Promise.resolve();
      },
    };

    await withTimeout(
      pinger.ping(localPonger, { timeoutMs: 2_000 }),
      2_500,
      "generated pinger callback flow",
    );
    pingResolved = true;

    assertEquals(callbackStarted, true);
    assertEquals(callbackFinished, true);
    assertEquals(callbackSawPendingPing, true);
    assertEquals(callbackValues.length, 1);
    assertEquals(callbackValues[0], 123);
    assertEquals(bridge.answerTableSize, 0);
  });
});

const SINK_INTERFACE_ID = 0x5678n;

async function waitForCondition(
  check: () => boolean,
  label: string,
): Promise<void> {
  await withTimeout(
    (async () => {
      while (!check()) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })(),
    1_000,
    label,
  );
}

Deno.test("real wasm service flow: default host-call answers release param caps only after the Return", async () => {
  await withRealServer(async ({ bridge, client, runtime }) => {
    const bootstrap = await client.bootstrap({
      finish: { releaseResultCaps: false },
    });
    let paramCapSeenDuringDispatch = -1;

    bridge.exportCapability({
      interfaceId: INTERFACE_ID,
      dispatch(_methodId, _params, ctx) {
        paramCapSeenDuringDispatch = ctx.paramsCapTable[0]?.id ?? -1;
        return encodeSingleU32StructMessage(1);
      },
    }, {
      capabilityIndex: bootstrap.capabilityIndex,
      referenceCount: 2,
    });

    const sink = client.exportCapability({
      interfaceId: SINK_INTERFACE_ID,
      dispatch: () => encodeSingleU32StructMessage(0),
    });
    assertEquals(client.stats.exportedCapabilities, 1);

    await client.callRaw(bootstrap, 5, encodeSingleU32StructMessage(0), {
      paramsCapTable: [{
        tag: CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
        id: sink.capabilityIndex,
      }],
      timeoutMs: 2_000,
    });
    assertEquals(paramCapSeenDuringDispatch, sink.capabilityIndex);

    // A handler that does not retain gets the pre-retention contract: the
    // peer spends the param-cap reference with an explicit Release once the
    // Return is on the wire, and the client-side export unregisters.
    await runtime.flush();
    await waitForCondition(
      () => client.stats.exportedCapabilities === 0,
      "await post-Return param-cap release",
    );

    await client.release(bootstrap, 1);
  });
});

Deno.test("real wasm service flow: retained param cap stays callable after the originating call returned", async () => {
  await withRealServer(async ({ bridge, client, runtime, peer }) => {
    assert(
      peer.abi.capabilities.hasHostCallParamCapRetention,
      "expected the runtime module to support host-call param-cap retention",
    );

    const bootstrap = await client.bootstrap({
      finish: { releaseResultCaps: false },
    });
    let retainedSinkIndex = -1;

    // The studiobox OutputSink pump pattern: registerSink stores the param
    // capability and returns immediately; the server streams into the sink
    // only after the originating call completed.
    bridge.exportCapability({
      interfaceId: INTERFACE_ID,
      dispatch(_methodId, _params, ctx) {
        retainedSinkIndex = ctx.paramsCapTable[0]?.id ?? -1;
        ctx.retainParamCaps?.();
        return encodeSingleU32StructMessage(1);
      },
    }, {
      capabilityIndex: bootstrap.capabilityIndex,
      referenceCount: 2,
    });

    const sinkWrites: number[] = [];
    const sink = client.exportCapability({
      interfaceId: SINK_INTERFACE_ID,
      dispatch(_methodId, params) {
        sinkWrites.push(decodeSingleU32StructMessage(params));
        return encodeSingleU32StructMessage(0);
      },
    });

    await client.callRaw(bootstrap, 5, encodeSingleU32StructMessage(0), {
      paramsCapTable: [{
        tag: CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
        id: sink.capabilityIndex,
      }],
      timeoutMs: 2_000,
    });
    assertEquals(retainedSinkIndex, sink.capabilityIndex);

    // No Release may arrive for the retained sink: the export must survive
    // the originating call's completion.
    await runtime.flush();
    assertEquals(client.stats.exportedCapabilities, 1);

    // Server-originated pump AFTER the originating call returned.
    for (const value of [41, 42]) {
      const pumped = await withTimeout(
        runtime.outboundClient.call(
          { capabilityIndex: retainedSinkIndex },
          3,
          encodeSingleU32StructMessage(value),
          { interfaceId: SINK_INTERFACE_ID, timeoutMs: 2_000 },
        ),
        2_500,
        `pump retained sink value ${value}`,
      );
      assertEquals(decodeSingleU32StructMessage(pumped), 0);
    }
    assertEquals(sinkWrites.join(","), "41,42");

    // The server owns the retained reference and spends it when done; only
    // then does the client-side export unregister.
    await runtime.outboundClient.release(
      { capabilityIndex: retainedSinkIndex },
      1,
    );
    await waitForCondition(
      () => client.stats.exportedCapabilities === 0,
      "await host-owned release of the retained sink",
    );

    await client.release(bootstrap, 1);
  });
});

Deno.test("real wasm service flow: guarded soak/fault loop", async () => {
  await withRealServer(async ({ bridge, client, runtime }) => {
    const bootstrap = await client.bootstrap({
      finish: { releaseResultCaps: false },
    });
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
      const shouldInjectFailure = (i + 1) % 9 === 0;
      try {
        const out = await client.call(bootstrap, 7, payload, {
          timeoutMs: 2_000,
        });
        assert(
          !shouldInjectFailure,
          `expected injected failure for dispatch ${i + 1}`,
        );
        assertEquals(decodeSingleU32StructMessage(out), i + 1000);
        success += 1;
      } catch (error) {
        if (
          shouldInjectFailure &&
          error instanceof ProtocolError &&
          /fault injection|host call failed/i.test(error.message)
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
