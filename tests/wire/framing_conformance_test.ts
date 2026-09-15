import { CapnpFrameFramer } from "../../src/rpc/wire/framer.ts";
import { ProtocolError } from "../../src/errors.ts";
import { assert, assertEquals, assertThrows } from "../test_utils.ts";
import corpus from "../fixtures/framing/framing_fixtures.json" with {
  type: "json",
};
import provenance from "../fixtures/framing/provenance.json" with {
  type: "json",
};

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(
    hex.match(/../g) ?? [],
    (pair) => Number.parseInt(pair, 16),
  );
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

Deno.test("pinned capnp-zig framing corpus inventory", async () => {
  const raw = await Deno.readFile(
    new URL("../fixtures/framing/framing_fixtures.json", import.meta.url),
  );
  const digest = await crypto.subtle.digest("SHA-256", raw);
  assertEquals(hex(new Uint8Array(digest)), provenance.sha256);
  assertEquals(corpus.version, 1);
  assertEquals(corpus.cases.length, provenance.caseCount);
  assertEquals(provenance.revision, "c30abbbdde561931f3f179884f24d1309c5599ae");
});

for (const fixture of corpus.cases) {
  Deno.test(`capnp-zig framing conformance: ${fixture.name}`, () => {
    const framer = new CapnpFrameFramer({
      maxSegmentCount: corpus.constants.max_segment_count,
      maxTraversalWords: corpus.constants.max_frame_words,
      maxFrameBytes: corpus.constants.default_max_buffered_bytes,
      maxBufferedBytes: "options" in fixture
        ? fixture.options!.max_buffered_bytes
        : corpus.constants.default_max_buffered_bytes,
    });
    const frames: string[] = [];
    let error: string | null = null;
    let errorOn: "push" | "pop" | null = null;
    for (const chunk of fixture.chunks) {
      let phase: "push" | "pop" = "push";
      try {
        framer.push(bytes(chunk));
        phase = "pop";
        for (
          let frame = framer.popFrame();
          frame !== null;
          frame = framer.popFrame()
        ) {
          frames.push(hex(frame));
        }
      } catch (caught) {
        assert(caught instanceof ProtocolError);
        // Deno deliberately exposes ProtocolError rather than Zig error-set names.
        // Preserve the classification and operation where rejection occurs.
        error = /segment count/i.test(caught.message)
          ? "InvalidFrame"
          : "FrameTooLarge";
        errorOn = phase;
        break;
      }
    }
    assertEquals(JSON.stringify(frames), JSON.stringify(fixture.expect.frames));
    assertEquals(error, fixture.expect.error);
    assertEquals(errorOn, fixture.expect.error_on);
  });
}

Deno.test("framer rejects an oversized undrained batch by default before copying", () => {
  const framer = new CapnpFrameFramer();
  assertThrows(
    () => framer.push(new Uint8Array(64 * 1024 * 1024 + 1)),
    /buffer size/,
  );
  assertEquals(framer.bufferedBytes(), 0);
});

Deno.test("framer explicit buffer override permits coalesced batches larger than one frame", () => {
  const frame = bytes("0000000001000000abababababababab");
  const combined = new Uint8Array(frame.length * 2);
  combined.set(frame);
  combined.set(frame, frame.length);
  const framer = new CapnpFrameFramer({
    maxFrameBytes: frame.length,
    maxBufferedBytes: Infinity,
  });
  framer.push(combined);
  assertEquals(hex(framer.popFrame()!), hex(frame));
  assertEquals(hex(framer.popFrame()!), hex(frame));
});
