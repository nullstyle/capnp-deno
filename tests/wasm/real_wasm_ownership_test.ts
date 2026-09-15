import {
  getCapnpWasmExports,
  WasmAbi,
  WasmPeer,
  WasmSerde,
} from "../../src/advanced.ts";
import { assert, assertEquals, assertThrows } from "../test_utils.ts";

const wasmPath = new URL("../../generated/capnp_deno.wasm", import.meta.url);

async function instance(): Promise<WebAssembly.Instance> {
  const loaded = await WebAssembly.instantiate(
    await Deno.readFile(wasmPath),
    {},
  );
  return loaded.instance;
}

Deno.test("real wasm error take leaves the borrowed diagnostic unfreed", async () => {
  const exports = getCapnpWasmExports(await instance());
  using abi = new WasmAbi(exports);
  exports.capnp_peer_push_frame(0xffff_ffff, 0, 0);
  assertEquals(abi.takeLastError()?.code, 3);
  assertEquals(exports.capnp_last_error_code(), 0);
  assertEquals(abi.takeLastError(), null);
});

Deno.test("real wasm owned zero-length output is freed with its exact length", async () => {
  const exports = getCapnpWasmExports(await instance());
  using abi = new WasmAbi(exports);
  const ptr = exports.capnp_alloc(0);
  assert(ptr !== 0);
  abi.freeOutBuffer(ptr, 0);
  assertEquals(exports.capnp_last_error_code(), 0);
  exports.capnp_free(ptr, 0);
  assertEquals(
    exports.capnp_last_error_code(),
    12,
    "allocation was already freed",
  );
});

Deno.test("real wasm peer wrapper disposal preserves shared users across 2000 cycles", async () => {
  const exports = getCapnpWasmExports(await instance());
  const stable = WasmPeer.fromExports(exports);
  for (let i = 0; i < 2000; i++) {
    const peer = WasmPeer.fromExports(exports);
    peer.close();
    peer.close();
    assertEquals(stable.popOutgoingFrame(), null);
  }
  stable.close();
  const ptr = exports.capnp_alloc(1);
  assert(ptr !== 0, "peer wrapper scratch must not exhaust allocation slots");
  exports.capnp_free(ptr, 1);
});

Deno.test("real wasm incompatible wrapper construction does not consume allocation slots", async () => {
  const exports = getCapnpWasmExports(await instance());
  for (let i = 0; i < 2000; i++) {
    assertThrows(
      () => new WasmAbi(exports, { expectedVersion: 999 }),
      /mismatch/,
    );
  }
  const ptr = exports.capnp_alloc(1);
  assert(ptr !== 0, "rejected wrappers must not leak scratch allocations");
  exports.capnp_free(ptr, 1);
});

Deno.test("real wasm borrowed ABI peers do not dispose their shared wrapper", async () => {
  const exports = getCapnpWasmExports(await instance());
  using abi = new WasmAbi(exports);
  const first = WasmPeer.create(abi);
  const second = WasmPeer.create(abi);
  assertThrows(() => abi.close(), /close WASM peers/);
  first.close();
  assertEquals(abi.closed, false);
  assertEquals(second.popOutgoingFrame(), null);
  second.close();
  abi.close();
  assertThrows(() => abi.createPeer(), /closed/);
});

Deno.test("real wasm shutdown refuses other live wrappers of the same instance", async () => {
  const moduleInstance = await instance();
  using first = new WasmAbi(getCapnpWasmExports(moduleInstance));
  using second = new WasmAbi(getCapnpWasmExports(moduleInstance));
  assertThrows(() => first.shutdown(), /other WASM ABI wrappers/);
  first.close();
  const peer = WasmPeer.create(second);
  assertThrows(() => second.shutdown(), /close WASM peers/);
  assertEquals(peer.popOutgoingFrame(), null);
  peer.close();
  second.shutdown();
  assertEquals(second.closed, true);
});

Deno.test("real wasm serde disposal preserves another user across 2000 cycles and growth", async () => {
  const moduleInstance = await instance();
  const exports = getCapnpWasmExports(moduleInstance);
  using stable = WasmPeer.fromExports(exports);
  for (let i = 0; i < 2000; i++) {
    const serde = WasmSerde.fromInstance(moduleInstance);
    const codec = serde.createJsonCodecFor<
      { name: string; age: number; email: string }
    >({
      key: "example_person",
    });
    if (i === 0) exports.memory.grow(1);
    assertThrows(
      () => codec.encodeJson('{"name":true}'),
      /invalid|Unexpected|Missing|Type/i,
    );
    assertEquals(exports.capnp_last_error_code(), 0);
    const person = { name: "Ada", age: 37, email: "" };
    assertEquals(codec.decode(codec.encode(person)).name, "Ada");
    serde.close();
    serde.close();
    assertThrows(() => codec.encode(person), /closed/);
    if (i % 100 === 0) assertEquals(stable.popOutgoingFrame(), null);
  }
  assertEquals(stable.popOutgoingFrame(), null);
});

Deno.test("real wasm serde constructor unwinds ABI scratch when its allocation fails", async () => {
  const exports = getCapnpWasmExports(await instance());
  let allocationCalls = 0;
  const wrapped = {
    ...exports,
    capnp_alloc(len: number): number {
      allocationCalls += 1;
      // Two ABI scratch allocations succeed; the serde output pair fails.
      return allocationCalls % 3 === 0 ? 0 : exports.capnp_alloc(len);
    },
  };
  for (let i = 0; i < 2000; i++) {
    assertThrows(() => WasmSerde.fromExports(wrapped), /capnp_alloc failed/);
  }
  const ptr = exports.capnp_alloc(1);
  assert(
    ptr !== 0,
    "failed serde construction must release earlier ABI scratch",
  );
  exports.capnp_free(ptr, 1);
  // Failed constructors must not register a live shared-module wrapper.
  using abi = new WasmAbi(exports);
  abi.shutdown();
});

Deno.test("real wasm peer factory unwinds owned ABI on peer creation failure", async () => {
  const exports = getCapnpWasmExports(await instance());
  const wrapped = { ...exports, capnp_peer_new: () => 0 };
  for (let i = 0; i < 2000; i++) {
    assertThrows(() => WasmPeer.fromExports(wrapped), /capnp_peer_new failed/);
  }
  const ptr = exports.capnp_alloc(1);
  assert(ptr !== 0, "failed peer factory must release ABI scratch");
  exports.capnp_free(ptr, 1);
  using abi = new WasmAbi(exports);
  abi.shutdown();
});

Deno.test("real wasm ABI constructor unwinds after a host export throws", async () => {
  const exports = getCapnpWasmExports(await instance());
  let allocationCalls = 0;
  const wrapped = {
    ...exports,
    capnp_alloc(len: number): number {
      allocationCalls += 1;
      if (allocationCalls % 2 === 0) throw new Error("injected allocator trap");
      return exports.capnp_alloc(len);
    },
  };
  for (let i = 0; i < 2000; i++) {
    assertThrows(() => new WasmAbi(wrapped), /injected allocator trap/);
  }
  const ptr = exports.capnp_alloc(1);
  assert(ptr !== 0, "failed ABI constructor must release earlier scratch");
  exports.capnp_free(ptr, 1);
  using abi = new WasmAbi(exports);
  abi.shutdown();
});

Deno.test("real wasm factory owner can close before peers borrowing its ABI", async () => {
  const exports = getCapnpWasmExports(await instance());
  for (let i = 0; i < 2000; i++) {
    const owner = WasmPeer.fromExports(exports);
    const borrowed = WasmPeer.create(owner.abi);
    owner.close();
    assertEquals(owner.abi.closed, false);
    assertThrows(() => WasmPeer.create(owner.abi), /closing/);
    assertEquals(borrowed.popOutgoingFrame(), null);
    borrowed.close();
    assertEquals(owner.abi.closed, true);
  }
  const ptr = exports.capnp_alloc(1);
  assert(ptr !== 0);
  exports.capnp_free(ptr, 1);
});

Deno.test("real wasm serde can close before peers borrowing its ABI", async () => {
  const moduleInstance = await instance();
  for (let i = 0; i < 2000; i++) {
    const serde = WasmSerde.fromInstance(moduleInstance);
    const peer = WasmPeer.create(serde.abi);
    serde.close();
    assertEquals(serde.closed, true);
    assertEquals(serde.abi.closed, false);
    assertEquals(peer.popOutgoingFrame(), null);
    peer.close();
    assertEquals(serde.abi.closed, true);
  }
});
