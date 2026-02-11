import { CapnpReader } from "../../tools/capnpc-deno/capnp_reader.ts";
import { encodeCodeGeneratorResponse } from "../../tools/capnpc-deno/plugin_response.ts";
import { assert, assertEquals, assertThrows } from "../test_utils.ts";

const WORD_BYTES = 8;
const MASK_30 = 0x3fff_ffffn;

function decodeResponse(
  bytes: Uint8Array,
): Array<{ id: bigint; filename: string; content: string }> {
  const root = new CapnpReader(bytes).root();
  const list = root.readStructList(0);
  if (!list) return [];

  const out: Array<{ id: bigint; filename: string; content: string }> = [];
  for (let i = 0; i < list.len(); i += 1) {
    const item = list.get(i);
    out.push({
      id: item.readU64(0),
      filename: item.readText(0) ?? "",
      content: item.readText(1) ?? "",
    });
  }
  return out;
}

function splitSegments(message: Uint8Array): Uint8Array[] {
  const view = new DataView(
    message.buffer,
    message.byteOffset,
    message.byteLength,
  );
  const segmentCount = view.getUint32(0, true) + 1;
  const headerWords = 1 + segmentCount + (segmentCount % 2 === 0 ? 1 : 0);
  const headerBytes = headerWords * 4;
  const segments: Uint8Array[] = [];
  let cursor = headerBytes;
  for (let i = 0; i < segmentCount; i += 1) {
    const sizeWords = view.getUint32(4 + i * 4, true);
    const sizeBytes = sizeWords * WORD_BYTES;
    segments.push(message.subarray(cursor, cursor + sizeBytes));
    cursor += sizeBytes;
  }
  return segments;
}

function buildMessage(segments: Uint8Array[]): Uint8Array {
  const segmentCount = segments.length;
  const headerWords = 1 + segmentCount + (segmentCount % 2 === 0 ? 1 : 0);
  const headerBytes = headerWords * 4;
  const bodyBytes = segments.reduce(
    (sum, segment) => sum + segment.byteLength,
    0,
  );
  const out = new Uint8Array(headerBytes + bodyBytes);
  const view = new DataView(out.buffer);
  view.setUint32(0, segmentCount - 1, true);
  for (let i = 0; i < segmentCount; i += 1) {
    view.setUint32(4 + i * 4, segments[i].byteLength / WORD_BYTES, true);
  }
  let cursor = headerBytes;
  for (const segment of segments) {
    out.set(segment, cursor);
    cursor += segment.byteLength;
  }
  return out;
}

function getWord(segment: Uint8Array, wordIndex: number): bigint {
  return new DataView(segment.buffer, segment.byteOffset, segment.byteLength)
    .getBigUint64(
      wordIndex * WORD_BYTES,
      true,
    );
}

function setWord(segment: Uint8Array, wordIndex: number, value: bigint): void {
  new DataView(segment.buffer, segment.byteOffset, segment.byteLength)
    .setBigUint64(
      wordIndex * WORD_BYTES,
      value,
      true,
    );
}

function signed30(raw: bigint): number {
  const value = Number(raw & MASK_30);
  return (value & (1 << 29)) !== 0 ? value - (1 << 30) : value;
}

function farPointerWord(
  targetSegmentId: number,
  landingPadWord: number,
  isDoubleFar: boolean,
): bigint {
  let word = 0x2n;
  if (isDoubleFar) word |= 0x1n << 2n;
  word |= BigInt(landingPadWord & 0x1fff_ffff) << 3n;
  word |= BigInt(targetSegmentId >>> 0) << 32n;
  return word;
}

function listPointerWord(elementSize: number, elementCount: number): bigint {
  return 0x1n |
    (BigInt(elementSize & 0x7) << 32n) |
    (BigInt(elementCount & 0x1fff_ffff) << 35n);
}

function toSingleFarRoot(message: Uint8Array): Uint8Array {
  const segments = splitSegments(message);
  assertEquals(segments.length, 1);
  const segment0 = new Uint8Array(WORD_BYTES);
  const segment1 = new Uint8Array(segments[0]);
  setWord(segment0, 0, farPointerWord(1, 0, false));
  return buildMessage([segment0, segment1]);
}

function toDoubleFarRoot(message: Uint8Array): Uint8Array {
  const segments = splitSegments(message);
  assertEquals(segments.length, 1);
  const source = segments[0];
  const rootWord = getWord(source, 0);
  const rootOffset = signed30((rootWord >> 2n) & MASK_30);
  assertEquals(rootOffset, 0);

  const segment0 = new Uint8Array(WORD_BYTES);
  const segment1 = new Uint8Array(WORD_BYTES * 2);
  const segment2 = new Uint8Array(source.byteLength);

  setWord(segment0, 0, farPointerWord(1, 0, true));
  setWord(segment1, 0, farPointerWord(2, 0, false));
  setWord(segment1, 1, rootWord);
  segment2.set(source.subarray(WORD_BYTES), WORD_BYTES);

  return buildMessage([segment0, segment1, segment2]);
}

function findFirstFilenamePointerWord(message: Uint8Array): number {
  const segments = splitSegments(message);
  assertEquals(segments.length, 1);
  const segment = segments[0];

  const root = getWord(segment, 0);
  const rootOffset = signed30((root >> 2n) & MASK_30);
  const rootDataWords = Number((root >> 32n) & 0xffffn);
  const rootStart = 0 + 1 + rootOffset;
  const listPointerWordIndex = rootStart + rootDataWords;

  const listPointer = getWord(segment, listPointerWordIndex);
  const listOffset = signed30((listPointer >> 2n) & MASK_30);
  const listElementSize = Number((listPointer >> 32n) & 0x7n);
  assertEquals(listElementSize, 7);
  const listStart = listPointerWordIndex + 1 + listOffset;

  const tag = getWord(segment, listStart);
  const firstDataWords = Number((tag >> 32n) & 0xffffn);
  const firstElementStart = listStart + 1;
  return firstElementStart + firstDataWords;
}

function toSingleFarPointer(
  message: Uint8Array,
  pointerWordIndex: number,
): Uint8Array {
  const segments = splitSegments(message);
  assertEquals(segments.length, 1);
  const segment0 = new Uint8Array(segments[0]);
  const pointer = getWord(segment0, pointerWordIndex);
  const kind = Number(pointer & 0x3n);
  assertEquals(kind, 1);

  const offsetWords = signed30((pointer >> 2n) & MASK_30);
  const elementSize = Number((pointer >> 32n) & 0x7n);
  const elementCount = Number((pointer >> 35n) & 0x1fff_ffffn);
  assertEquals(elementSize, 2);

  const targetWord = pointerWordIndex + 1 + offsetWords;
  const payloadWords = Math.ceil(elementCount / WORD_BYTES);
  const segment1 = new Uint8Array((1 + payloadWords) * WORD_BYTES);
  setWord(segment1, 0, listPointerWord(elementSize, elementCount));
  segment1.set(
    segment0.subarray(
      targetWord * WORD_BYTES,
      (targetWord + payloadWords) * WORD_BYTES,
    ),
    WORD_BYTES,
  );

  setWord(segment0, pointerWordIndex, farPointerWord(1, 0, false));
  return buildMessage([segment0, segment1]);
}

function withPatchedNumberIsInteger(
  patch: (original: typeof Number.isInteger) => typeof Number.isInteger,
  fn: () => void,
): void {
  const numberMutable = Number as unknown as {
    isInteger: typeof Number.isInteger;
  };
  const original = numberMutable.isInteger;
  numberMutable.isInteger = patch(original);
  try {
    fn();
  } finally {
    numberMutable.isInteger = original;
  }
}

function withPatchedTextEncoderEncode(
  patch: (original: TextEncoder["encode"]) => TextEncoder["encode"],
  fn: () => void,
): void {
  const proto = TextEncoder.prototype as {
    encode: TextEncoder["encode"];
  };
  const original = proto.encode;
  proto.encode = patch(original);
  try {
    fn();
  } finally {
    proto.encode = original;
  }
}

Deno.test("capnpc-deno plugin response encoder handles empty output", () => {
  const encoded = encodeCodeGeneratorResponse([]);
  const decoded = decodeResponse(encoded);
  assertEquals(decoded.length, 0);
});

Deno.test("capnpc-deno plugin response encoder roundtrips files", () => {
  const encoded = encodeCodeGeneratorResponse([
    {
      id: 0x1234n,
      filename: "person_capnp.ts",
      content: "export const x = 1;\n",
    },
    {
      filename: "mod.ts",
      content: 'export * from "./person_capnp.ts";\n',
    },
  ]);
  const decoded = decodeResponse(encoded);
  assertEquals(decoded.length, 2);
  assertEquals(decoded[0].id, 0x1234n);
  assertEquals(decoded[0].filename, "person_capnp.ts");
  assertEquals(decoded[0].content, "export const x = 1;\n");
  assertEquals(decoded[1].id, 0n);
  assertEquals(decoded[1].filename, "mod.ts");
  assertEquals(decoded[1].content, 'export * from "./person_capnp.ts";\n');
});

Deno.test("capnpc-deno plugin response encoder is deterministic", () => {
  const files = [{ id: 1n, filename: "a.ts", content: "x" }];
  const bytes1 = encodeCodeGeneratorResponse(files);
  const bytes2 = encodeCodeGeneratorResponse(files);
  assertEquals(bytes1.byteLength, bytes2.byteLength);
  for (let i = 0; i < bytes1.byteLength; i += 1) {
    if (bytes1[i] !== bytes2[i]) {
      throw new Error(`encoded bytes differ at offset ${i}`);
    }
  }
  assert(bytes1.byteLength > 8, "expected non-empty payload");
});

Deno.test("capnpc-deno reader decodes single-far root pointer", () => {
  const encoded = encodeCodeGeneratorResponse([
    { id: 1n, filename: "a.ts", content: "x" },
  ]);
  const decoded = decodeResponse(toSingleFarRoot(encoded));
  assertEquals(decoded.length, 1);
  assertEquals(decoded[0].id, 1n);
  assertEquals(decoded[0].filename, "a.ts");
  assertEquals(decoded[0].content, "x");
});

Deno.test("capnpc-deno reader decodes double-far root pointer", () => {
  const encoded = encodeCodeGeneratorResponse([
    { id: 2n, filename: "b.ts", content: "y" },
  ]);
  const decoded = decodeResponse(toDoubleFarRoot(encoded));
  assertEquals(decoded.length, 1);
  assertEquals(decoded[0].id, 2n);
  assertEquals(decoded[0].filename, "b.ts");
  assertEquals(decoded[0].content, "y");
});

Deno.test("capnpc-deno reader decodes far pointer within struct field", () => {
  const encoded = encodeCodeGeneratorResponse([
    { id: 3n, filename: "c.ts", content: "z" },
  ]);
  const filenamePointerWord = findFirstFilenamePointerWord(encoded);
  const transformed = toSingleFarPointer(encoded, filenamePointerWord);
  const decoded = decodeResponse(transformed);
  assertEquals(decoded.length, 1);
  assertEquals(decoded[0].id, 3n);
  assertEquals(decoded[0].filename, "c.ts");
  assertEquals(decoded[0].content, "z");
});

Deno.test("capnpc-deno plugin response encoder validates bigint id bounds", () => {
  assertThrows(
    () =>
      encodeCodeGeneratorResponse([
        { id: -1n, filename: "neg.ts", content: "x" },
      ]),
    /out of u64 range/,
  );
  assertThrows(
    () =>
      encodeCodeGeneratorResponse([
        { id: 0x1_0000_0000_0000_0000n, filename: "overflow.ts", content: "x" },
      ]),
    /out of u64 range/,
  );
});

Deno.test("capnpc-deno plugin response encoder validates numeric id inputs", () => {
  assertThrows(
    () =>
      encodeCodeGeneratorResponse([
        { id: -1, filename: "neg.ts", content: "x" },
      ]),
    /non-negative safe integer/,
  );
  assertThrows(
    () =>
      encodeCodeGeneratorResponse([
        { id: 1.25, filename: "frac.ts", content: "x" },
      ]),
    /non-negative safe integer/,
  );
  assertThrows(
    () =>
      encodeCodeGeneratorResponse([
        {
          id: Number.MAX_SAFE_INTEGER + 1,
          filename: "unsafe.ts",
          content: "x",
        },
      ]),
    /non-negative safe integer/,
  );
});

Deno.test("capnpc-deno plugin response encoder accepts safe numeric ids", () => {
  const encoded = encodeCodeGeneratorResponse([
    { id: 42, filename: "safe.ts", content: "x" },
  ]);
  const decoded = decodeResponse(encoded);
  assertEquals(decoded.length, 1);
  assertEquals(decoded[0].id, 42n);
  assertEquals(decoded[0].filename, "safe.ts");
});

Deno.test("capnpc-deno plugin response encoder guards signed pointer offset encoding", () => {
  withPatchedNumberIsInteger(
    (original) =>
      ((
        value: number,
      ) => (value === 0 ? false : original(value))) as typeof Number.isInteger,
    () => {
      assertThrows(
        () => encodeCodeGeneratorResponse([]),
        /pointer offset is out of signed 30-bit range/i,
      );
    },
  );
});

Deno.test("capnpc-deno plugin response encoder guards text write ranges", () => {
  withPatchedTextEncoderEncode(
    () => (() => ({ byteLength: -2 } as unknown as Uint8Array<ArrayBuffer>)),
    () => {
      assertThrows(
        () =>
          encodeCodeGeneratorResponse([{ filename: "bad.ts", content: "x" }]),
        /writeTextPointer out of range/i,
      );
    },
  );
});

Deno.test("capnpc-deno plugin response encoder guards against invalid allocation counts", () => {
  const malformed = {
    length: Number.POSITIVE_INFINITY,
    0: {
      filename: "bad.ts",
      content: "x",
    },
  } as unknown as Array<
    { id?: bigint | number; filename: string; content: string }
  >;

  assertThrows(
    () => encodeCodeGeneratorResponse(malformed),
    /allocWords requires non-negative integer/,
  );
});
