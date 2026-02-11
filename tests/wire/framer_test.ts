import { CapnpFrameFramer } from "../../advanced.ts";
import { assertBytes, assertEquals, assertThrows } from "../test_utils.ts";

function buildSingleSegmentFrame(firstByte: number): Uint8Array {
  const frame = new Uint8Array(16);
  const view = new DataView(frame.buffer);

  // segmentCount-1 = 0 (one segment)
  view.setUint32(0, 0, true);
  // segment 0 size = 1 word (8 bytes)
  view.setUint32(4, 1, true);
  frame[8] = firstByte & 0xff;
  return frame;
}

Deno.test("CapnpFrameFramer assembles fragmented frame", () => {
  const frame = buildSingleSegmentFrame(0x11);
  const framer = new CapnpFrameFramer();

  framer.push(frame.subarray(0, 5));
  assertEquals(framer.popFrame(), null);

  framer.push(frame.subarray(5));
  const out = framer.popFrame();
  if (!out) throw new Error("expected assembled frame");
  assertBytes(out, Array.from(frame));
  assertEquals(framer.popFrame(), null);
});

Deno.test("CapnpFrameFramer splits coalesced frames", () => {
  const first = buildSingleSegmentFrame(0x22);
  const second = buildSingleSegmentFrame(0x33);
  const combined = new Uint8Array(first.length + second.length);
  combined.set(first, 0);
  combined.set(second, first.length);

  const framer = new CapnpFrameFramer();
  framer.push(combined);

  const out1 = framer.popFrame();
  if (!out1) throw new Error("expected first frame");
  assertBytes(out1, Array.from(first));

  const out2 = framer.popFrame();
  if (!out2) throw new Error("expected second frame");
  assertBytes(out2, Array.from(second));

  assertEquals(framer.popFrame(), null);
});

Deno.test("CapnpFrameFramer enforces maxFrameBytes", () => {
  const frame = buildSingleSegmentFrame(0x44);
  const framer = new CapnpFrameFramer({ maxFrameBytes: frame.byteLength - 1 });

  framer.push(frame);
  assertThrows(
    () => framer.popFrame(),
    /exceeds configured limit/i,
  );
});

Deno.test("CapnpFrameFramer enforces maxTraversalWords", () => {
  const frame = buildSingleSegmentFrame(0x77);
  const framer = new CapnpFrameFramer({ maxTraversalWords: 0 });

  framer.push(frame);
  assertThrows(
    () => framer.popFrame(),
    /traversal words .* exceeds configured limit/i,
  );
});

Deno.test("CapnpFrameFramer enforces maxSegmentCount", () => {
  const frame = buildSingleSegmentFrame(0x55);
  const framer = new CapnpFrameFramer({ maxSegmentCount: 0 });

  framer.push(frame.subarray(0, 8));
  assertThrows(
    () => framer.popFrame(),
    /segment count .* exceeds configured limit/i,
  );
});

Deno.test("CapnpFrameFramer reuses buffer capacity across frames (growth-factor)", () => {
  const framer = new CapnpFrameFramer();

  // Push 10 frames one byte at a time to stress incremental growth.
  // With the old exact-fit allocator this would be O(n^2) allocations.
  for (let round = 0; round < 10; round++) {
    const frame = buildSingleSegmentFrame(round & 0xff);
    for (let i = 0; i < frame.byteLength; i++) {
      framer.push(frame.subarray(i, i + 1));
    }
    const out = framer.popFrame();
    if (!out) throw new Error(`expected frame on round ${round}`);
    assertBytes(out, Array.from(frame));
    assertEquals(framer.bufferedBytes(), 0);
  }
});

Deno.test("CapnpFrameFramer enforces maxBufferedBytes", () => {
  const frame = buildSingleSegmentFrame(0x66);
  const framer = new CapnpFrameFramer({
    maxBufferedBytes: frame.byteLength - 1,
  });

  assertThrows(
    () => framer.push(frame),
    /buffer size .* exceeds configured limit/i,
  );
});
