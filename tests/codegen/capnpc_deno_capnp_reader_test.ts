import { CapnpReader } from "../../tools/capnpc-deno/capnp_reader.ts";
import { assertEquals, assertThrows } from "../test_utils.ts";

const WORD_BYTES = 8;
const MASK_30 = 0x3fff_ffffn;

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

function messageWithSingleSegmentWords(words: number): {
  segment: Uint8Array;
  toMessage: () => Uint8Array;
} {
  const segment = new Uint8Array(words * WORD_BYTES);
  return {
    segment,
    toMessage: () => buildMessage([segment]),
  };
}

function encodeSigned30(value: number): bigint {
  const raw = value < 0 ? value + (1 << 30) : value;
  return BigInt(raw) & MASK_30;
}

function structPointerWord(
  offsetWords: number,
  dataWordCount: number,
  pointerCount: number,
): bigint {
  let word = 0n;
  word |= encodeSigned30(offsetWords) << 2n;
  word |= BigInt(dataWordCount & 0xffff) << 32n;
  word |= BigInt(pointerCount & 0xffff) << 48n;
  return word;
}

function listPointerWord(
  offsetWords: number,
  elementSize: number,
  elementCount: number,
): bigint {
  let word = 1n;
  word |= encodeSigned30(offsetWords) << 2n;
  word |= BigInt(elementSize & 0x7) << 32n;
  word |= BigInt(elementCount & 0x1fff_ffff) << 35n;
  return word;
}

function farPointerWord(
  targetSegmentId: number,
  landingPadWord: number,
  isDoubleFar = false,
): bigint {
  let word = 0x2n;
  if (isDoubleFar) {
    word |= 0x1n << 2n;
  }
  word |= BigInt(landingPadWord & 0x1fff_ffff) << 3n;
  word |= BigInt(targetSegmentId >>> 0) << 32n;
  return word;
}

function setWord(segment: Uint8Array, wordIndex: number, value: bigint): void {
  new DataView(segment.buffer, segment.byteOffset, segment.byteLength)
    .setBigUint64(wordIndex * WORD_BYTES, value, true);
}

Deno.test("capnp_reader constructor and root guards", () => {
  assertThrows(
    () => new CapnpReader(new Uint8Array(0)),
    /message too short/,
  );

  const truncatedHeader = new Uint8Array(8);
  const truncatedView = new DataView(truncatedHeader.buffer);
  truncatedView.setUint32(0, 1, true); // declares 2 segments -> header needs 16 bytes
  assertThrows(
    () => new CapnpReader(truncatedHeader),
    /header truncated/,
  );

  const truncatedSegment = new Uint8Array(8);
  const segmentView = new DataView(truncatedSegment.buffer);
  segmentView.setUint32(0, 0, true);
  segmentView.setUint32(4, 1, true); // one-word segment, but no body bytes present
  assertThrows(
    () => new CapnpReader(truncatedSegment),
    /segment truncated/,
  );

  const noRootBytes = buildMessage([new Uint8Array(0)]);
  const noRootReader = new CapnpReader(noRootBytes);
  assertThrows(
    () => noRootReader.root(),
    /missing root segment/,
  );
});

Deno.test("capnp_reader validates root struct pointer kind and null roots", () => {
  const nullRoot = messageWithSingleSegmentWords(1);
  const nullRootReader = new CapnpReader(nullRoot.toMessage());
  assertThrows(
    () => nullRootReader.root(),
    /null struct pointer/,
  );

  const listRoot = messageWithSingleSegmentWords(1);
  setWord(listRoot.segment, 0, listPointerWord(0, 2, 1));
  const listRootReader = new CapnpReader(listRoot.toMessage());
  assertThrows(
    () => listRootReader.root(),
    /expected struct pointer, got kind=1/,
  );
});

Deno.test("capnp_reader resolves signed offsets and enforces pointer index bounds", () => {
  const negativeOffset = messageWithSingleSegmentWords(1);
  setWord(negativeOffset.segment, 0, structPointerWord(-1, 0, 0));
  const reader = new CapnpReader(negativeOffset.toMessage());
  reader.root();

  const pointerBounds = messageWithSingleSegmentWords(2);
  setWord(pointerBounds.segment, 0, structPointerWord(0, 0, 1));
  const pointerBoundsReader = new CapnpReader(pointerBounds.toMessage());
  const root = pointerBoundsReader.root();
  assertThrows(
    () => root.readData(1),
    /pointer index out of range: 1/,
  );
});

Deno.test("capnp_reader exposes missing-segment errors through public helpers", () => {
  const valid = messageWithSingleSegmentWords(1);
  setWord(valid.segment, 0, structPointerWord(-1, 0, 0));
  const reader = new CapnpReader(valid.toMessage());

  assertThrows(
    () => reader.readWordAt(99, 0),
    /missing segment 99/,
  );
  assertThrows(
    () => reader.readBytesAt(99, 0, 1),
    /missing segment 99/,
  );
  assertThrows(
    () => reader.viewFor(99),
    /missing segment 99/,
  );
});

Deno.test("capnp_reader rejects malformed far-pointer landing pads and hop limits", () => {
  const padKindSegments = [
    new Uint8Array(WORD_BYTES),
    new Uint8Array(WORD_BYTES * 2),
  ];
  setWord(padKindSegments[0], 0, farPointerWord(1, 0, true));
  setWord(padKindSegments[1], 0, structPointerWord(0, 0, 0));
  setWord(padKindSegments[1], 1, structPointerWord(0, 0, 0));
  const padKindReader = new CapnpReader(buildMessage(padKindSegments));
  assertThrows(
    () => padKindReader.root(),
    /landing pad\[0\] must be far pointer/,
  );

  const nestedFarSegments = [
    new Uint8Array(WORD_BYTES),
    new Uint8Array(WORD_BYTES * 2),
  ];
  setWord(nestedFarSegments[0], 0, farPointerWord(1, 0, true));
  setWord(nestedFarSegments[1], 0, farPointerWord(1, 0, true));
  setWord(nestedFarSegments[1], 1, structPointerWord(0, 0, 0));
  const nestedFarReader = new CapnpReader(buildMessage(nestedFarSegments));
  assertThrows(
    () => nestedFarReader.root(),
    /landing pad\[0\] must be single-far pointer/,
  );

  const chainSegments: Uint8Array[] = [];
  for (let i = 0; i < 10; i += 1) {
    chainSegments.push(new Uint8Array(WORD_BYTES));
  }
  for (let i = 0; i < 9; i += 1) {
    setWord(chainSegments[i], 0, farPointerWord(i + 1, 0, false));
  }
  setWord(chainSegments[9], 0, farPointerWord(9, 0, false));
  const chainReader = new CapnpReader(buildMessage(chainSegments));
  assertThrows(
    () => chainReader.root(),
    /far pointer chain exceeded maximum hop count/,
  );
});

Deno.test("capnp_reader validates struct-list pointer layout", () => {
  const kindMismatch = messageWithSingleSegmentWords(3);
  setWord(kindMismatch.segment, 0, structPointerWord(0, 0, 1));
  setWord(kindMismatch.segment, 1, structPointerWord(1, 0, 0));
  const kindMismatchRoot = new CapnpReader(kindMismatch.toMessage()).root();
  assertThrows(
    () => kindMismatchRoot.readStructList(0),
    /expected list pointer in pointer slot/,
  );

  const elementSizeMismatch = messageWithSingleSegmentWords(4);
  setWord(elementSizeMismatch.segment, 0, structPointerWord(0, 0, 1));
  setWord(elementSizeMismatch.segment, 1, listPointerWord(0, 2, 1));
  const sizeMismatchRoot = new CapnpReader(elementSizeMismatch.toMessage())
    .root();
  assertThrows(
    () => sizeMismatchRoot.readStructList(0),
    /expected inline-composite struct list/,
  );

  const tagKindMismatch = messageWithSingleSegmentWords(4);
  setWord(tagKindMismatch.segment, 0, structPointerWord(0, 0, 1));
  setWord(tagKindMismatch.segment, 1, listPointerWord(0, 7, 1));
  setWord(tagKindMismatch.segment, 2, listPointerWord(0, 2, 1));
  const tagMismatchRoot = new CapnpReader(tagKindMismatch.toMessage()).root();
  assertThrows(
    () => tagMismatchRoot.readStructList(0),
    /inline-composite tag is not a struct pointer/,
  );

  const sizeExceeded = messageWithSingleSegmentWords(4);
  setWord(sizeExceeded.segment, 0, structPointerWord(0, 0, 1));
  setWord(sizeExceeded.segment, 1, listPointerWord(0, 7, 1)); // declared one word
  setWord(sizeExceeded.segment, 2, structPointerWord(2, 1, 0)); // two elements * one word
  const sizeExceededRoot = new CapnpReader(sizeExceeded.toMessage()).root();
  assertThrows(
    () => sizeExceededRoot.readStructList(0),
    /size exceeds declared word count/,
  );

  const validList = messageWithSingleSegmentWords(3);
  setWord(validList.segment, 0, structPointerWord(0, 0, 1));
  setWord(validList.segment, 1, listPointerWord(0, 7, 0)); // empty inline-composite list
  setWord(validList.segment, 2, structPointerWord(1, 0, 0)); // tag: 1 element, 0 data, 0 ptr
  const listReader = new CapnpReader(validList.toMessage()).root()
    .readStructList(
      0,
    );
  assertEquals(listReader?.len(), 1);
  assertThrows(
    () => listReader?.get(1),
    /struct list index out of range: 1/,
  );
});

Deno.test("capnp_reader validates struct-pointer slots and byte-list decoding", () => {
  const structPointerMismatch = messageWithSingleSegmentWords(3);
  setWord(structPointerMismatch.segment, 0, structPointerWord(0, 0, 1));
  setWord(structPointerMismatch.segment, 1, listPointerWord(0, 2, 1));
  const structPointerRoot = new CapnpReader(structPointerMismatch.toMessage())
    .root();
  assertThrows(
    () => structPointerRoot.readStruct(0),
    /expected struct pointer in pointer slot/,
  );

  const nullByteList = messageWithSingleSegmentWords(2);
  setWord(nullByteList.segment, 0, structPointerWord(0, 0, 1));
  const nullByteListRoot = new CapnpReader(nullByteList.toMessage()).root();
  assertEquals(nullByteListRoot.readText(0), null);
  assertEquals(nullByteListRoot.readData(0), null);

  const byteKindMismatch = messageWithSingleSegmentWords(3);
  setWord(byteKindMismatch.segment, 0, structPointerWord(0, 0, 1));
  setWord(byteKindMismatch.segment, 1, structPointerWord(1, 0, 0));
  const byteKindMismatchRoot = new CapnpReader(byteKindMismatch.toMessage())
    .root();
  assertThrows(
    () => byteKindMismatchRoot.readText(0),
    /expected byte-list pointer/,
  );

  const byteSizeMismatch = messageWithSingleSegmentWords(3);
  setWord(byteSizeMismatch.segment, 0, structPointerWord(0, 0, 1));
  setWord(byteSizeMismatch.segment, 1, listPointerWord(0, 4, 1));
  const byteSizeMismatchRoot = new CapnpReader(byteSizeMismatch.toMessage())
    .root();
  assertThrows(
    () => byteSizeMismatchRoot.readData(0),
    /expected byte-list element size 2/,
  );

  const textNoNul = messageWithSingleSegmentWords(3);
  setWord(textNoNul.segment, 0, structPointerWord(0, 0, 1));
  setWord(textNoNul.segment, 1, listPointerWord(0, 2, 3));
  textNoNul.segment.set(new Uint8Array([0x61, 0x62, 0x63]), 2 * WORD_BYTES);
  const textNoNulRoot = new CapnpReader(textNoNul.toMessage()).root();
  assertEquals(textNoNulRoot.readText(0), "abc");

  const dataList = messageWithSingleSegmentWords(3);
  setWord(dataList.segment, 0, structPointerWord(0, 0, 1));
  setWord(dataList.segment, 1, listPointerWord(0, 2, 3));
  dataList.segment.set(new Uint8Array([0x78, 0x79, 0x00]), 2 * WORD_BYTES);
  const dataRoot = new CapnpReader(dataList.toMessage()).root();
  const raw = dataRoot.readData(0);
  assertEquals(raw?.byteLength, 3);
  assertEquals(raw?.[0], 0x78);
  assertEquals(dataRoot.readText(0), "xy");

  const outOfBounds = messageWithSingleSegmentWords(3);
  setWord(outOfBounds.segment, 0, structPointerWord(0, 0, 1));
  setWord(outOfBounds.segment, 1, listPointerWord(0, 2, 20));
  const outOfBoundsRoot = new CapnpReader(outOfBounds.toMessage()).root();
  assertThrows(
    () => outOfBoundsRoot.readText(0),
    /out of bounds/,
  );
});
