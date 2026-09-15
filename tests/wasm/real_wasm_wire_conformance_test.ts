import {
  decodeReleaseFrame,
  decodeReturnFrame,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReturnResultsFrame,
  instantiatePeer,
  type WasmPeer,
} from "../../src/advanced.ts";
import {
  decodeAnyPointerMessageFromReader,
  MessageReader,
  WasmSerde,
} from "../../src/encoding.ts";
import { assert, assertEquals, assertThrows } from "../test_utils.ts";
import { far, frame } from "../fixtures/wire_bytes.ts";

async function serde(): Promise<WasmSerde> {
  const bytes = await Deno.readFile(
    new URL("../../generated/capnp_deno.wasm", import.meta.url),
  );
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return WasmSerde.fromInstance(instance);
}

function nameFromTypeScript(bytes: Uint8Array): string | null {
  const reader = new MessageReader(bytes);
  const root = reader.readRootStruct();
  return root.pointerCount === 0
    ? ""
    : reader.readTextPointer(root.segmentId, reader.pointerWordIndex(root, 0));
}

Deno.test("wire conformance: current Zig WASM and TypeScript agree on double-far content and empty presence", async () => {
  using runtime = await serde();
  const rootTag = 1n << 32n | 2n << 48n;
  const personWords = [37n, 5n | 2n << 32n | 4n << 35n, 0n, 0x616441n];
  const cases = [
    frame([[rootTag, ...personWords]]),
    frame([[far(1, 0)], [rootTag, ...personWords]]),
    frame([[far(1, 0, true)], [far(2, 2), rootTag], [
      0xbadn,
      0xbadn,
      ...personWords,
    ]]),
    frame([[far(1, 0, true)], [far(2, 0), 0n], []]),
  ];
  for (const [index, bytes] of cases.entries()) {
    const actual = JSON.parse(
      runtime.decodeToJson("capnp_example_person_to_json", bytes),
    );
    assertEquals(actual.name, nameFromTypeScript(bytes));
    assertEquals(actual.age, index === 3 ? 0 : 37);
    assert(new MessageReader(bytes).readStructPointer(0, 0) !== null);
  }
});

Deno.test("wire conformance: current Zig WASM and TypeScript reject malformed Text and child bounds", async () => {
  using runtime = await serde();
  const rootTag = 1n << 32n | 2n << 48n;
  const cases = [
    [2, 0x6968n, 1], // No trailing NUL.
    [0, 0n, 1], // Non-null zero-length Text.
    [3, 0xafc0n, 1], // Invalid UTF-8 before the NUL.
    [4, 0x616441n, 100], // Child target outside the segment.
  ] as const;
  for (const [count, content, offset] of cases) {
    const textPointer = 1n | BigInt(offset) << 2n | 2n << 32n |
      BigInt(count) << 35n;
    const bytes = frame([[far(1, 0, true)], [far(2, 0), rootTag], [
      37n,
      textPointer,
      0n,
      content,
    ]]);
    assertThrows(() => nameFromTypeScript(bytes));
    assertThrows(() =>
      runtime.decodeToJson("capnp_example_person_to_json", bytes)
    );
  }
});

// The result-payload ABI invokes Zig's AnyPointer clone. Supplying the raw
// payload here is essential: the TS Return encoder would normalize far
// pointers before the WASM implementation could see them.
async function wirePeer() {
  const { peer } = await instantiatePeer(
    new URL("../../generated/capnp_deno.wasm", import.meta.url),
  );
  return peer;
}

function beginCall(peer: WasmPeer, questionId: number): void {
  assertEquals(
    peer.pushFrame(encodeCallRequestFrame({
      questionId,
      targetImportedCap: 0,
      interfaceId: 1n,
      methodId: 0,
      paramsContent: frame([[0xfffffffcn]]),
    })).frames.length,
    0,
  );
  assertEquals(peer.abi.popHostCall(peer.handle)?.questionId, questionId);
}

function resultContent(peer: WasmPeer, questionId: number): Uint8Array {
  const frames = peer.drainOutgoingFrames().frames;
  assertEquals(frames.length, 1);
  const result = decodeReturnFrame(frames[0]);
  assert(result.kind === "results");
  assertEquals(result.answerId, questionId);
  peer.pushFrame(encodeFinishFrame({ questionId, releaseResultCaps: true }));
  return result.contentBytes;
}

Deno.test("wire conformance: Zig WASM clones evolved lists without dropping unknown data or pointers", async () => {
  using peer = await wirePeer();
  const tag = 8n | 2n << 32n | 2n << 48n;
  const elements = [
    42n,
    0xdeadbeefn,
    0n,
    0n,
    43n,
    0xcafebaben,
    0n,
    0n,
  ];
  const list = 1n | 7n << 32n | 8n << 35n;
  const cases = [
    frame([[list, tag, ...elements]]),
    frame([[far(1, 0)], [list | 4n, 0xbadn, tag, ...elements]]),
    frame([[far(1, 0, true)], [far(2, 2), list], [
      0xbadn,
      0xbadn,
      tag,
      ...elements,
    ]]),
  ];
  for (const [index, input] of cases.entries()) {
    const question = index + 1;
    beginCall(peer, question);
    peer.abi.respondHostCallResults(peer.handle, question, input);
    const wasm = new MessageReader(resultContent(peer, question));
    const ts = new MessageReader(
      decodeAnyPointerMessageFromReader(new MessageReader(input), 0, 0),
    );
    for (const copied of [wasm, ts]) {
      const view = copied.readListPointer(0, 0);
      assert(view?.kind === "inlineComposite");
      assertEquals(view.elementCount, 2);
      assertEquals(view.dataWordCount, 2);
      assertEquals(view.pointerCount, 2);
      for (const [offset, expected] of elements.entries()) {
        assertEquals(
          copied.readWord(view.segmentId, view.tagWord + 1 + offset),
          expected,
        );
      }
    }
  }
});

Deno.test("wire conformance: WASM rejects cyclic and amplified copies without settling the pending call", async () => {
  using peer = await wirePeer();
  const aliases = 1024;
  const blobWords = 8192;
  const pointers = Array.from(
    { length: aliases },
    (_, index) =>
      1n | BigInt(aliases - index - 1) << 2n | 5n << 32n |
      BigInt(blobWords) << 35n,
  );
  const cases = [
    frame([[1n << 48n, 0xfffffffcn | 1n << 48n]]),
    frame([[
      BigInt(aliases) << 48n,
      ...pointers,
      ...Array<bigint>(blobWords).fill(42n),
    ]]),
    frame([[1n | 7n << 32n | 1n << 35n, 8n | 1n << 32n, 7n, 8n]]),
  ];
  for (const [index, input] of cases.entries()) {
    assertThrows(() =>
      decodeAnyPointerMessageFromReader(new MessageReader(input), 0, 0)
    );
    const question = index + 1;
    beginCall(peer, question);
    assertThrows(() =>
      peer.abi.respondHostCallResults(peer.handle, question, input)
    );
    assertEquals(peer.drainOutgoingFrames().frames.length, 0);
    assertEquals(peer.abi.exports.capnp_last_error_code(), 0);
    // A rejected clone must leave the same call available for a valid result.
    peer.abi.respondHostCallResults(
      peer.handle,
      question,
      frame([[1n << 32n, 808n]]),
    );
    const reader = new MessageReader(resultContent(peer, question));
    assertEquals(
      reader.readBigUint64InStruct(reader.readRootStruct(), 0),
      808n,
    );
  }
});

Deno.test("wire conformance: WASM result frames retain evolved-list capabilities and Finish releases their exports", async () => {
  using peer = await wirePeer();
  const elements = [
    42n,
    0xdeadbeefn,
    3n,
    3n | 1n << 32n,
    43n,
    0xcafebaben,
    3n | 2n << 32n,
    0n,
  ];
  const content = frame([[
    1n | 7n << 32n | 8n << 35n,
    8n | 2n << 32n | 2n << 48n,
    ...elements,
  ]]);
  const capTable = [100, 107, 109].map((id) => ({ tag: 1, id }));
  beginCall(peer, 1);
  peer.abi.respondHostCallReturnFrame(
    peer.handle,
    encodeReturnResultsFrame({ answerId: 1, content, capTable }),
  );
  const output = peer.drainOutgoingFrames().frames;
  assertEquals(output.length, 1);
  const result = decodeReturnFrame(output[0]);
  assert(result.kind === "results");
  assertEquals(result.capTable.length, capTable.length);
  for (const [index, expected] of capTable.entries()) {
    assertEquals(result.capTable[index].id, expected.id);
    assertEquals(result.capTable[index].tag, expected.tag);
  }
  const copied = new MessageReader(result.contentBytes);
  const list = copied.readListPointer(0, 0);
  assert(list?.kind === "inlineComposite");
  for (const [offset, expected] of elements.entries()) {
    assertEquals(
      copied.readWord(list.segmentId, list.tagWord + 1 + offset),
      expected,
    );
  }
  // A retained returned capability routes back to the host before Finish.
  assertEquals(
    peer.pushFrame(
      encodeCallRequestFrame({
        questionId: 2,
        targetImportedCap: 107,
        interfaceId: 1n,
        methodId: 0,
      }),
    ).frames.length,
    0,
  );
  assertEquals(peer.abi.popHostCall(peer.handle)?.questionId, 2);
  peer.abi.respondHostCallResults(peer.handle, 2, frame([[0xfffffffcn]]));
  resultContent(peer, 2);
  peer.pushFrame(encodeFinishFrame({ questionId: 1, releaseResultCaps: true }));
  for (const [index, id] of [100, 107, 109].entries()) {
    const output = peer.pushFrame(
      encodeCallRequestFrame({
        questionId: 3 + index,
        targetImportedCap: id,
        interfaceId: 1n,
        methodId: 0,
      }),
    ).frames;
    assertEquals(output.length, 1);
    const result = decodeReturnFrame(output[0]);
    assert(result.kind === "exception");
    assert(
      /unknown capability|host call failed/i.test(result.reason),
      result.reason,
    );
    assertEquals(peer.abi.popHostCall(peer.handle), null);
  }
});

Deno.test("wire conformance: untyped copying rejects a legacy list tag instead of treating it as a struct", async () => {
  // Historical Layout A puts a nonzero list element count in the landing
  // struct tag. It is not a canonical struct, and this ABI's untyped clone
  // does not offer the native typed legacy-list decoder.
  const input = frame([[far(1, 0, true)], [far(2, 0), 8n | 1n << 32n], [
    42n,
    43n,
  ]]);
  assertThrows(() =>
    decodeAnyPointerMessageFromReader(new MessageReader(input), 0, 0)
  );
  using peer = await wirePeer();
  beginCall(peer, 1);
  assertThrows(() => peer.abi.respondHostCallResults(peer.handle, 1, input));
  assertEquals(peer.drainOutgoingFrames().frames.length, 0);
  peer.abi.respondHostCallResults(peer.handle, 1, frame([[1n << 32n, 42n]]));
  resultContent(peer, 1);
});

Deno.test("wire conformance: failed WASM copy retains parameter grants until the same call settles", async () => {
  using peer = await wirePeer();
  const frames = peer.pushFrame(encodeCallRequestFrame({
    questionId: 1,
    targetImportedCap: 0,
    interfaceId: 1n,
    methodId: 0,
    paramsContent: frame([[3n]]),
    paramsCapTable: [{ tag: 1, id: 77 }],
  })).frames;
  assertEquals(frames.length, 0);
  assertEquals(peer.abi.popHostCall(peer.handle)?.questionId, 1);
  const cyclic = frame([[1n << 48n, 0xfffffffcn | 1n << 48n]]);
  assertThrows(() => peer.abi.respondHostCallResults(peer.handle, 1, cyclic));
  // No failed Return and no premature Release may escape the rejected copy.
  assertEquals(peer.drainOutgoingFrames().frames.length, 0);
  peer.abi.respondHostCallResults(peer.handle, 1, frame([[0xfffffffcn]]));
  const settled = peer.drainOutgoingFrames().frames;
  assertEquals(settled.length, 2);
  const result = decodeReturnFrame(settled[0]);
  assert(result.kind === "results");
  assertEquals(result.releaseParamCaps, false);
  const release = decodeReleaseFrame(settled[1]);
  assertEquals(release.id, 77);
  assertEquals(release.referenceCount, 1);
  peer.pushFrame(encodeFinishFrame({ questionId: 1, releaseResultCaps: true }));
  assertEquals(peer.drainOutgoingFrames().frames.length, 0);
});
