import { parseCodeGeneratorRequest } from "../tools/capnpc-deno/request_parser.ts";
import { assert, assertEquals, assertThrows } from "./test_utils.ts";

const REQUEST_FIXTURE_PATH =
  "tests/fixtures/codegen_requests/multi_schema_request.b64";
const WORD_BYTES = 8;
const MASK_30 = 0x3fff_ffffn;

interface StructPointer {
  offsetWords: number;
  dataWords: number;
  pointerCount: number;
}

interface StructListLayout {
  elementsStartWord: number;
  elementCount: number;
  elementDataWords: number;
  elementPointerCount: number;
  elementStrideWords: number;
}

interface StructLayout {
  startWord: number;
  dataWords: number;
  pointerCount: number;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function loadFixtureMessage(): Promise<Uint8Array> {
  const base64 = (await Deno.readTextFile(REQUEST_FIXTURE_PATH)).trim();
  return decodeBase64(base64);
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

function signed30(raw: bigint): number {
  const value = Number(raw & MASK_30);
  return (value & (1 << 29)) !== 0 ? value - (1 << 30) : value;
}

function encodeSigned30(value: number): bigint {
  assert(
    Number.isInteger(value) && value >= -(1 << 29) && value <= (1 << 29) - 1,
    `signed30 offset out of range: ${value}`,
  );
  return BigInt(value < 0 ? value + (1 << 30) : value) & MASK_30;
}

function encodeStructPointerWord(
  pointerWordIndex: number,
  targetStartWord: number,
  dataWords: number,
  pointerCount: number,
): bigint {
  const offsetWords = targetStartWord - (pointerWordIndex + 1);
  return (encodeSigned30(offsetWords) << 2n) |
    (BigInt(dataWords) << 32n) |
    (BigInt(pointerCount) << 48n);
}

function getWord(segment: Uint8Array, wordIndex: number): bigint {
  return new DataView(segment.buffer, segment.byteOffset, segment.byteLength)
    .getBigUint64(wordIndex * WORD_BYTES, true);
}

function setWord(segment: Uint8Array, wordIndex: number, value: bigint): void {
  new DataView(segment.buffer, segment.byteOffset, segment.byteLength)
    .setBigUint64(wordIndex * WORD_BYTES, value, true);
}

function decodeStructPointer(word: bigint, context: string): StructPointer {
  const kind = Number(word & 0x3n);
  assertEquals(kind, 0, `${context} should be a struct pointer`);
  return {
    offsetWords: signed30((word >> 2n) & MASK_30),
    dataWords: Number((word >> 32n) & 0xffffn),
    pointerCount: Number((word >> 48n) & 0xffffn),
  };
}

function locateStructList(
  segment: Uint8Array,
  pointerWordIndex: number,
): StructListLayout {
  const listWord = getWord(segment, pointerWordIndex);
  const listKind = Number(listWord & 0x3n);
  assertEquals(listKind, 1, "expected list pointer");

  const listOffset = signed30((listWord >> 2n) & MASK_30);
  const elementSize = Number((listWord >> 32n) & 0x7n);
  assertEquals(elementSize, 7, "expected inline-composite list");

  const tagWordIndex = pointerWordIndex + 1 + listOffset;
  const tag = getWord(segment, tagWordIndex);
  const tagKind = Number(tag & 0x3n);
  assertEquals(tagKind, 0, "expected inline-composite tag to be struct");

  const elementCount = Number((tag >> 2n) & MASK_30);
  const elementDataWords = Number((tag >> 32n) & 0xffffn);
  const elementPointerCount = Number((tag >> 48n) & 0xffffn);
  const elementStrideWords = elementDataWords + elementPointerCount;

  return {
    elementsStartWord: tagWordIndex + 1,
    elementCount,
    elementDataWords,
    elementPointerCount,
    elementStrideWords,
  };
}

function locateNodeStruct(
  segment: Uint8Array,
  nodeIndex: number,
): StructLayout {
  const rootPointer = decodeStructPointer(getWord(segment, 0), "root");
  const rootStartWord = 1 + rootPointer.offsetWords;
  const rootNodeListPointerWord = rootStartWord + rootPointer.dataWords;

  const nodeList = locateStructList(segment, rootNodeListPointerWord);
  assert(
    nodeIndex >= 0 && nodeIndex < nodeList.elementCount,
    `node index out of range: ${nodeIndex}`,
  );

  return {
    startWord: nodeList.elementsStartWord +
      (nodeIndex * nodeList.elementStrideWords),
    dataWords: nodeList.elementDataWords,
    pointerCount: nodeList.elementPointerCount,
  };
}

function writeStructU16(
  segment: Uint8Array,
  structStartWord: number,
  byteOffset: number,
  value: number,
): void {
  new DataView(segment.buffer, segment.byteOffset, segment.byteLength)
    .setUint16(
      (structStartWord * WORD_BYTES) + byteOffset,
      value,
      true,
    );
}

function writeStructU64(
  segment: Uint8Array,
  structStartWord: number,
  byteOffset: number,
  value: bigint,
): void {
  new DataView(segment.buffer, segment.byteOffset, segment.byteLength)
    .setBigUint64(
      (structStartWord * WORD_BYTES) + byteOffset,
      value,
      true,
    );
}

function pointerWordIndex(
  structLayout: StructLayout,
  pointerOffset: number,
): number {
  assert(
    pointerOffset >= 0 && pointerOffset < structLayout.pointerCount,
    `pointer offset out of range: ${pointerOffset}`,
  );
  return structLayout.startWord + structLayout.dataWords + pointerOffset;
}

function locateRootStruct(segment: Uint8Array): StructLayout {
  const rootPointer = decodeStructPointer(getWord(segment, 0), "root");
  return {
    startWord: 1 + rootPointer.offsetWords,
    dataWords: rootPointer.dataWords,
    pointerCount: rootPointer.pointerCount,
  };
}

function findPersonNodeIndex(message: Uint8Array): number {
  const request = parseCodeGeneratorRequest(message);
  const index = request.nodes.findIndex((node) =>
    node.displayName.endsWith(":Person")
  );
  assert(index >= 0, "expected Person node in fixture request");
  return index;
}

function locatePersonFieldLayout(
  segment: Uint8Array,
  personNodeIndex: number,
  fieldIndex: number,
): {
  fieldStartWord: number;
  fieldDataWords: number;
  typePointerWordIndex: number;
} {
  const personStruct = locateNodeStruct(segment, personNodeIndex);
  const fieldsPointerWordIndex = pointerWordIndex(personStruct, 3);
  const fieldList = locateStructList(segment, fieldsPointerWordIndex);
  assert(
    fieldIndex >= 0 && fieldIndex < fieldList.elementCount,
    `field index out of range: ${fieldIndex}`,
  );
  const fieldStartWord = fieldList.elementsStartWord +
    (fieldIndex * fieldList.elementStrideWords);
  const typePointerWordIndex = fieldStartWord + fieldList.elementDataWords + 2;
  return {
    fieldStartWord,
    fieldDataWords: fieldList.elementDataWords,
    typePointerWordIndex,
  };
}

function locateFirstPersonFieldLayout(
  segment: Uint8Array,
  personNodeIndex: number,
): {
  fieldStartWord: number;
  fieldDataWords: number;
  typePointerWordIndex: number;
} {
  return locatePersonFieldLayout(segment, personNodeIndex, 0);
}

function locateRequestedFileStruct(
  segment: Uint8Array,
  requestedFileIndex: number,
): StructLayout {
  const rootStruct = locateRootStruct(segment);
  const requestedFilesPointerWord = pointerWordIndex(rootStruct, 1);
  const requestedFilesList = locateStructList(
    segment,
    requestedFilesPointerWord,
  );
  assert(
    requestedFileIndex >= 0 &&
      requestedFileIndex < requestedFilesList.elementCount,
    `requested file index out of range: ${requestedFileIndex}`,
  );
  return {
    startWord: requestedFilesList.elementsStartWord +
      (requestedFileIndex * requestedFilesList.elementStrideWords),
    dataWords: requestedFilesList.elementDataWords,
    pointerCount: requestedFilesList.elementPointerCount,
  };
}

function locateStructTargetFromPointer(
  segment: Uint8Array,
  pointerWordIndex: number,
): StructLayout {
  const pointer = decodeStructPointer(
    getWord(segment, pointerWordIndex),
    "struct pointer slot",
  );
  return {
    startWord: pointerWordIndex + 1 + pointer.offsetWords,
    dataWords: pointer.dataWords,
    pointerCount: pointer.pointerCount,
  };
}

async function mutateFixture(
  mutator: (segment: Uint8Array, personNodeIndex: number) => void,
): Promise<Uint8Array> {
  const bytes = await loadFixtureMessage();
  const segments = splitSegments(bytes);
  assertEquals(segments.length, 1, "expected single-segment fixture");
  const segment = new Uint8Array(segments[0]);
  const personNodeIndex = findPersonNodeIndex(bytes);
  mutator(segment, personNodeIndex);
  return buildMessage([segment]);
}

Deno.test("capnpc-deno request parser rejects unsupported node kind tags", async () => {
  const mutated = await mutateFixture((segment) => {
    const node0 = locateNodeStruct(segment, 0);
    writeStructU16(segment, node0.startWord, 12, 99);
  });

  assertThrows(
    () => parseCodeGeneratorRequest(mutated),
    /unsupported node kind tag: 99/,
  );
});

Deno.test("capnpc-deno request parser rejects unsupported field kind tags", async () => {
  const mutated = await mutateFixture((segment, personNodeIndex) => {
    const firstField = locateFirstPersonFieldLayout(segment, personNodeIndex);
    writeStructU16(segment, firstField.fieldStartWord, 8, 9);
  });

  assertThrows(
    () => parseCodeGeneratorRequest(mutated),
    /unsupported field kind tag: 9/,
  );
});

Deno.test("capnpc-deno request parser rejects slot fields missing type payload", async () => {
  const mutated = await mutateFixture((segment, personNodeIndex) => {
    const firstField = locateFirstPersonFieldLayout(segment, personNodeIndex);
    writeStructU16(segment, firstField.fieldStartWord, 8, 0);
    setWord(segment, firstField.typePointerWordIndex, 0n);
  });

  assertThrows(
    () => parseCodeGeneratorRequest(mutated),
    /field slot missing type/,
  );
});

Deno.test("capnpc-deno request parser rejects unsupported type kind tags", async () => {
  const mutated = await mutateFixture((segment, personNodeIndex) => {
    const firstField = locateFirstPersonFieldLayout(segment, personNodeIndex);
    const typeStruct = locateStructTargetFromPointer(
      segment,
      firstField.typePointerWordIndex,
    );
    writeStructU16(segment, typeStruct.startWord, 0, 99);
  });

  assertThrows(
    () => parseCodeGeneratorRequest(mutated),
    /unsupported type kind tag: 99/,
  );
});

Deno.test("capnpc-deno request parser rejects list types missing element type payload", async () => {
  const mutated = await mutateFixture((segment, personNodeIndex) => {
    const firstField = locateFirstPersonFieldLayout(segment, personNodeIndex);
    const typeStruct = locateStructTargetFromPointer(
      segment,
      firstField.typePointerWordIndex,
    );
    writeStructU16(segment, typeStruct.startWord, 0, 14);
    const elementTypePointerWord = typeStruct.startWord + typeStruct.dataWords;
    setWord(segment, elementTypePointerWord, 0n);
  });

  assertThrows(
    () => parseCodeGeneratorRequest(mutated),
    /list type missing element type/,
  );
});

Deno.test("capnpc-deno request parser handles parseType variants across scalar and reference tags", async () => {
  const scalarAndReferenceCases = [
    { tag: 0, kind: "void" },
    { tag: 1, kind: "bool" },
    { tag: 2, kind: "int8" },
    { tag: 3, kind: "int16" },
    { tag: 4, kind: "int32" },
    { tag: 5, kind: "int64" },
    { tag: 6, kind: "uint8" },
    { tag: 7, kind: "uint16" },
    { tag: 8, kind: "uint32" },
    { tag: 9, kind: "uint64" },
    { tag: 10, kind: "float32" },
    { tag: 11, kind: "float64" },
    { tag: 12, kind: "text" },
    { tag: 13, kind: "data" },
    { tag: 15, kind: "enum", typeId: 0x1111n },
    { tag: 16, kind: "struct", typeId: 0x2222n },
    { tag: 17, kind: "interface", typeId: 0x3333n },
    { tag: 18, kind: "anyPointer" },
  ] as const;

  for (const testCase of scalarAndReferenceCases) {
    const mutated = await mutateFixture((segment, personNodeIndex) => {
      const firstField = locatePersonFieldLayout(segment, personNodeIndex, 0);
      const typeStruct = locateStructTargetFromPointer(
        segment,
        firstField.typePointerWordIndex,
      );
      writeStructU16(segment, typeStruct.startWord, 0, testCase.tag);
      if ("typeId" in testCase) {
        writeStructU64(segment, typeStruct.startWord, 8, testCase.typeId);
      }
    });

    const parsed = parseCodeGeneratorRequest(mutated);
    const person = parsed.nodes.find((node) =>
      node.displayName.endsWith(":Person")
    );
    assert(
      person?.structNode !== undefined,
      "expected Person struct after parseType mutation",
    );
    const idField = person.structNode.fields.find((field) =>
      field.name === "id"
    );
    assert(
      idField?.slot !== undefined,
      "expected id slot field after parseType mutation",
    );
    assertEquals(idField.slot.type.kind, testCase.kind);

    if ("typeId" in testCase) {
      assert(
        "typeId" in idField.slot.type,
        "expected type id on reference type",
      );
      assertEquals(idField.slot.type.typeId, testCase.typeId);
    }
  }

  const listMutated = await mutateFixture((segment, personNodeIndex) => {
    const firstField = locatePersonFieldLayout(segment, personNodeIndex, 0);
    const secondField = locatePersonFieldLayout(segment, personNodeIndex, 1);
    const firstType = locateStructTargetFromPointer(
      segment,
      firstField.typePointerWordIndex,
    );
    const secondType = locateStructTargetFromPointer(
      segment,
      secondField.typePointerWordIndex,
    );
    const elementTypePointerWord = firstType.startWord + firstType.dataWords;
    const rebasedSecondTypePointerWord = encodeStructPointerWord(
      elementTypePointerWord,
      secondType.startWord,
      secondType.dataWords,
      secondType.pointerCount,
    );

    writeStructU16(segment, secondType.startWord, 0, 4); // int32
    writeStructU16(segment, firstType.startWord, 0, 14); // list
    setWord(segment, elementTypePointerWord, rebasedSecondTypePointerWord);
  });
  const parsedList = parseCodeGeneratorRequest(listMutated);
  const person = parsedList.nodes.find((node) =>
    node.displayName.endsWith(":Person")
  );
  assert(
    person?.structNode !== undefined,
    "expected Person struct after list mutation",
  );
  const idField = person.structNode.fields.find((field) => field.name === "id");
  assert(
    idField?.slot !== undefined,
    "expected id slot field after list mutation",
  );
  assertEquals(idField.slot.type.kind, "list");
  if (idField.slot.type.kind === "list") {
    assertEquals(idField.slot.type.elementType.kind, "int32");
  }
});

Deno.test("capnpc-deno request parser treats missing nested/method/field/import lists as empty", async () => {
  const source = await loadFixtureMessage();
  const baseline = parseCodeGeneratorRequest(source);
  const enumNodeIndex = baseline.nodes.findIndex((node) =>
    node.kind === "enum"
  );
  const personNodeIndex = baseline.nodes.findIndex((node) =>
    node.displayName.endsWith(":Person")
  );
  const structToInterfaceIndex = baseline.nodes.findIndex((node) =>
    node.kind === "struct" && !node.displayName.endsWith(":Person")
  );
  assert(enumNodeIndex >= 0, "expected enum node in fixture");
  assert(personNodeIndex >= 0, "expected Person node in fixture");
  assert(
    structToInterfaceIndex >= 0,
    "expected additional struct node in fixture",
  );

  const mutated = await mutateFixture((segment) => {
    const fileNode = locateNodeStruct(segment, 0);
    const enumNode = locateNodeStruct(segment, enumNodeIndex);
    const personNode = locateNodeStruct(segment, personNodeIndex);
    const coercedInterfaceNode = locateNodeStruct(
      segment,
      structToInterfaceIndex,
    );
    const requestedFile = locateRequestedFileStruct(segment, 0);

    // File.nestedNodes
    setWord(segment, pointerWordIndex(fileNode, 1), 0n);
    // Enum.enumerants
    setWord(segment, pointerWordIndex(enumNode, 3), 0n);
    // Struct.fields
    setWord(segment, pointerWordIndex(personNode, 3), 0n);
    // Coerce a struct to interface with empty methods list.
    writeStructU16(segment, coercedInterfaceNode.startWord, 12, 3);
    setWord(segment, pointerWordIndex(coercedInterfaceNode, 3), 0n);
    // RequestedFile.imports
    setWord(segment, pointerWordIndex(requestedFile, 1), 0n);
  });

  const parsed = parseCodeGeneratorRequest(mutated);
  const fileNode = parsed.nodes[0];
  assertEquals(fileNode.kind, "file");
  assertEquals(fileNode.nestedNodes.length, 0);

  const enumNode = parsed.nodes[enumNodeIndex];
  assertEquals(enumNode.kind, "enum");
  assertEquals(enumNode.enumNode?.enumerants.length, 0);

  const personNode = parsed.nodes[personNodeIndex];
  assertEquals(personNode.kind, "struct");
  assertEquals(personNode.structNode?.fields.length, 0);

  const coercedInterfaceNode = parsed.nodes[structToInterfaceIndex];
  assertEquals(coercedInterfaceNode.kind, "interface");
  assertEquals(coercedInterfaceNode.interfaceNode?.methods.length, 0);

  assertEquals(parsed.requestedFiles[0].imports.length, 0);
});
