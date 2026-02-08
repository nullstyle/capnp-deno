import {
  encodeCallRequestFrame,
  RpcServerBridge,
  RpcServerRuntime,
  type RpcServerWasmHost,
  type RpcTransport,
  SessionError,
  type WasmHostCallRecord,
  WasmPeer,
} from "../advanced.ts";
import { FakeCapnpWasm } from "./fake_wasm.ts";
import { assert, assertEquals } from "./test_utils.ts";

function encodeSingleU32StructMessage(value: number): Uint8Array {
  const out = new Uint8Array(24);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, 0, true);
  view.setUint32(4, 2, true);
  view.setBigUint64(8, 0x0000_0001_0000_0000n, true);
  view.setUint32(16, value >>> 0, true);
  return out;
}

const MASK_30 = 0x3fff_ffffn;

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

class MockTransport implements RpcTransport {
  #onFrame: ((frame: Uint8Array) => void | Promise<void>) | null = null;
  readonly sent: Uint8Array[] = [];

  start(onFrame: (frame: Uint8Array) => void | Promise<void>): void {
    this.#onFrame = onFrame;
  }

  send(frame: Uint8Array): void {
    this.sent.push(new Uint8Array(frame));
  }

  close(): void {
    // no-op
  }

  async emit(frame: Uint8Array): Promise<void> {
    if (!this.#onFrame) throw new Error("transport not started");
    await this.#onFrame(frame);
  }
}

class MockHostAbi {
  readonly calls: WasmHostCallRecord[] = [];
  readonly results: Array<{ questionId: number; payload: Uint8Array }> = [];
  readonly exceptions: Array<{ questionId: number; reason: string }> = [];

  popHostCall(_peer: number): WasmHostCallRecord | null {
    if (this.calls.length === 0) return null;
    return this.calls.shift() ?? null;
  }

  respondHostCallResults(
    _peer: number,
    questionId: number,
    payloadFrame: Uint8Array,
  ): void {
    this.results.push({
      questionId,
      payload: new Uint8Array(payloadFrame),
    });
  }

  respondHostCallException(
    _peer: number,
    questionId: number,
    reason: string | Uint8Array,
  ): void {
    const text = typeof reason === "string"
      ? reason
      : new TextDecoder().decode(reason);
    this.exceptions.push({ questionId, reason: text });
  }
}

function createHostCall(questionId: number): WasmHostCallRecord {
  return {
    questionId,
    interfaceId: 0x1234n,
    methodId: 7,
    frame: encodeCallRequestFrame({
      questionId,
      interfaceId: 0x1234n,
      methodId: 7,
      targetImportedCap: 5,
      paramsContent: encodeSingleU32StructMessage(questionId),
    }),
  };
}

Deno.test("RpcServerRuntime auto-pumps wasm host calls after inbound frames", async () => {
  const fake = new FakeCapnpWasm({
    onPushFrame: () => [],
  });
  const peer = WasmPeer.fromExports(fake.exports);
  const transport = new MockTransport();
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => Promise.resolve(encodeSingleU32StructMessage(88)),
  }, { capabilityIndex: 5 });

  const hostAbi = new MockHostAbi();
  hostAbi.calls.push(createHostCall(1));
  const wasmHost: RpcServerWasmHost = {
    handle: peer.handle,
    abi: hostAbi,
  };

  const runtime = new RpcServerRuntime(peer, transport, bridge, {
    wasmHost,
    hostCallPump: {
      maxCallsPerInboundFrame: 4,
      maxCallsTotal: 10,
    },
  });

  try {
    await runtime.start();
    await transport.emit(new Uint8Array([0x01]));
    await runtime.flush();

    assertEquals(hostAbi.exceptions.length, 0);
    assertEquals(hostAbi.results.length, 1);
    assertEquals(hostAbi.results[0].questionId, 1);
    assertEquals(decodeSingleU32StructMessage(hostAbi.results[0].payload), 88);
    assertEquals(runtime.totalHostCallsPumped, 1);
  } finally {
    await runtime.close();
  }
});

Deno.test("RpcServerRuntime enforces host-call pump limit in fail-fast mode", async () => {
  const fake = new FakeCapnpWasm({
    onPushFrame: () => [],
  });
  const peer = WasmPeer.fromExports(fake.exports);
  const transport = new MockTransport();
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => Promise.resolve(encodeSingleU32StructMessage(5)),
  }, { capabilityIndex: 5 });

  const hostAbi = new MockHostAbi();
  hostAbi.calls.push(createHostCall(1));
  hostAbi.calls.push(createHostCall(2));

  const runtime = new RpcServerRuntime(peer, transport, bridge, {
    wasmHost: {
      handle: peer.handle,
      abi: hostAbi,
    },
    hostCallPump: {
      maxCallsPerInboundFrame: 8,
      maxCallsTotal: 1,
      failOnLimit: true,
    },
  });

  try {
    await runtime.start();
    let thrown: unknown;
    try {
      await transport.emit(new Uint8Array([0x01]));
      await runtime.flush();
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof SessionError &&
        /host-call pump limit reached/i.test(thrown.message),
      `expected host-call limit SessionError, got: ${String(thrown)}`,
    );
    assertEquals(hostAbi.results.length, 1);
    assertEquals(hostAbi.calls.length, 1);
  } finally {
    await runtime.close();
  }
});

Deno.test("RpcServerRuntime can warn-and-stop host-call pumping when limit is reached", async () => {
  const fake = new FakeCapnpWasm({
    onPushFrame: () => [],
  });
  const peer = WasmPeer.fromExports(fake.exports);
  const transport = new MockTransport();
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => Promise.resolve(encodeSingleU32StructMessage(7)),
  }, { capabilityIndex: 5 });

  const hostAbi = new MockHostAbi();
  hostAbi.calls.push(createHostCall(1));
  hostAbi.calls.push(createHostCall(2));

  const warnings: string[] = [];
  const runtime = new RpcServerRuntime(peer, transport, bridge, {
    wasmHost: {
      handle: peer.handle,
      abi: hostAbi,
    },
    hostCallPump: {
      maxCallsPerInboundFrame: 8,
      maxCallsTotal: 1,
      failOnLimit: false,
      onWarning: (warning) => {
        warnings.push(warning.message);
      },
    },
  });

  try {
    await runtime.start();
    await transport.emit(new Uint8Array([0x01]));
    await runtime.flush();
    assertEquals(hostAbi.results.length, 1);
    assertEquals(runtime.hostCallPumpDisabled, true);
    assertEquals(warnings.length, 1);

    await transport.emit(new Uint8Array([0x02]));
    await runtime.flush();
    assertEquals(hostAbi.results.length, 1);
    assertEquals(hostAbi.calls.length, 1);
  } finally {
    await runtime.close();
  }
});

Deno.test("RpcServerRuntime rejects explicit host-call pump enablement when bridge exports are unavailable", () => {
  const fake = new FakeCapnpWasm();
  const peer = WasmPeer.fromExports(fake.exports);
  const transport = new MockTransport();
  const bridge = new RpcServerBridge();

  let thrown: unknown;
  try {
    new RpcServerRuntime(peer, transport, bridge, {
      hostCallPump: {
        enabled: true,
      },
    });
  } catch (error) {
    thrown = error;
  } finally {
    peer.close();
  }

  assert(
    thrown instanceof SessionError &&
      /explicitly enabled/i.test(thrown.message) &&
      /unavailable/i.test(thrown.message),
    `expected explicit-enable SessionError, got: ${String(thrown)}`,
  );
});

Deno.test("RpcServerRuntime warns when host-call pump is unavailable and keeps runtime usable", async () => {
  const fake = new FakeCapnpWasm();
  const peer = WasmPeer.fromExports(fake.exports);
  const transport = new MockTransport();
  const bridge = new RpcServerBridge();
  const warningCodes: string[] = [];

  const runtime = new RpcServerRuntime(peer, transport, bridge, {
    hostCallPump: {
      onWarning: (warning) => {
        warningCodes.push(warning.code);
      },
    },
  });

  try {
    await Promise.resolve(); // let async warning callback run
    assertEquals(
      JSON.stringify(warningCodes),
      JSON.stringify([
        "host_call_pump_unavailable",
      ]),
    );
    const handled = await runtime.pumpHostCallsNow();
    assertEquals(handled, 0);
  } finally {
    await runtime.close();
  }
});

Deno.test("RpcServerRuntime validates host-call pump configuration values", () => {
  const fake = new FakeCapnpWasm({
    onPushFrame: () => [],
    extraExports: {
      capnp_peer_pop_host_call: () => 0,
      capnp_peer_respond_host_call_results: () => 1,
      capnp_peer_respond_host_call_exception: () => 1,
    },
  });
  const peer = WasmPeer.fromExports(fake.exports);
  const transport = new MockTransport();
  const bridge = new RpcServerBridge();

  let badPerFrame: unknown;
  try {
    new RpcServerRuntime(peer, transport, bridge, {
      hostCallPump: {
        maxCallsPerInboundFrame: 0,
      },
    });
  } catch (error) {
    badPerFrame = error;
  }
  assert(
    badPerFrame instanceof SessionError &&
      /maxCallsPerInboundFrame must be a positive integer/i.test(
        badPerFrame.message,
      ),
    `expected maxCallsPerInboundFrame validation error, got: ${
      String(badPerFrame)
    }`,
  );

  let badTotal: unknown;
  try {
    new RpcServerRuntime(peer, transport, bridge, {
      hostCallPump: {
        maxCallsTotal: 0,
      },
    });
  } catch (error) {
    badTotal = error;
  } finally {
    peer.close();
  }
  assert(
    badTotal instanceof SessionError &&
      /maxCallsTotal must be a positive integer/i.test(badTotal.message),
    `expected maxCallsTotal validation error, got: ${String(badTotal)}`,
  );
});

Deno.test("RpcServerRuntime validates pumpHostCallsNow maxCalls argument", async () => {
  const fake = new FakeCapnpWasm({
    onPushFrame: () => [],
    extraExports: {
      capnp_peer_pop_host_call: () => 0,
      capnp_peer_respond_host_call_results: () => 1,
      capnp_peer_respond_host_call_exception: () => 1,
    },
  });
  const peer = WasmPeer.fromExports(fake.exports);
  const transport = new MockTransport();
  const bridge = new RpcServerBridge();

  const runtime = new RpcServerRuntime(peer, transport, bridge, {
    wasmHost: {
      handle: peer.handle,
      abi: new MockHostAbi(),
    },
  });
  try {
    let thrown: unknown;
    try {
      await runtime.pumpHostCallsNow({ maxCalls: 0 });
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof SessionError &&
        /maxCalls must be a positive integer/i.test(thrown.message),
      `expected pump maxCalls validation error, got: ${String(thrown)}`,
    );
  } finally {
    await runtime.close();
  }
});

Deno.test("RpcServerRuntime.create can auto-start without explicit peer wiring", async () => {
  const transport = new MockTransport();
  const bridge = new RpcServerBridge();
  const runtime = await RpcServerRuntime.create(transport, bridge, {
    autoStart: true,
    hostCallPump: { enabled: false },
  });

  try {
    assertEquals(runtime.started, true);
  } finally {
    await runtime.close();
  }
});

Deno.test("RpcServerRuntime swallows warning callback failures at limit boundaries", async () => {
  const fake = new FakeCapnpWasm({
    onPushFrame: () => [],
  });
  const peer = WasmPeer.fromExports(fake.exports);
  const transport = new MockTransport();
  const bridge = new RpcServerBridge();
  bridge.exportCapability({
    interfaceId: 0x1234n,
    dispatch: () => Promise.resolve(encodeSingleU32StructMessage(9)),
  }, { capabilityIndex: 5 });

  const hostAbi = new MockHostAbi();
  hostAbi.calls.push(createHostCall(1));
  hostAbi.calls.push(createHostCall(2));

  const runtime = new RpcServerRuntime(peer, transport, bridge, {
    wasmHost: {
      handle: peer.handle,
      abi: hostAbi,
    },
    hostCallPump: {
      maxCallsPerInboundFrame: 8,
      maxCallsTotal: 1,
      failOnLimit: false,
      onWarning: () => {
        throw new Error("warning sink down");
      },
    },
  });

  try {
    await runtime.start();
    await transport.emit(new Uint8Array([0x01]));
    await runtime.flush();
    assertEquals(hostAbi.results.length, 1);
    assertEquals(runtime.hostCallPumpDisabled, true);
  } finally {
    await runtime.close();
  }
});
