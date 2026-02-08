import {
  CapnpFrameFramer,
  decodeBootstrapRequestFrame,
  decodeCallRequestFrame,
  decodeFinishFrame,
  decodeReleaseFrame,
  decodeReturnFrame,
  decodeRpcMessageTag,
  encodeBootstrapRequestFrame,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  encodeReturnExceptionFrame,
  encodeReturnResultsFrame,
  ProtocolError,
  validateCapnpFrame,
} from "../mod.ts";
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

/**
 * Asserts that a function either succeeds or throws a ProtocolError.
 * If any other error type is thrown, the assertion fails.
 */
function assertProtocolErrorOnly(
  fn: () => void,
  context: string,
): void {
  try {
    fn();
  } catch (error) {
    assert(
      error instanceof ProtocolError,
      `unexpected non-ProtocolError in ${context}: ${
        error instanceof Error
          ? error.constructor.name + ": " + error.message
          : String(error)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Fuzz: decodeRpcMessageTag with random bytes
// ---------------------------------------------------------------------------
Deno.test("fuzz: decodeRpcMessageTag handles random byte inputs deterministically", () => {
  const rand = mulberry32(0xf00dbabe);

  for (let i = 0; i < 600; i += 1) {
    const len = randomInt(rand, 0, 4096);
    const frame = randomBytes(rand, len);
    assertProtocolErrorOnly(
      () => decodeRpcMessageTag(frame),
      `decodeRpcMessageTag iter=${i} len=${len}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Fuzz: decodeBootstrapRequestFrame with random bytes
// ---------------------------------------------------------------------------
Deno.test("fuzz: decodeBootstrapRequestFrame handles random byte inputs deterministically", () => {
  const rand = mulberry32(0xb00757a9);

  for (let i = 0; i < 600; i += 1) {
    const len = randomInt(rand, 0, 4096);
    const frame = randomBytes(rand, len);
    assertProtocolErrorOnly(
      () => decodeBootstrapRequestFrame(frame),
      `decodeBootstrapRequestFrame iter=${i} len=${len}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Fuzz: decodeCallRequestFrame with random bytes
// ---------------------------------------------------------------------------
Deno.test("fuzz: decodeCallRequestFrame handles random byte inputs deterministically", () => {
  const rand = mulberry32(0xca11f4a3);

  for (let i = 0; i < 600; i += 1) {
    const len = randomInt(rand, 0, 4096);
    const frame = randomBytes(rand, len);
    assertProtocolErrorOnly(
      () => decodeCallRequestFrame(frame),
      `decodeCallRequestFrame iter=${i} len=${len}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Fuzz: decodeReturnFrame with random bytes
// ---------------------------------------------------------------------------
Deno.test("fuzz: decodeReturnFrame handles random byte inputs deterministically", () => {
  const rand = mulberry32(0x4e7f4a3e);

  for (let i = 0; i < 600; i += 1) {
    const len = randomInt(rand, 0, 4096);
    const frame = randomBytes(rand, len);
    assertProtocolErrorOnly(
      () => decodeReturnFrame(frame),
      `decodeReturnFrame iter=${i} len=${len}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Fuzz: decodeFinishFrame with random bytes
// ---------------------------------------------------------------------------
Deno.test("fuzz: decodeFinishFrame handles random byte inputs deterministically", () => {
  const rand = mulberry32(0xf121500d);

  for (let i = 0; i < 600; i += 1) {
    const len = randomInt(rand, 0, 4096);
    const frame = randomBytes(rand, len);
    assertProtocolErrorOnly(
      () => decodeFinishFrame(frame),
      `decodeFinishFrame iter=${i} len=${len}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Fuzz: decodeReleaseFrame with random bytes
// ---------------------------------------------------------------------------
Deno.test("fuzz: decodeReleaseFrame handles random byte inputs deterministically", () => {
  const rand = mulberry32(0x4e1ea5ed);

  for (let i = 0; i < 600; i += 1) {
    const len = randomInt(rand, 0, 4096);
    const frame = randomBytes(rand, len);
    assertProtocolErrorOnly(
      () => decodeReleaseFrame(frame),
      `decodeReleaseFrame iter=${i} len=${len}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Fuzz: multi-segment frames with random segment counts and sizes
// ---------------------------------------------------------------------------
Deno.test("fuzz: decode functions handle multi-segment frames with random geometry", () => {
  const rand = mulberry32(0x5e6aaaa7);
  const decoders = [
    { name: "decodeRpcMessageTag", fn: decodeRpcMessageTag },
    { name: "decodeBootstrapRequestFrame", fn: decodeBootstrapRequestFrame },
    { name: "decodeCallRequestFrame", fn: decodeCallRequestFrame },
    { name: "decodeReturnFrame", fn: decodeReturnFrame },
    { name: "decodeFinishFrame", fn: decodeFinishFrame },
    { name: "decodeReleaseFrame", fn: decodeReleaseFrame },
  ];

  for (let i = 0; i < 500; i += 1) {
    const segmentCount = randomInt(rand, 1, 8);
    const segmentWords: number[] = [];
    for (let s = 0; s < segmentCount; s += 1) {
      segmentWords.push(randomInt(rand, 0, 32));
    }
    const frame = buildFrame(segmentWords);

    // Fill body with random bytes instead of the deterministic pattern
    const headerU32Count = 1 + segmentCount;
    const headerBytes = Math.ceil((headerU32Count * 4) / WORD_BYTES) *
      WORD_BYTES;
    for (let b = headerBytes; b < frame.byteLength; b += 1) {
      frame[b] = randomInt(rand, 0, 255);
    }

    const decoder = decoders[randomInt(rand, 0, decoders.length - 1)];
    assertProtocolErrorOnly(
      () => decoder.fn(frame),
      `multi-segment ${decoder.name} iter=${i} segments=[${
        segmentWords.join(",")
      }]`,
    );
  }
});

// ---------------------------------------------------------------------------
// Fuzz: frames with valid headers but corrupted payloads
// ---------------------------------------------------------------------------
Deno.test("fuzz: decode functions handle valid headers with corrupted payloads", () => {
  const rand = mulberry32(0xc044a07d);
  const encoders: Array<() => Uint8Array> = [
    () =>
      encodeBootstrapRequestFrame({
        questionId: randomInt(rand, 0, 0xffffffff),
      }),
    () =>
      encodeCallRequestFrame({
        questionId: randomInt(rand, 0, 0xffffffff),
        interfaceId: BigInt(randomInt(rand, 0, 0xffffffff)),
        methodId: randomInt(rand, 0, 0xffff),
        targetImportedCap: randomInt(rand, 0, 0xffffffff),
      }),
    () =>
      encodeReturnResultsFrame({
        answerId: randomInt(rand, 0, 0xffffffff),
      }),
    () =>
      encodeReturnExceptionFrame({
        answerId: randomInt(rand, 0, 0xffffffff),
        reason: "fuzz error",
      }),
    () =>
      encodeFinishFrame({
        questionId: randomInt(rand, 0, 0xffffffff),
      }),
    () =>
      encodeReleaseFrame({
        id: randomInt(rand, 0, 0xffffffff),
        referenceCount: randomInt(rand, 1, 100),
      }),
  ];

  const decoders: Array<{
    name: string;
    fn: (frame: Uint8Array) => unknown;
  }> = [
    { name: "decodeRpcMessageTag", fn: decodeRpcMessageTag },
    { name: "decodeBootstrapRequestFrame", fn: decodeBootstrapRequestFrame },
    { name: "decodeCallRequestFrame", fn: decodeCallRequestFrame },
    { name: "decodeReturnFrame", fn: decodeReturnFrame },
    { name: "decodeFinishFrame", fn: decodeFinishFrame },
    { name: "decodeReleaseFrame", fn: decodeReleaseFrame },
  ];

  for (let i = 0; i < 600; i += 1) {
    // Pick a random encoder to produce a structurally valid frame
    const encoderIndex = randomInt(rand, 0, encoders.length - 1);
    const validFrame = encoders[encoderIndex]();

    // Clone and corrupt parts of the payload (after the 8-byte framing header)
    const corrupted = new Uint8Array(validFrame);
    const corruptionCount = randomInt(rand, 1, 16);
    for (let c = 0; c < corruptionCount; c += 1) {
      if (corrupted.byteLength > 8) {
        const pos = randomInt(rand, 8, corrupted.byteLength - 1);
        corrupted[pos] = randomInt(rand, 0, 255);
      }
    }

    // Try every decoder against the corrupted frame
    const decoder = decoders[randomInt(rand, 0, decoders.length - 1)];
    assertProtocolErrorOnly(
      () => decoder.fn(corrupted),
      `corrupted-payload ${decoder.name} iter=${i} encoder=${encoderIndex}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Fuzz: end-to-end random bytes -> framer -> decode
// ---------------------------------------------------------------------------
Deno.test("fuzz: end-to-end random bytes through framer and decode pipeline", () => {
  const rand = mulberry32(0xe2e7e57d);
  const decoders: Array<{
    name: string;
    fn: (frame: Uint8Array) => unknown;
  }> = [
    { name: "decodeRpcMessageTag", fn: decodeRpcMessageTag },
    { name: "decodeBootstrapRequestFrame", fn: decodeBootstrapRequestFrame },
    { name: "decodeCallRequestFrame", fn: decodeCallRequestFrame },
    { name: "decodeReturnFrame", fn: decodeReturnFrame },
    { name: "decodeFinishFrame", fn: decodeFinishFrame },
    { name: "decodeReleaseFrame", fn: decodeReleaseFrame },
  ];

  for (let i = 0; i < 500; i += 1) {
    const parts: Uint8Array[] = [];
    const frameCount = randomInt(rand, 1, 3);

    for (let f = 0; f < frameCount; f += 1) {
      if (rand() < 0.3) {
        // Pure random garbage
        parts.push(randomBytes(rand, randomInt(rand, 1, 64)));
      } else {
        // Structurally valid frame with random payload
        const segmentCount = randomInt(rand, 1, 4);
        const words: number[] = [];
        for (let s = 0; s < segmentCount; s += 1) {
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

          // Validate the frame
          validateCapnpFrame(frame, {
            maxSegmentCount: 64,
            maxFrameBytes: 8192,
            maxTraversalWords: 2048,
            maxNestingDepth: 32,
          });

          // Try each decoder against the extracted frame
          for (const decoder of decoders) {
            assertProtocolErrorOnly(
              () => decoder.fn(frame),
              `e2e ${decoder.name} iter=${i}`,
            );
          }
        }
      }
    } catch (error) {
      assert(
        error instanceof ProtocolError,
        `unexpected non-ProtocolError in e2e fuzz iter=${i}: ${
          error instanceof Error
            ? error.constructor.name + ": " + error.message
            : String(error)
        }`,
      );
    }
  }
});
