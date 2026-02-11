// Generated-style fixture for CI type-check regression gate.
//
// This file mimics the RPC module output of capnpc-deno codegen and
// exercises the generated client/server surface types against
// the shared generated runtime contracts. If the generic constraints regress, this file
// will fail `deno check`.
//
// DO NOT EDIT unless updating to match emitter output patterns.

import type {
  CapabilityPointer,
  EncodeWithCapsResult,
  PingParams,
  PingResults,
  PreambleCapDescriptor,
  RpcBootstrapClientTransport,
  RpcCallContext,
  RpcCallOptions,
  RpcClientTransport,
  RpcExportCapabilityOptions,
  RpcServerDispatch,
  RpcServerDispatchResult,
  RpcServerRegistry,
} from "./typegate_fixture_capnp.ts";
import {
  decodeStructMessageWithCaps,
  encodeStructMessageWithCaps,
  PingParamsCodec,
  PingParamsDescriptor,
  PingResultsDescriptor,
} from "./typegate_fixture_capnp.ts";
export type {
  RpcBootstrapClientTransport,
  RpcCallContext,
  RpcCallOptions,
  RpcClientTransport,
  RpcExportCapabilityOptions,
  RpcFinishOptions,
  RpcServerDispatch,
  RpcServerDispatchResult,
  RpcServerRegistry,
} from "./typegate_fixture_capnp.ts";

// ---------------------------------------------------------------------------
// Interface: Pinger
// ---------------------------------------------------------------------------

export const PingerInterfaceId = 0x123456789abcdef0n;

export const PingerMethodOrdinals = {
  ping: 0,
} as const;

export interface PingerClient {
  ping(
    params: PingParams,
    options?: RpcCallOptions,
  ): Promise<PingResults>;
}

export interface PingerServer {
  ping(
    params: PingParams,
    ctx: RpcCallContext,
  ): Promise<PingResults> | PingResults;
}

export function createPingerClient(
  transport: RpcClientTransport,
  capability: CapabilityPointer,
): PingerClient {
  return {
    ping: async (
      params: PingParams,
      options?: RpcCallOptions,
    ): Promise<PingResults> => {
      const encoded: EncodeWithCapsResult = encodeStructMessageWithCaps(
        PingParamsDescriptor,
        params,
      );
      let questionId: number | undefined;
      const callOptions: RpcCallOptions & {
        paramsCapTable?: PreambleCapDescriptor[];
      } = {
        ...(options ?? {}),
        interfaceId: options?.interfaceId ?? 0x123456789abcdef0n,
        onQuestionId: (value: number): void => {
          questionId = value;
          options?.onQuestionId?.(value);
        },
        ...(encoded.capTable.length > 0
          ? { paramsCapTable: encoded.capTable }
          : {}),
      };
      if (transport.callRaw) {
        const raw = await transport.callRaw(
          capability,
          PingerMethodOrdinals["ping"],
          encoded.content,
          callOptions,
        );
        try {
          return decodeStructMessageWithCaps(
            PingResultsDescriptor,
            raw.contentBytes,
            raw.capTable,
          ) as PingResults;
        } finally {
          if (
            (options?.autoFinish ?? true) && questionId !== undefined &&
            transport.finish
          ) {
            await transport.finish(questionId, options?.finish);
          }
        }
      }
      const response = await transport.call(
        capability,
        PingerMethodOrdinals["ping"],
        encoded.content,
        callOptions,
      );
      try {
        return decodeStructMessageWithCaps(
          PingResultsDescriptor,
          response,
          [],
        ) as PingResults;
      } finally {
        if (
          (options?.autoFinish ?? true) && questionId !== undefined &&
          transport.finish
        ) {
          await transport.finish(questionId, options?.finish);
        }
      }
    },
  };
}

export async function bootstrapPingerClient(
  transport: RpcBootstrapClientTransport,
  options?: RpcCallOptions,
): Promise<PingerClient> {
  const capability = await transport.bootstrap(options);
  return createPingerClient(transport, capability);
}

export function createPingerServer(
  server: PingerServer,
): RpcServerDispatch {
  return {
    interfaceId: PingerInterfaceId,
    dispatch: async (
      methodId: number,
      params: Uint8Array,
      ctx: RpcCallContext,
    ): Promise<RpcServerDispatchResult> => {
      switch (methodId) {
        case 0: {
          const decoded = decodeStructMessageWithCaps(
            PingParamsDescriptor,
            params,
            ctx.paramsCapTable ?? [],
          ) as PingParams;
          const result = await server["ping"](decoded, ctx);
          const encoded = encodeStructMessageWithCaps(
            PingResultsDescriptor,
            result,
          );
          if (encoded.capTable.length > 0) {
            return {
              content: encoded.content,
              capTable: encoded.capTable,
            };
          }
          return encoded.content;
        }
        default:
          throw new Error("unknown method ordinal: " + methodId);
      }
    },
  };
}

export function registerPingerServer(
  registry: RpcServerRegistry,
  server: PingerServer,
  options: RpcExportCapabilityOptions = {},
): CapabilityPointer {
  return registry.exportCapability(
    createPingerServer(server),
    options,
  );
}
