import { WasmPeer } from "../advanced.ts";
import { FakeCapnpWasm } from "./fake_wasm.ts";
import {
  assert,
  assertBytes,
  assertEquals,
  assertThrows,
} from "./test_utils.ts";

Deno.test("WasmPeer.pushFrame drains all outbound frames", () => {
  const fake = new FakeCapnpWasm({
    onPushFrame: (frame) => {
      if (frame[0] === 0xaa) {
        return [new Uint8Array([0x01]), new Uint8Array([0x02])];
      }
      return [new Uint8Array([0xff])];
    },
  });

  using peer = WasmPeer.fromExports(fake.exports);
  const result = peer.pushFrame(new Uint8Array([0xaa]));

  assertEquals(result.frames.length, 2, "expected two outbound frames");
  assertEquals(result.truncated, false, "should not be truncated");
  assertBytes(result.frames[0], [0x01]);
  assertBytes(result.frames[1], [0x02]);
  assertEquals(fake.commitCalls.length, 2, "expected one commit per frame");
});

Deno.test("WasmPeer rejects ABI version mismatch", () => {
  const fake = new FakeCapnpWasm({ abiVersion: 2 });
  assertThrows(
    () => WasmPeer.fromExports(fake.exports, { expectedVersion: 1 }),
    /capnp_wasm_abi_version mismatch/,
  );
});

Deno.test("WasmPeer.close is idempotent and blocks further use", () => {
  const fake = new FakeCapnpWasm();
  const peer = WasmPeer.fromExports(fake.exports);
  peer.close();
  peer.close();

  assert(peer.closed, "peer should report closed state");
  assertThrows(() => peer.pushFrame(new Uint8Array([0x01])), /closed/);
});

Deno.test("WasmPeer.popOutgoingFrame and drainOutgoingFrames expose queued frames", () => {
  const fake = new FakeCapnpWasm({
    onPushFrame: () => [
      new Uint8Array([0x11]),
      new Uint8Array([0x22]),
      new Uint8Array([0x33]),
    ],
  });

  using peer = WasmPeer.fromExports(fake.exports);
  peer.abi.pushFrame(peer.handle, new Uint8Array([0xaa]));

  const first = peer.popOutgoingFrame();
  assert(first !== null, "expected first frame");
  assertBytes(first, [0x11]);

  const result = peer.drainOutgoingFrames();
  assertEquals(result.frames.length, 2);
  assertEquals(result.truncated, false);
  assertBytes(result.frames[0], [0x22]);
  assertBytes(result.frames[1], [0x33]);

  assertEquals(peer.popOutgoingFrame(), null);
});

Deno.test("WasmPeer.fromInstance accepts WebAssembly instance exports", () => {
  const fake = new FakeCapnpWasm({
    onPushFrame: () => [new Uint8Array([0xfe])],
  });
  const instance = {
    exports: fake.exports,
  } as unknown as WebAssembly.Instance;

  using peer = WasmPeer.fromInstance(instance, { expectedVersion: 1 });
  const result = peer.pushFrame(new Uint8Array([0x01]));
  assertEquals(result.frames.length, 1);
  assertBytes(result.frames[0], [0xfe]);
});
