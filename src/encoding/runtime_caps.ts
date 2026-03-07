/**
 * Capability table helpers for RPC integration in the encoding runtime.
 *
 * @module
 */

import {
  asAnyPointerValue,
  asArray,
  asRecord,
  capabilityIndexFrom,
  resolveActiveDiscriminant,
} from "./runtime_model.ts";
import type { CapabilityPointer, StructDescriptor } from "./runtime_model.ts";
import { decodeStructMessage, encodeStructMessage } from "./runtime_codec.ts";

/**
 * A capability descriptor in the Cap'n Proto RPC cap table.
 * Defined inline so the preamble remains self-contained.
 */
export interface PreambleCapDescriptor {
  tag: number;
  id: number;
}

/** Tag value for a sender-hosted capability descriptor. */
export const CAP_DESCRIPTOR_TAG_SENDER_HOSTED = 1;

/** Result of encoding a struct message with cap table information. */
export interface EncodeWithCapsResult {
  content: Uint8Array;
  capTable: PreambleCapDescriptor[];
}

/**
 * Collected capability entry returned by collectCapabilityPointersFromStruct.
 * fieldPath is a dot-separated path useful for debugging.
 */
export interface CollectedCapability {
  fieldPath: string;
  capabilityIndex: number;
}

/**
 * Collect all CapabilityPointer values from a struct value by walking
 * its descriptor. Returns an array of { fieldPath, capabilityIndex }
 * entries in the order they appear in the struct fields.
 */
export function collectCapabilityPointersFromStruct<
  T extends object,
>(
  descriptor: StructDescriptor<T>,
  value: T,
  prefix: string,
): CollectedCapability[] {
  const result: CollectedCapability[] = [];
  const record = asRecord(value);
  const activeDiscriminant = resolveActiveDiscriminant(descriptor, record);

  for (const field of descriptor.fields) {
    if (
      field.discriminantValue !== undefined &&
      activeDiscriminant !== undefined &&
      field.discriminantValue !== activeDiscriminant
    ) {
      continue;
    }

    const fieldPath = prefix ? prefix + "." + field.name : field.name;
    const fieldValue = record[field.name];

    if (field.kind === "group") {
      const groupDescriptor = field.type.get();
      result.push(
        ...collectCapabilityPointersFromStruct(
          groupDescriptor,
          asRecord(fieldValue),
          fieldPath,
        ),
      );
      continue;
    }

    if (field.type.kind === "interface") {
      const index = capabilityIndexFrom(fieldValue);
      if (index !== null) {
        result.push({ fieldPath, capabilityIndex: index });
      }
      continue;
    }

    if (field.type.kind === "anyPointer") {
      const pointer = asAnyPointerValue(fieldValue);
      if (pointer.kind === "interface") {
        result.push({ fieldPath, capabilityIndex: pointer.capabilityIndex });
      }
      continue;
    }

    if (field.type.kind === "list" && field.type.element.kind === "interface") {
      const items = asArray(fieldValue);
      for (let i = 0; i < items.length; i += 1) {
        const index = capabilityIndexFrom(items[i]);
        if (index !== null) {
          result.push({
            fieldPath: fieldPath + "[" + i + "]",
            capabilityIndex: index,
          });
        }
      }
      continue;
    }

    if (
      field.type.kind === "list" && field.type.element.kind === "anyPointer"
    ) {
      const items = asArray(fieldValue);
      for (let i = 0; i < items.length; i += 1) {
        const pointer = asAnyPointerValue(items[i]);
        if (pointer.kind === "interface") {
          result.push({
            fieldPath: fieldPath + "[" + i + "]",
            capabilityIndex: pointer.capabilityIndex,
          });
        }
      }
      continue;
    }

    if (field.type.kind === "list" && field.type.element.kind === "struct") {
      const items = asArray(fieldValue);
      const elemDescriptor = field.type.element.get();
      for (let i = 0; i < items.length; i += 1) {
        result.push(
          ...collectCapabilityPointersFromStruct(
            elemDescriptor,
            asRecord(items[i]),
            fieldPath + "[" + i + "]",
          ),
        );
      }
      continue;
    }

    if (field.type.kind === "struct") {
      const nestedDescriptor = field.type.get();
      result.push(
        ...collectCapabilityPointersFromStruct(
          nestedDescriptor,
          asRecord(fieldValue),
          fieldPath,
        ),
      );
      continue;
    }
  }

  return result;
}

/**
 * Encode a struct message and produce a cap table from any capability
 * pointer fields found in the value.
 *
 * Each capability pointer in the encoded struct references an index in the
 * returned cap table. The cap table entries use
 * CAP_DESCRIPTOR_TAG_SENDER_HOSTED with the original capabilityIndex
 * as the descriptor ID.
 */
export function encodeStructMessageWithCaps<T extends object>(
  descriptor: StructDescriptor<T>,
  value: T,
): EncodeWithCapsResult {
  const collected = collectCapabilityPointersFromStruct(descriptor, value, "");

  const capTableMap = new Map<number, number>();
  const capTable: PreambleCapDescriptor[] = [];
  for (const entry of collected) {
    if (!capTableMap.has(entry.capabilityIndex)) {
      capTableMap.set(entry.capabilityIndex, capTable.length);
      capTable.push({
        tag: CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
        id: entry.capabilityIndex,
      });
    }
  }

  if (capTable.length === 0) {
    return { content: encodeStructMessage(descriptor, value), capTable: [] };
  }

  const remapped = remapCapabilityIndices(descriptor, value, capTableMap);
  return { content: encodeStructMessage(descriptor, remapped), capTable };
}

/**
 * Create a shallow copy of a struct value with capability indices remapped
 * according to the provided mapping (original index -> cap table position).
 */
export function remapCapabilityIndices<T extends object>(
  descriptor: StructDescriptor<T>,
  value: T,
  mapping: Map<number, number>,
): T {
  const record = asRecord(value);
  const activeDiscriminant = resolveActiveDiscriminant(descriptor, record);
  const out = { ...record };

  for (const field of descriptor.fields) {
    if (
      field.discriminantValue !== undefined &&
      activeDiscriminant !== undefined &&
      field.discriminantValue !== activeDiscriminant
    ) {
      continue;
    }

    const fieldValue = record[field.name];

    if (field.kind === "group") {
      const groupDescriptor = field.type.get();
      out[field.name] = remapCapabilityIndices(
        groupDescriptor,
        asRecord(fieldValue),
        mapping,
      );
      continue;
    }

    if (field.type.kind === "interface") {
      const index = capabilityIndexFrom(fieldValue);
      if (index !== null) {
        const mapped = mapping.get(index);
        if (mapped !== undefined) {
          out[field.name] = { capabilityIndex: mapped };
        }
      }
      continue;
    }

    if (field.type.kind === "anyPointer") {
      const pointer = asAnyPointerValue(fieldValue);
      if (pointer.kind === "interface") {
        const mapped = mapping.get(pointer.capabilityIndex);
        if (mapped !== undefined) {
          out[field.name] = { kind: "interface", capabilityIndex: mapped };
        }
      }
      continue;
    }

    if (field.type.kind === "list" && field.type.element.kind === "interface") {
      const items = asArray(fieldValue);
      out[field.name] = items.map((item) => {
        const index = capabilityIndexFrom(item);
        if (index !== null) {
          const mapped = mapping.get(index);
          if (mapped !== undefined) {
            return { capabilityIndex: mapped };
          }
        }
        return item;
      });
      continue;
    }

    if (
      field.type.kind === "list" && field.type.element.kind === "anyPointer"
    ) {
      const items = asArray(fieldValue);
      out[field.name] = items.map((item) => {
        const pointer = asAnyPointerValue(item);
        if (pointer.kind === "interface") {
          const mapped = mapping.get(pointer.capabilityIndex);
          if (mapped !== undefined) {
            return { kind: "interface", capabilityIndex: mapped };
          }
        }
        return item;
      });
      continue;
    }

    if (field.type.kind === "list" && field.type.element.kind === "struct") {
      const items = asArray(fieldValue);
      const elemDescriptor = field.type.element.get();
      out[field.name] = items.map((item) =>
        remapCapabilityIndices(elemDescriptor, asRecord(item), mapping)
      );
      continue;
    }

    if (field.type.kind === "struct") {
      const nestedDescriptor = field.type.get();
      out[field.name] = remapCapabilityIndices(
        nestedDescriptor,
        asRecord(fieldValue),
        mapping,
      );
      continue;
    }
  }

  return out as T;
}

/**
 * Decode a struct message and resolve capability indices through a cap table.
 *
 * The cap table entries from the RPC message are used to map the capability
 * indices in the decoded struct back to their original export/import IDs.
 * Capability pointer fields in the returned struct will have their
 * capabilityIndex set to the id from the corresponding cap table entry.
 */
export function decodeStructMessageWithCaps<T extends object>(
  descriptor: StructDescriptor<T>,
  bytes: Uint8Array,
  capTable: PreambleCapDescriptor[],
): T {
  const decoded = decodeStructMessage(descriptor, bytes);

  if (capTable.length === 0) {
    return decoded;
  }

  const indexToId = new Map<number, number>();
  for (let i = 0; i < capTable.length; i += 1) {
    indexToId.set(i, capTable[i].id);
  }

  return resolveDecodedCapabilities(descriptor, decoded, indexToId);
}

/**
 * Walk a decoded struct and replace capability indices with their resolved
 * IDs from the cap table mapping (cap table index -> export/import ID).
 */
export function resolveDecodedCapabilities<T extends object>(
  descriptor: StructDescriptor<T>,
  value: T,
  mapping: Map<number, number>,
): T {
  const record = asRecord(value);
  const activeDiscriminant = resolveActiveDiscriminant(descriptor, record);
  const out = { ...record };

  for (const field of descriptor.fields) {
    if (
      field.discriminantValue !== undefined &&
      activeDiscriminant !== undefined &&
      field.discriminantValue !== activeDiscriminant
    ) {
      continue;
    }

    const fieldValue = record[field.name];

    if (field.kind === "group") {
      const groupDescriptor = field.type.get();
      out[field.name] = resolveDecodedCapabilities(
        groupDescriptor,
        asRecord(fieldValue),
        mapping,
      );
      continue;
    }

    if (field.type.kind === "interface") {
      if (fieldValue !== null && fieldValue !== undefined) {
        const cap = fieldValue as CapabilityPointer;
        const resolved = mapping.get(cap.capabilityIndex);
        if (resolved !== undefined) {
          out[field.name] = { capabilityIndex: resolved };
        }
      }
      continue;
    }

    if (field.type.kind === "anyPointer") {
      const pointer = asAnyPointerValue(fieldValue);
      if (pointer.kind === "interface") {
        const resolved = mapping.get(pointer.capabilityIndex);
        if (resolved !== undefined) {
          out[field.name] = { kind: "interface", capabilityIndex: resolved };
        }
      }
      continue;
    }

    if (field.type.kind === "list" && field.type.element.kind === "interface") {
      const items = asArray(fieldValue);
      out[field.name] = items.map((item) => {
        if (item === null || item === undefined) return item;
        const cap = item as CapabilityPointer;
        const resolved = mapping.get(cap.capabilityIndex);
        if (resolved !== undefined) {
          return { capabilityIndex: resolved };
        }
        return item;
      });
      continue;
    }

    if (
      field.type.kind === "list" && field.type.element.kind === "anyPointer"
    ) {
      const items = asArray(fieldValue);
      out[field.name] = items.map((item) => {
        if (item === null || item === undefined) return item;
        const pointer = asAnyPointerValue(item);
        if (pointer.kind === "interface") {
          const resolved = mapping.get(pointer.capabilityIndex);
          if (resolved !== undefined) {
            return { kind: "interface", capabilityIndex: resolved };
          }
        }
        return item;
      });
      continue;
    }

    if (field.type.kind === "list" && field.type.element.kind === "struct") {
      const items = asArray(fieldValue);
      const elemDescriptor = field.type.element.get();
      out[field.name] = items.map((item) =>
        resolveDecodedCapabilities(elemDescriptor, asRecord(item), mapping)
      );
      continue;
    }

    if (field.type.kind === "struct") {
      const nestedDescriptor = field.type.get();
      out[field.name] = resolveDecodedCapabilities(
        nestedDescriptor,
        asRecord(fieldValue),
        mapping,
      );
      continue;
    }
  }

  return out as T;
}
