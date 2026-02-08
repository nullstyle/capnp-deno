import {
  CapnpFrameFramer,
  ProtocolError,
  validateCapnpFrame,
} from "../advanced.ts";
import { assert } from "./test_utils.ts";

const WORD_BYTES = 8;

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rand: () => number, min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

function randomBytes(rand: () => number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < out.byteLength; i += 1) {
    out[i] = randomInt(rand, 0, 255);
  }
  return out;
}

function buildFrame(segmentWords: number[]): Uint8Array {
  const segmentCount = segmentWords.length;
  const headerWords = 1 + segmentCount + (segmentCount % 2 === 0 ? 1 : 0);
  const headerBytes = headerWords * 4;
  const bodyBytes = segmentWords.reduce(
    (sum, words) => sum + words * WORD_BYTES,
    0,
  );

  const out = new Uint8Array(headerBytes + bodyBytes);
  const view = new DataView(out.buffer);
  view.setUint32(0, segmentCount - 1, true);
  for (let i = 0; i < segmentCount; i += 1) {
    view.setUint32(4 + i * 4, segmentWords[i], true);
  }

  for (let i = headerBytes; i < out.byteLength; i += 1) {
    out[i] = (i * 17) & 0xff;
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}

Deno.test("fuzz: validateCapnpFrame handles random byte inputs deterministically", () => {
  const rand = mulberry32(0xdecafbad);

  for (let i = 0; i < 600; i += 1) {
    const frame = randomBytes(rand, randomInt(rand, 1, 192));
    try {
      validateCapnpFrame(frame, {
        maxSegmentCount: 64,
        maxFrameBytes: 4096,
        maxTraversalWords: 1024,
        maxNestingDepth: 16,
      });
    } catch (error) {
      assert(
        error instanceof ProtocolError,
        `unexpected non-ProtocolError during random validate at iter=${i}: ${
          String(error)
        }`,
      );
    }
  }
});

Deno.test("fuzz: CapnpFrameFramer handles random chunked streams without crashes", () => {
  const rand = mulberry32(0xcafebeef);

  for (let i = 0; i < 300; i += 1) {
    const parts: Uint8Array[] = [];
    const frameCount = randomInt(rand, 1, 3);

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      if (rand() < 0.3) {
        parts.push(randomBytes(rand, randomInt(rand, 1, 48)));
      } else {
        const segmentCount = randomInt(rand, 1, 4);
        const words: number[] = [];
        for (let segmentId = 0; segmentId < segmentCount; segmentId += 1) {
          words.push(randomInt(rand, 0, 16));
        }
        parts.push(buildFrame(words));
      }
    }

    const stream = concat(parts);
    const framer = new CapnpFrameFramer({
      maxSegmentCount: 64,
      maxFrameBytes: 8192,
      maxBufferedBytes: 16384,
      maxTraversalWords: 2048,
      maxNestingDepth: 32,
    });

    let cursor = 0;
    try {
      while (cursor < stream.byteLength) {
        const chunkLen = Math.min(
          randomInt(rand, 1, 23),
          stream.byteLength - cursor,
        );
        framer.push(stream.subarray(cursor, cursor + chunkLen));
        cursor += chunkLen;

        while (true) {
          const frame = framer.popFrame();
          if (!frame) break;
          validateCapnpFrame(frame, {
            maxSegmentCount: 64,
            maxFrameBytes: 8192,
            maxTraversalWords: 2048,
            maxNestingDepth: 32,
          });
        }
      }
    } catch (error) {
      assert(
        error instanceof ProtocolError,
        `unexpected non-ProtocolError in framer fuzz at iter=${i}: ${
          String(error)
        }`,
      );
    }
  }
});
