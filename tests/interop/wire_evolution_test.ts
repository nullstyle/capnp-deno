import {
  decodeAnyPointerMessageFromReader,
  decodeListField,
  decodePointerField,
  encodeAnyPointerMessageIntoBuilder,
  MessageBuilder,
  MessageReader,
  TYPE_ANY_POINTER,
  TYPE_TEXT,
} from "../../src/encoding.ts";
import { assert, assertEquals, assertThrows } from "../test_utils.ts";

import { far, frame } from "../fixtures/wire_bytes.ts";

Deno.test("wire evolution: standard double-far present empty struct survives AnyPointer copy", () => {
  const input = frame([[far(1, 0, true)], [far(2, 0), 0n], []]);
  const reader = new MessageReader(input);
  assert(
    reader.readStructPointer(0, 0) !== null,
    "a zero double-far tag is present",
  );
  const value = decodePointerField(reader, 0, 0, TYPE_ANY_POINTER) as {
    kind: string;
  };
  assertEquals(value.kind, "message");
  assertThrows(() => reader.readListPointer(0, 0), /expected list pointer/);
  const copied = new MessageReader(
    decodeAnyPointerMessageFromReader(reader, 0, 0),
  );
  assert(
    copied.readStructPointer(0, 0) !== null,
    "copy must preserve empty presence",
  );
});

Deno.test("wire evolution: empty struct written next to its pointer remains present", () => {
  const builder = new MessageBuilder();
  builder.setStructPointer(0, builder.allocWords(0), 0, 0);
  assert(
    new MessageReader(builder.toMessageBytes()).readStructPointer(0, 0) !==
      null,
  );
});

for (
  const [name, count, content] of [
    ["missing NUL", 2, 0x6968n],
    ["zero-length Text", 0, 0n],
    ["malformed UTF-8", 3, 0xafc0n],
  ] as const
) {
  Deno.test(`wire evolution: Text rejects ${name}`, () => {
    const message = frame([[
      1n | (2n << 32n) | (BigInt(count) << 35n),
      content,
    ]]);
    assertThrows(
      () => new MessageReader(message).readTextPointer(0, 0),
      /text|UTF-8|NUL/i,
    );
  });
}

Deno.test("wire evolution: nested Text lists enforce the same strict decoding", () => {
  const input = frame([[
    1n | (6n << 32n) | (1n << 35n),
    1n | (2n << 32n) | (2n << 35n),
    0x6968n,
  ]]);
  assertThrows(
    () => decodeListField(new MessageReader(input), 0, 0, TYPE_TEXT),
    /NUL/,
  );
});

Deno.test("wire evolution: cyclic AnyPointer copy fails with a bounded protocol error", () => {
  const input = frame([[1n << 48n, 0xfffffffcn | (1n << 48n)]]);
  assertThrows(
    () => decodeAnyPointerMessageFromReader(new MessageReader(input), 0, 0),
    /copy.*depth|nesting/i,
  );
});

Deno.test("wire evolution: malformed list copy leaves destination pointer untouched", () => {
  // Declares one word of inline-composite storage but its tag claims two.
  const malformed = frame([[
    1n | (7n << 32n) | (1n << 35n),
    8n | (1n << 32n),
    7n,
    8n,
  ]]);
  const destination = new MessageBuilder();
  destination.writeWord(0, 3n | (7n << 32n));
  assertThrows(
    () => encodeAnyPointerMessageIntoBuilder(destination, 0, malformed),
    /declared|bounds|count/i,
  );
  assertEquals(
    new MessageReader(destination.toMessageBytes()).readWord(0, 0),
    3n | (7n << 32n),
  );
});

Deno.test("wire evolution: near single-far and double-far evolved lists preserve unknown fields and cap indices", () => {
  const tag = 8n | (2n << 32n) | (2n << 48n); // Two elements, each 2 data + 2 pointer words.
  const elements = [
    42n,
    0xdeadbeefn,
    3n,
    3n | (7n << 32n),
    43n,
    0xcafebaben,
    3n | (9n << 32n),
    0n,
  ];
  const list = 1n | (7n << 32n) | (8n << 35n);
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
  for (const input of cases) {
    const copied = new MessageReader(
      decodeAnyPointerMessageFromReader(new MessageReader(input), 0, 0),
    );
    const view = copied.readListPointer(0, 0)!;
    assert(view.kind === "inlineComposite");
    assertEquals(view.elementCount, 2);
    assertEquals(view.dataWordCount, 2);
    assertEquals(view.pointerCount, 2);
    for (const [index, expected] of elements.entries()) {
      assertEquals(
        copied.readWord(view.segmentId, view.tagWord + 1 + index),
        expected,
      );
    }
  }
});

Deno.test("wire evolution: double-far struct copy keeps nonzero content offset", () => {
  const input = frame([[far(1, 0, true)], [far(2, 2), 1n << 32n], [
    0xbadn,
    0xbadn,
    42n,
  ]]);
  const copied = new MessageReader(
    decodeAnyPointerMessageFromReader(new MessageReader(input), 0, 0),
  );
  assertEquals(copied.readBigUint64InStruct(copied.readRootStruct(), 0), 42n);
});

Deno.test("wire evolution: copies retain declared inline-composite padding", () => {
  const input = frame([[
    1n | (7n << 32n) | (2n << 35n),
    4n | (1n << 32n),
    42n,
    99n,
  ]]);
  const copied = new MessageReader(
    decodeAnyPointerMessageFromReader(new MessageReader(input), 0, 0),
  );
  const list = copied.readListPointer(0, 0)!;
  assert(list.kind === "inlineComposite");
  assertEquals(list.wordsInElements, 2);
  assertEquals(copied.readWord(list.segmentId, list.tagWord + 2), 99n);
});

Deno.test("wire evolution: copy budgets charge shared targets for each expanded reference", () => {
  const pointers = Array.from(
    { length: 4 },
    (_, index) => BigInt(3 - index) << 2n | 1n << 32n,
  );
  const reader = new MessageReader(frame([[4n << 48n, ...pointers, 42n]]));
  assertThrows(
    () =>
      decodeAnyPointerMessageFromReader(reader, 0, 0, { maxOutputWords: 8 }),
    /output word limit/,
  );
  assertThrows(
    () => decodeAnyPointerMessageFromReader(reader, 0, 0, { maxWork: 8 }),
    /work limit/,
  );
  const copied = decodeAnyPointerMessageFromReader(reader, 0, 0, {
    maxWork: 9,
    maxOutputWords: 9,
  });
  assertEquals(copied.byteLength, 8 + 9 * 8);
});

Deno.test("wire evolution: logical empty lists consume work budget without large allocations", () => {
  const reader = new MessageReader(frame([[1n | (20n << 35n)]])); // List(Void), no body.
  assertThrows(
    () => decodeAnyPointerMessageFromReader(reader, 0, 0, { maxWork: 20 }),
    /work limit/,
  );
  const copied = new MessageReader(
    decodeAnyPointerMessageFromReader(reader, 0, 0, {
      maxWork: 21,
      maxOutputWords: 1,
    }),
  );
  assertEquals(copied.readListPointer(0, 0)?.elementCount, 20);
  const emptyStructs = new MessageReader(frame([[1n | (7n << 32n), 80n]]));
  assertThrows(
    () =>
      decodeAnyPointerMessageFromReader(emptyStructs, 0, 0, { maxWork: 20 }),
    /work limit/,
  );
});

Deno.test("wire evolution: copy-limit failure preserves existing destination capability", () => {
  const input = frame([[1n << 32n, 42n]]);
  const destination = new MessageBuilder();
  const original = 3n | (7n << 32n);
  destination.writeWord(0, original);
  assertThrows(
    () =>
      encodeAnyPointerMessageIntoBuilder(destination, 0, input, {
        maxOutputWords: 1,
      }),
    /output word limit/,
  );
  assertEquals(
    new MessageReader(destination.toMessageBytes()).readWord(0, 0),
    original,
  );
});

Deno.test("wire evolution: Text preserves Unicode and present empty strings", () => {
  for (const value of ["", "Ada 👩🏽‍💻 café", "inside\0text", "\ufeffcontent"]) {
    const builder = new MessageBuilder();
    builder.writeTextPointer(0, value);
    assertEquals(
      new MessageReader(builder.toMessageBytes()).readTextPointer(0, 0),
      value,
    );
  }
});
