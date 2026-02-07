import { WasmPeer } from "../mod.ts";
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
  const outbound = peer.pushFrame(new Uint8Array([0xaa]));

  assertEquals(outbound.length, 2, "expected two outbound frames");
  assertBytes(outbound[0], [0x01]);
  assertBytes(outbound[1], [0x02]);
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
