/**
 * Emits rpc.capnp-derived wire constants used by the runtime wire encoder/decoder.
 */

import { simpleNodeName } from "./emitter_helpers.ts";
import type {
  FieldModel,
  NodeModel,
  StructNodeModel,
  TypeModel,
} from "./model.ts";

const FIELD_NO_DISCRIMINANT = 0xffff;
const RPC_SCHEMA_FILE_ID = 0xb312981b2552a250n;

interface StructInfo {
  readonly node: NodeModel;
  readonly struct: StructNodeModel;
}

export function emitRpcWireConstantsModule(
  fileNode: NodeModel,
  nodeById: Map<bigint, NodeModel>,
): string | null {
  if (fileNode.id !== RPC_SCHEMA_FILE_ID) return null;

  const structs = collectLocalStructs(fileNode, nodeById);
  const messageStruct = requireStruct(structs, "Message");
  const bootstrapStruct = requireStruct(structs, "Bootstrap");
  const callStruct = requireStruct(structs, "Call");
  const messageTargetStruct = requireStruct(structs, "MessageTarget");
  const promisedAnswerStruct = requireStruct(structs, "PromisedAnswer");
  const returnStruct = requireStruct(structs, "Return");
  const payloadStruct = requireStruct(structs, "Payload");
  const finishStruct = requireStruct(structs, "Finish");
  const releaseStruct = requireStruct(structs, "Release");
  const exceptionStruct = requireStruct(structs, "Exception");
  const capDescriptorStruct = requireStruct(structs, "CapDescriptor");

  const promisedAnswerOpStruct = requireListElementStruct(
    promisedAnswerStruct,
    "transform",
    nodeById,
  );
  const callSendResultsToStruct = requireGroupStruct(
    callStruct,
    "sendResultsTo",
    nodeById,
  );

  const returnReleaseParamCapsBitOffset = requireBoolBitOffset(
    returnStruct,
    "releaseParamCaps",
  );
  const returnNoFinishNeededBitOffset = requireBoolBitOffset(
    returnStruct,
    "noFinishNeeded",
  );
  if (
    Math.floor(returnReleaseParamCapsBitOffset / 8) !==
      Math.floor(returnNoFinishNeededBitOffset / 8)
  ) {
    throw new Error(
      "rpc wire constants emission failed: Return bool flags are not packed in the same byte",
    );
  }

  const finishReleaseResultCapsBitOffset = requireBoolBitOffset(
    finishStruct,
    "releaseResultCaps",
  );
  const finishRequireEarlyCancellationWorkaroundBitOffset =
    requireBoolBitOffset(
      finishStruct,
      "requireEarlyCancellationWorkaround",
    );
  if (
    Math.floor(finishReleaseResultCapsBitOffset / 8) !==
      Math.floor(finishRequireEarlyCancellationWorkaroundBitOffset / 8)
  ) {
    throw new Error(
      "rpc wire constants emission failed: Finish bool flags are not packed in the same byte",
    );
  }

  const constants: Array<[name: string, value: number]> = [
    ["RPC_MESSAGE_TAG_CALL", requireUnionTag(messageStruct, "call")],
    ["RPC_MESSAGE_TAG_RETURN", requireUnionTag(messageStruct, "return")],
    ["RPC_MESSAGE_TAG_FINISH", requireUnionTag(messageStruct, "finish")],
    ["RPC_MESSAGE_TAG_RESOLVE", requireUnionTag(messageStruct, "resolve")],
    ["RPC_MESSAGE_TAG_RELEASE", requireUnionTag(messageStruct, "release")],
    ["RPC_MESSAGE_TAG_BOOTSTRAP", requireUnionTag(messageStruct, "bootstrap")],
    [
      "RPC_MESSAGE_TAG_DISEMBARGO",
      requireUnionTag(messageStruct, "disembargo"),
    ],

    [
      "RPC_CALL_TARGET_TAG_IMPORTED_CAP",
      requireUnionTag(messageTargetStruct, "importedCap"),
    ],
    [
      "RPC_CALL_TARGET_TAG_PROMISED_ANSWER",
      requireUnionTag(messageTargetStruct, "promisedAnswer"),
    ],

    [
      "RPC_PROMISED_ANSWER_OP_TAG_NOOP",
      requireUnionTag(promisedAnswerOpStruct, "noop"),
    ],
    [
      "RPC_PROMISED_ANSWER_OP_TAG_GET_POINTER_FIELD",
      requireUnionTag(promisedAnswerOpStruct, "getPointerField"),
    ],

    ["RETURN_TAG_RESULTS", requireUnionTag(returnStruct, "results")],
    ["RETURN_TAG_EXCEPTION", requireUnionTag(returnStruct, "exception")],

    [
      "CAP_DESCRIPTOR_TAG_SENDER_HOSTED",
      requireUnionTag(capDescriptorStruct, "senderHosted"),
    ],
    [
      "CAP_DESCRIPTOR_TAG_RECEIVER_HOSTED",
      requireUnionTag(capDescriptorStruct, "receiverHosted"),
    ],

    ["MESSAGE_DATA_WORD_COUNT", messageStruct.struct.dataWordCount],
    ["MESSAGE_POINTER_COUNT", messageStruct.struct.pointerCount],
    [
      "MESSAGE_UNION_TAG_BYTE_OFFSET",
      requireUnionDiscriminantByteOffset(messageStruct),
    ],
    [
      "MESSAGE_VARIANT_POINTER_INDEX",
      requireSharedPointerSlotIndex(
        messageStruct,
        ["bootstrap", "call", "return", "finish", "release"],
      ),
    ],

    ["BOOTSTRAP_DATA_WORD_COUNT", bootstrapStruct.struct.dataWordCount],
    ["BOOTSTRAP_POINTER_COUNT", bootstrapStruct.struct.pointerCount],
    [
      "BOOTSTRAP_QUESTION_ID_BYTE_OFFSET",
      requireScalarByteOffset(bootstrapStruct, "questionId", "uint32"),
    ],

    ["CALL_DATA_WORD_COUNT", callStruct.struct.dataWordCount],
    ["CALL_POINTER_COUNT", callStruct.struct.pointerCount],
    [
      "CALL_QUESTION_ID_BYTE_OFFSET",
      requireScalarByteOffset(callStruct, "questionId", "uint32"),
    ],
    [
      "CALL_INTERFACE_ID_BYTE_OFFSET",
      requireScalarByteOffset(callStruct, "interfaceId", "uint64"),
    ],
    [
      "CALL_METHOD_ID_BYTE_OFFSET",
      requireScalarByteOffset(callStruct, "methodId", "uint16"),
    ],
    [
      "CALL_SEND_RESULTS_TO_TAG_BYTE_OFFSET",
      requireUnionDiscriminantByteOffset(callSendResultsToStruct),
    ],
    [
      "CALL_SEND_RESULTS_TO_TAG_CALLER",
      requireUnionTag(callSendResultsToStruct, "caller"),
    ],
    [
      "CALL_TARGET_POINTER_INDEX",
      requirePointerSlotIndex(callStruct, "target"),
    ],
    [
      "CALL_PARAMS_POINTER_INDEX",
      requirePointerSlotIndex(callStruct, "params"),
    ],

    [
      "MESSAGE_TARGET_DATA_WORD_COUNT",
      messageTargetStruct.struct.dataWordCount,
    ],
    ["MESSAGE_TARGET_POINTER_COUNT", messageTargetStruct.struct.pointerCount],
    [
      "MESSAGE_TARGET_TAG_BYTE_OFFSET",
      requireUnionDiscriminantByteOffset(messageTargetStruct),
    ],
    [
      "MESSAGE_TARGET_IMPORTED_CAP_BYTE_OFFSET",
      requireScalarByteOffset(messageTargetStruct, "importedCap", "uint32"),
    ],
    [
      "MESSAGE_TARGET_PROMISED_ANSWER_POINTER_INDEX",
      requirePointerSlotIndex(messageTargetStruct, "promisedAnswer"),
    ],

    [
      "PROMISED_ANSWER_DATA_WORD_COUNT",
      promisedAnswerStruct.struct.dataWordCount,
    ],
    ["PROMISED_ANSWER_POINTER_COUNT", promisedAnswerStruct.struct.pointerCount],
    [
      "PROMISED_ANSWER_QUESTION_ID_BYTE_OFFSET",
      requireScalarByteOffset(promisedAnswerStruct, "questionId", "uint32"),
    ],
    [
      "PROMISED_ANSWER_TRANSFORM_POINTER_INDEX",
      requirePointerSlotIndex(promisedAnswerStruct, "transform"),
    ],

    [
      "PROMISED_ANSWER_OP_DATA_WORD_COUNT",
      promisedAnswerOpStruct.struct.dataWordCount,
    ],
    [
      "PROMISED_ANSWER_OP_POINTER_COUNT",
      promisedAnswerOpStruct.struct.pointerCount,
    ],
    [
      "PROMISED_ANSWER_OP_TAG_BYTE_OFFSET",
      requireUnionDiscriminantByteOffset(promisedAnswerOpStruct),
    ],
    [
      "PROMISED_ANSWER_OP_GET_POINTER_FIELD_BYTE_OFFSET",
      requireScalarByteOffset(
        promisedAnswerOpStruct,
        "getPointerField",
        "uint16",
      ),
    ],

    ["RETURN_DATA_WORD_COUNT", returnStruct.struct.dataWordCount],
    ["RETURN_POINTER_COUNT", returnStruct.struct.pointerCount],
    [
      "RETURN_ANSWER_ID_BYTE_OFFSET",
      requireScalarByteOffset(returnStruct, "answerId", "uint32"),
    ],
    [
      "RETURN_FLAGS_BYTE_OFFSET",
      Math.floor(returnReleaseParamCapsBitOffset / 8),
    ],
    [
      "RETURN_RELEASE_PARAM_CAPS_FLAG_MASK",
      1 << (returnReleaseParamCapsBitOffset % 32),
    ],
    [
      "RETURN_NO_FINISH_NEEDED_FLAG_MASK",
      1 << (returnNoFinishNeededBitOffset % 32),
    ],
    [
      "RETURN_TAG_BYTE_OFFSET",
      requireUnionDiscriminantByteOffset(returnStruct),
    ],
    [
      "RETURN_VARIANT_POINTER_INDEX",
      requireSharedPointerSlotIndex(returnStruct, ["results", "exception"]),
    ],

    ["PAYLOAD_DATA_WORD_COUNT", payloadStruct.struct.dataWordCount],
    ["PAYLOAD_POINTER_COUNT", payloadStruct.struct.pointerCount],
    [
      "PAYLOAD_CONTENT_POINTER_INDEX",
      requirePointerSlotIndex(payloadStruct, "content"),
    ],
    [
      "PAYLOAD_CAP_TABLE_POINTER_INDEX",
      requirePointerSlotIndex(payloadStruct, "capTable"),
    ],

    ["FINISH_DATA_WORD_COUNT", finishStruct.struct.dataWordCount],
    ["FINISH_POINTER_COUNT", finishStruct.struct.pointerCount],
    [
      "FINISH_QUESTION_ID_BYTE_OFFSET",
      requireScalarByteOffset(finishStruct, "questionId", "uint32"),
    ],
    [
      "FINISH_FLAGS_BYTE_OFFSET",
      Math.floor(finishReleaseResultCapsBitOffset / 8),
    ],
    [
      "FINISH_RELEASE_RESULT_CAPS_FLAG_MASK",
      1 << (finishReleaseResultCapsBitOffset % 32),
    ],
    [
      "FINISH_REQUIRE_EARLY_CANCELLATION_WORKAROUND_FLAG_MASK",
      1 << (finishRequireEarlyCancellationWorkaroundBitOffset % 32),
    ],

    ["RELEASE_DATA_WORD_COUNT", releaseStruct.struct.dataWordCount],
    ["RELEASE_POINTER_COUNT", releaseStruct.struct.pointerCount],
    [
      "RELEASE_ID_BYTE_OFFSET",
      requireScalarByteOffset(releaseStruct, "id", "uint32"),
    ],
    [
      "RELEASE_REFERENCE_COUNT_BYTE_OFFSET",
      requireScalarByteOffset(releaseStruct, "referenceCount", "uint32"),
    ],

    ["EXCEPTION_DATA_WORD_COUNT", exceptionStruct.struct.dataWordCount],
    ["EXCEPTION_POINTER_COUNT", exceptionStruct.struct.pointerCount],
    [
      "EXCEPTION_REASON_POINTER_INDEX",
      requirePointerSlotIndex(exceptionStruct, "reason"),
    ],

    [
      "CAP_DESCRIPTOR_DATA_WORD_COUNT",
      capDescriptorStruct.struct.dataWordCount,
    ],
    ["CAP_DESCRIPTOR_POINTER_COUNT", capDescriptorStruct.struct.pointerCount],
    [
      "CAP_DESCRIPTOR_TAG_BYTE_OFFSET",
      requireUnionDiscriminantByteOffset(capDescriptorStruct),
    ],
    [
      "CAP_DESCRIPTOR_ID_BYTE_OFFSET",
      requireScalarByteOffset(capDescriptorStruct, "senderHosted", "uint32"),
    ],
  ];

  const out: string[] = [
    "// Generated by capnpc-deno",
    "// DO NOT EDIT MANUALLY.",
    "",
  ];
  for (const [name, value] of constants) {
    out.push(`export const ${name} = ${value} as const;`);
  }
  out.push(
    "",
    "export const EMPTY_STRUCT_MESSAGE: Uint8Array = new Uint8Array([",
    "  0x00,",
    "  0x00,",
    "  0x00,",
    "  0x00,",
    "  0x01,",
    "  0x00,",
    "  0x00,",
    "  0x00,",
    "  0x00,",
    "  0x00,",
    "  0x00,",
    "  0x00,",
    "  0x00,",
    "  0x00,",
    "  0x00,",
    "  0x00,",
    "]);",
    "",
  );
  return out.join("\n");
}

function collectLocalStructs(
  fileNode: NodeModel,
  nodeById: Map<bigint, NodeModel>,
): Map<string, StructInfo> {
  const prefix = `${fileNode.displayName}:`;
  const out = new Map<string, StructInfo>();
  for (const node of nodeById.values()) {
    if (!node.displayName.startsWith(prefix)) continue;
    if (node.kind !== "struct" || node.structNode === undefined) continue;
    out.set(simpleNodeName(node), { node, struct: node.structNode });
  }
  return out;
}

function requireStruct(
  structs: Map<string, StructInfo>,
  name: string,
): StructInfo {
  const info = structs.get(name);
  if (info !== undefined) return info;
  throw new Error(`rpc wire constants emission failed: missing struct ${name}`);
}

function requireStructById(
  nodeById: Map<bigint, NodeModel>,
  typeId: bigint,
  context: string,
): StructInfo {
  const node = nodeById.get(typeId);
  if (!node || node.kind !== "struct" || node.structNode === undefined) {
    throw new Error(
      `rpc wire constants emission failed: ${context} does not resolve to a struct`,
    );
  }
  return { node, struct: node.structNode };
}

function requireUnionTag(
  descriptor: StructInfo,
  variant: string,
): number {
  const tag = descriptor.struct.fields.find((field) =>
    field.name === variant &&
    field.discriminantValue !== FIELD_NO_DISCRIMINANT
  )?.discriminantValue;
  if (typeof tag === "number") return tag;
  throw new Error(
    `rpc wire constants emission failed: ${descriptor.node.displayName} missing union variant ${variant}`,
  );
}

function requireUnionDiscriminantByteOffset(descriptor: StructInfo): number {
  if (descriptor.struct.discriminantCount <= 0) {
    throw new Error(
      `rpc wire constants emission failed: ${descriptor.node.displayName} has no union`,
    );
  }
  return descriptor.struct.discriminantOffset * 2;
}

function requireSlotField(
  descriptor: StructInfo,
  fieldName: string,
): FieldModel & { slot: NonNullable<FieldModel["slot"]> } {
  const field = descriptor.struct.fields.find((candidate) =>
    candidate.name === fieldName && candidate.slot !== undefined
  );
  if (field && field.slot !== undefined) {
    return field as FieldModel & { slot: NonNullable<FieldModel["slot"]> };
  }
  throw new Error(
    `rpc wire constants emission failed: ${descriptor.node.displayName} missing slot field ${fieldName}`,
  );
}

function requireListElementStruct(
  descriptor: StructInfo,
  fieldName: string,
  nodeById: Map<bigint, NodeModel>,
): StructInfo {
  const field = requireSlotField(descriptor, fieldName);
  if (field.slot.type.kind !== "list") {
    throw new Error(
      `rpc wire constants emission failed: ${descriptor.node.displayName}.${fieldName} is not a list`,
    );
  }
  if (field.slot.type.elementType.kind !== "struct") {
    throw new Error(
      `rpc wire constants emission failed: ${descriptor.node.displayName}.${fieldName} list element is not a struct`,
    );
  }
  return requireStructById(
    nodeById,
    field.slot.type.elementType.typeId,
    `${descriptor.node.displayName}.${fieldName} list element`,
  );
}

function requireGroupStruct(
  descriptor: StructInfo,
  fieldName: string,
  nodeById: Map<bigint, NodeModel>,
): StructInfo {
  const groupField = descriptor.struct.fields.find((candidate) =>
    candidate.name === fieldName && candidate.group !== undefined
  );
  if (!groupField || !groupField.group) {
    throw new Error(
      `rpc wire constants emission failed: ${descriptor.node.displayName} missing group field ${fieldName}`,
    );
  }
  return requireStructById(
    nodeById,
    groupField.group.typeId,
    `${descriptor.node.displayName}.${fieldName} group`,
  );
}

function isPointerType(type: TypeModel): boolean {
  return type.kind === "text" ||
    type.kind === "data" ||
    type.kind === "list" ||
    type.kind === "struct" ||
    type.kind === "interface" ||
    type.kind === "anyPointer";
}

function requirePointerSlotIndex(
  descriptor: StructInfo,
  fieldName: string,
): number {
  const field = requireSlotField(descriptor, fieldName);
  if (!isPointerType(field.slot.type)) {
    throw new Error(
      `rpc wire constants emission failed: ${descriptor.node.displayName}.${fieldName} is not a pointer slot`,
    );
  }
  return field.slot.offset;
}

function requireSharedPointerSlotIndex(
  descriptor: StructInfo,
  fieldNames: string[],
): number {
  if (fieldNames.length === 0) {
    throw new Error(
      `rpc wire constants emission failed: ${descriptor.node.displayName} shared pointer slot check requires fields`,
    );
  }
  const first = requirePointerSlotIndex(descriptor, fieldNames[0]);
  for (let i = 1; i < fieldNames.length; i += 1) {
    const current = requirePointerSlotIndex(descriptor, fieldNames[i]);
    if (current !== first) {
      throw new Error(
        `rpc wire constants emission failed: ${descriptor.node.displayName}.${
          fieldNames[i]
        } pointer slot ${current} does not match ${first}`,
      );
    }
  }
  return first;
}

function requireBoolBitOffset(
  descriptor: StructInfo,
  fieldName: string,
): number {
  const field = requireSlotField(descriptor, fieldName);
  if (field.slot.type.kind !== "bool") {
    throw new Error(
      `rpc wire constants emission failed: ${descriptor.node.displayName}.${fieldName} is not bool`,
    );
  }
  return field.slot.offset;
}

function requireScalarByteOffset(
  descriptor: StructInfo,
  fieldName: string,
  kind: Exclude<
    TypeModel["kind"],
    "list" | "struct" | "interface" | "anyPointer"
  >,
): number {
  const field = requireSlotField(descriptor, fieldName);
  if (field.slot.type.kind !== kind) {
    throw new Error(
      `rpc wire constants emission failed: ${descriptor.node.displayName}.${fieldName} is not ${kind}`,
    );
  }
  switch (kind) {
    case "uint8":
    case "int8":
      return field.slot.offset;
    case "uint16":
    case "int16":
    case "enum":
      return field.slot.offset * 2;
    case "uint32":
    case "int32":
    case "float32":
      return field.slot.offset * 4;
    case "uint64":
    case "int64":
    case "float64":
      return field.slot.offset * 8;
    default:
      throw new Error(
        `rpc wire constants emission failed: unsupported scalar type ${kind}`,
      );
  }
}
