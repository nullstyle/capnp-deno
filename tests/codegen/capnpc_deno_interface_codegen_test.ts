import { generateTypescriptFiles } from "../../tools/capnpc-deno/emitter.ts";
import {
  type CodeGeneratorRequestModel,
  STREAM_RESULT_TYPE_ID,
} from "../../tools/capnpc-deno/model.ts";
import { parseCodeGeneratorRequest } from "../../tools/capnpc-deno/request_parser.ts";
import { assert, assertEquals } from "../test_utils.ts";

const REQUEST_BASE64 =
  "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";

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

const ENCODING_RUNTIME_URL = new URL(
  "../../src/encoding.ts",
  import.meta.url,
).href;
const RPC_RUNTIME_URL = new URL(
  "../../src/rpc.ts",
  import.meta.url,
).href;

function patchRuntimeImport(source: string): string {
  return source
    .replaceAll(
      `"@nullstyle/capnp/encoding"`,
      `"${ENCODING_RUNTIME_URL}"`,
    )
    .replaceAll(
      `"@nullstyle/capnp/rpc"`,
      `"${RPC_RUNTIME_URL}"`,
    );
}

async function importGeneratedModule(
  source: string,
): Promise<Record<string, unknown>> {
  const patched = patchRuntimeImport(source);
  const url = `data:application/typescript;base64,${btoa(patched)}`;
  return await import(url);
}

function fileByPath(
  files: Array<{ path: string; contents: string }>,
  path: string,
): { path: string; contents: string } {
  const file = files.find((candidate) => candidate.path === path);
  assert(file !== undefined, `expected generated file: ${path}`);
  return file;
}

function encodeSingleU32StructMessage(value: number): Uint8Array {
  const out = new Uint8Array(24);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, 0, true);
  view.setUint32(4, 2, true);
  view.setBigUint64(8, 0x0000_0001_0000_0000n, true);
  view.setUint32(16, value >>> 0, true);
  return out;
}

function decodeSingleU32StructMessage(frame: Uint8Array): number {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const root = view.getBigUint64(8, true);
  const offset = Number((root >> 2n) & 0x3fff_ffffn);
  const signedOffset = (offset & (1 << 29)) !== 0 ? offset - (1 << 30) : offset;
  const dataWord = 1 + signedOffset;
  return view.getUint32(8 + (dataWord * 8), true);
}

Deno.test("capnpc-deno generates interface/anyPointer codec surface", () => {
  const request = parseCodeGeneratorRequest(decodeBase64(REQUEST_BASE64));
  const pingerNode = request.nodes.find((node) =>
    node.displayName.endsWith(":Pinger")
  );
  assert(pingerNode !== undefined, "expected Pinger interface node");
  assert(pingerNode.interfaceNode !== undefined, "expected interface metadata");
  assertEquals(pingerNode.interfaceNode.methods.length, 1);
  assertEquals(pingerNode.interfaceNode.methods[0].name, "ping");
  assertEquals(pingerNode.interfaceNode.methods[0].codeOrder, 0);

  const generated = generateTypescriptFiles(request);
  assertEquals(generated.length, 2);
  const types = fileByPath(generated, "interface_anypointer_codegen_types.ts");
  const meta = fileByPath(generated, "interface_anypointer_codegen_meta.ts");

  assert(
    types.contents.includes('from "@nullstyle/capnp/encoding";'),
    "expected split encoding runtime import",
  );
  assert(
    types.contents.includes('from "@nullstyle/capnp/rpc";'),
    "expected split rpc runtime import",
  );
  const source = types.contents;
  assert(
    source.includes("cap: CapabilityPointer | null;"),
    "expected interface pointer field type",
  );
  assert(
    source.includes("dyn: AnyPointerValue;"),
    "expected anyPointer field type",
  );
  assert(
    source.includes("export const PingParamsCodec"),
    "expected params codec export for rpc generation",
  );
  assert(
    source.includes("export const PingResultsCodec"),
    "expected results codec export for rpc generation",
  );
  assert(
    source.includes("export interface PingerClient"),
    "expected Pinger client interface in generated output",
  );
  assert(
    source.includes("createPingerClient"),
    "expected generated rpc client constructor",
  );
  assert(
    source.includes("bootstrapPingerClient"),
    "expected generated rpc bootstrap client helper",
  );
  assert(
    source.includes("createPingerServer"),
    "expected generated rpc server dispatch constructor",
  );
  assert(
    source.includes("registerPingerServer"),
    "expected generated rpc server registry helper",
  );
  assert(
    !source.includes("export interface RpcCallOptions"),
    "expected generated rpc call options to come from shared runtime types",
  );
  assert(
    source.includes("transport.finish"),
    "expected generated rpc lifecycle finish usage",
  );
  assert(
    source.includes("PingerInterfaceId"),
    "expected generated rpc interface id constant",
  );
  assert(
    source.includes(
      "export const Pinger: RpcServiceToken<Pinger> = createRpcServiceToken({",
    ),
    "expected generated service token export",
  );
  assert(
    source.includes(
      'import { createRpcServiceToken } from "@nullstyle/capnp/rpc";',
    ),
    "expected generated service token factory import",
  );
  assert(
    source.includes("export interface Pinger {"),
    "expected generated high-level service interface",
  );
  assert(
    source.includes(
      "ping(options?: RpcCallOptions): Promise<void>;",
    ),
    "expected generated zero-field method lowering in high-level interface",
  );
  assert(
    source.includes("createPingerServiceClient"),
    "expected generated service client adapter",
  );
  assert(
    source.includes("createPingerServiceServer"),
    "expected generated service server adapter",
  );
  assert(
    source.includes("RpcServiceToken<Pinger>"),
    "expected generated service token type annotation",
  );
  assert(
    source.includes(
      "High-level generated RPC client for `Pinger`.",
    ),
    "expected generated high-level client JSDoc",
  );
  assert(
    source.includes("bootstrapPingerClient"),
    "expected generated service token bootstrap binding",
  );
  assert(
    source.includes("registerPingerServer"),
    "expected generated service token server registrar binding",
  );
  assert(
    meta.contents.includes("export const interfaceMethods = ["),
    "expected interface method metadata export",
  );
});

Deno.test("capnpc-deno generated interface/anyPointer codec roundtrips", async () => {
  const request = parseCodeGeneratorRequest(decodeBase64(REQUEST_BASE64));
  const generated = generateTypescriptFiles(request);
  assertEquals(generated.length, 2);

  const mod = await importGeneratedModule(
    fileByPath(generated, "interface_anypointer_codegen_types.ts").contents,
  );
  const codec = mod.HolderCodec as
    | { encode(value: unknown): Uint8Array; decode(bytes: Uint8Array): unknown }
    | undefined;
  assert(codec !== undefined, "expected HolderCodec export");

  const value1 = {
    cap: { capabilityIndex: 7 },
    dyn: { kind: "interface", capabilityIndex: 9 },
  };
  const decoded1 = codec.decode(codec.encode(value1)) as Record<
    string,
    unknown
  >;
  assertEquals(
    (decoded1.cap as Record<string, unknown>).capabilityIndex,
    value1.cap.capabilityIndex,
  );
  assertEquals(
    (decoded1.dyn as Record<string, unknown>).kind,
    value1.dyn.kind,
  );
  assertEquals(
    (decoded1.dyn as Record<string, unknown>).capabilityIndex,
    value1.dyn.capabilityIndex,
  );

  const value2 = {
    cap: null,
    dyn: { kind: "null" },
  };
  const decoded2 = codec.decode(codec.encode(value2)) as Record<
    string,
    unknown
  >;
  assertEquals(decoded2.cap, null);
  assertEquals((decoded2.dyn as Record<string, unknown>).kind, "null");

  const value3 = {
    cap: null,
    dyn: {
      kind: "message",
      message: encodeSingleU32StructMessage(123),
    },
  };
  const decoded3 = codec.decode(codec.encode(value3)) as Record<
    string,
    unknown
  >;
  assertEquals(decoded3.cap, null);
  assertEquals((decoded3.dyn as Record<string, unknown>).kind, "message");
  const dynMessage = (decoded3.dyn as {
    message?: Uint8Array;
  }).message;
  assert(dynMessage instanceof Uint8Array, "expected anyPointer message bytes");
  assertEquals(decodeSingleU32StructMessage(dynMessage), 123);
});

Deno.test("capnpc-deno generated rpc server dispatch decodes and encodes methods", async () => {
  const request = parseCodeGeneratorRequest(decodeBase64(REQUEST_BASE64));
  const generated = generateTypescriptFiles(request);
  assertEquals(generated.length, 2);

  const mod = await importGeneratedModule(
    fileByPath(generated, "interface_anypointer_codegen_types.ts").contents,
  );
  const capnp = mod;
  const rpc = mod;

  const paramsCodec = capnp.PingParamsCodec as
    | { encode(value: unknown): Uint8Array }
    | undefined;
  const resultsCodec = capnp.PingResultsCodec as
    | { decode(value: Uint8Array): unknown }
    | undefined;
  assert(paramsCodec !== undefined, "expected PingParamsCodec export");
  assert(resultsCodec !== undefined, "expected PingResultsCodec export");

  let called = 0;
  const serverImpl = {
    ping(params: unknown, ctx: unknown): Promise<unknown> | unknown {
      called += 1;
      assertEquals(typeof params, "object");
      assertEquals(typeof ctx, "object");
      return {};
    },
  };
  const dispatchFactory = rpc.createPingerServer as
    | ((server: {
      ping(params: unknown, ctx: unknown): Promise<unknown> | unknown;
    }) => {
      interfaceId: bigint;
      dispatch(
        methodId: number,
        params: Uint8Array,
        ctx: unknown,
      ): Promise<Uint8Array>;
    })
    | undefined;
  assert(dispatchFactory !== undefined, "expected createPingerServer export");
  const dispatch = dispatchFactory(serverImpl);

  const registerServer = rpc.registerPingerServer as
    | ((registry: {
      exportCapability(
        dispatch: {
          interfaceId: bigint;
          dispatch(
            methodId: number,
            params: Uint8Array,
            ctx: unknown,
          ): Promise<Uint8Array>;
        },
        options?: { capabilityIndex?: number; referenceCount?: number },
      ): { capabilityIndex: number };
    }, server: {
      ping(params: unknown, ctx: unknown): Promise<unknown> | unknown;
    }, options?: {
      capabilityIndex?: number;
      referenceCount?: number;
    }) => { capabilityIndex: number })
    | undefined;
  assert(registerServer !== undefined, "expected registerPingerServer export");
  let capturedDispatch:
    | {
      interfaceId: bigint;
      dispatch(
        methodId: number,
        params: Uint8Array,
        ctx: unknown,
      ): Promise<Uint8Array>;
    }
    | null = null;
  let capturedReferenceCount = -1;
  const registered = registerServer(
    {
      exportCapability(nextDispatch, options) {
        capturedDispatch = nextDispatch;
        capturedReferenceCount = options?.referenceCount ?? -1;
        return { capabilityIndex: options?.capabilityIndex ?? 0 };
      },
    },
    serverImpl,
    { capabilityIndex: 11, referenceCount: 3 },
  );
  assertEquals(registered.capabilityIndex, 11);
  if (capturedDispatch === null) {
    throw new Error("expected server dispatch registration");
  }
  const registeredDispatch: {
    interfaceId: bigint;
    dispatch(
      methodId: number,
      params: Uint8Array,
      ctx: unknown,
    ): Promise<Uint8Array>;
  } = capturedDispatch;
  assertEquals(capturedReferenceCount, 3);

  const encoded = await dispatch.dispatch(
    0,
    paramsCodec.encode({}),
    { capability: { capabilityIndex: 7 }, methodId: 0 },
  );
  const decoded = resultsCodec.decode(encoded) as Record<string, unknown>;
  assertEquals(Object.keys(decoded).length, 0);
  assertEquals(called, 1);

  const encodedViaRegistry = await registeredDispatch.dispatch(
    0,
    paramsCodec.encode({}),
    { capability: { capabilityIndex: 11 }, methodId: 0 },
  );
  const decodedViaRegistry = resultsCodec.decode(encodedViaRegistry) as Record<
    string,
    unknown
  >;
  assertEquals(Object.keys(decodedViaRegistry).length, 0);
  assertEquals(called, 2);

  let thrown: unknown;
  try {
    await dispatch.dispatch(
      999,
      paramsCodec.encode({}),
      { capability: { capabilityIndex: 7 }, methodId: 999 },
    );
  } catch (error) {
    thrown = error;
  }
  if (
    !(thrown instanceof Error) || !/unknown method ordinal/.test(thrown.message)
  ) {
    throw new Error(
      `expected unknown method ordinal error, got: ${String(thrown)}`,
    );
  }
});

Deno.test("capnpc-deno generated rpc client invokes optional finish lifecycle hook", async () => {
  const request = parseCodeGeneratorRequest(decodeBase64(REQUEST_BASE64));
  const generated = generateTypescriptFiles(request);
  assertEquals(generated.length, 2);

  const mod = await importGeneratedModule(
    fileByPath(generated, "interface_anypointer_codegen_types.ts").contents,
  );
  const capnp = mod;
  const rpc = mod;

  const bootstrapClient = rpc.bootstrapPingerClient as
    | ((transport: {
      bootstrap(options?: { timeoutMs?: number }): Promise<{
        capabilityIndex: number;
      }>;
      call(
        capability: unknown,
        methodId: number,
        params: Uint8Array,
        options?: {
          onQuestionId?: (questionId: number) => void;
          autoFinish?: boolean;
          finish?: { releaseResultCaps?: boolean };
        },
      ): Promise<Uint8Array>;
      finish?(
        questionId: number,
        options?: { releaseResultCaps?: boolean },
      ): Promise<void> | void;
    }, options?: { timeoutMs?: number }) => Promise<{
      ping(params: Record<string, unknown>, options?: {
        finish?: { releaseResultCaps?: boolean };
      }): Promise<Record<string, unknown>>;
    }>)
    | undefined;
  assert(
    bootstrapClient !== undefined,
    "expected bootstrapPingerClient export",
  );

  const paramsCodec = capnp.PingParamsCodec as
    | { decode(bytes: Uint8Array): unknown }
    | undefined;
  const resultsCodec = capnp.PingResultsCodec as
    | { encode(value: unknown): Uint8Array }
    | undefined;
  assert(paramsCodec !== undefined, "expected PingParamsCodec export");
  assert(resultsCodec !== undefined, "expected PingResultsCodec export");

  let callCount = 0;
  let bootstrapTimeoutMs = -1;
  let finishQuestionId = -1;
  let releaseResultCaps = false;
  const client = await bootstrapClient({
    bootstrap(options) {
      bootstrapTimeoutMs = options?.timeoutMs ?? -1;
      return Promise.resolve({ capabilityIndex: 9 });
    },
    call(_capability, methodId, params, options) {
      callCount += 1;
      assertEquals(methodId, 0);
      const decoded = paramsCodec.decode(params) as Record<string, unknown>;
      assertEquals(Object.keys(decoded).length, 0);
      options?.onQuestionId?.(42);
      return Promise.resolve(resultsCodec.encode({}));
    },
    finish(questionId, options) {
      finishQuestionId = questionId;
      releaseResultCaps = options?.releaseResultCaps ?? false;
      return Promise.resolve();
    },
  }, { timeoutMs: 250 });

  const result = await client.ping({}, {
    finish: { releaseResultCaps: true },
  });
  assertEquals(Object.keys(result).length, 0);
  assertEquals(bootstrapTimeoutMs, 250);
  assertEquals(callCount, 1);
  assertEquals(finishQuestionId, 42);
  assertEquals(releaseResultCaps, true);
});

function makeStreamingRequest(): CodeGeneratorRequestModel {
  const fileId = 0x700n;
  const interfaceId = 0x701n;
  const paramsId = 0x702n;
  const prefix = "tests/fixtures/schemas/streaming_codegen.capnp:";

  return {
    nodes: [
      {
        id: fileId,
        displayName: "tests/fixtures/schemas/streaming_codegen.capnp",
        displayNamePrefixLength: 0,
        scopeId: 0n,
        nestedNodes: [{ name: "Counter", id: interfaceId }],
        kind: "file",
      },
      {
        id: interfaceId,
        displayName: `${prefix}Counter`,
        displayNamePrefixLength: prefix.length,
        scopeId: fileId,
        nestedNodes: [],
        kind: "interface",
        interfaceNode: {
          methods: [{
            name: "add",
            codeOrder: 0,
            paramStructTypeId: paramsId,
            resultStructTypeId: STREAM_RESULT_TYPE_ID,
          }],
        },
      },
      {
        id: paramsId,
        displayName: `${prefix}Counter.add$Params`,
        displayNamePrefixLength: prefix.length,
        scopeId: interfaceId,
        nestedNodes: [],
        kind: "struct",
        structNode: {
          dataWordCount: 1,
          pointerCount: 0,
          isGroup: false,
          discriminantCount: 0,
          discriminantOffset: 0,
          fields: [{
            name: "value",
            codeOrder: 0,
            discriminantValue: 0xffff,
            slot: { offset: 0, type: { kind: "uint32" } },
          }],
        },
      },
    ],
    requestedFiles: [{
      id: fileId,
      filename: "tests/fixtures/schemas/streaming_codegen.capnp",
      imports: [],
    }],
  };
}

function makeCallbackRequest(): CodeGeneratorRequestModel {
  const fileId = 0x710n;
  const pingerId = 0x711n;
  const pongerId = 0x712n;
  const pingParamsId = 0x713n;
  const pingResultsId = 0x714n;
  const pongParamsId = 0x715n;
  const pongResultsId = 0x716n;
  const prefix = "tests/fixtures/schemas/callback_codegen.capnp:";

  return {
    nodes: [
      {
        id: fileId,
        displayName: "tests/fixtures/schemas/callback_codegen.capnp",
        displayNamePrefixLength: 0,
        scopeId: 0n,
        nestedNodes: [
          { name: "Pinger", id: pingerId },
          { name: "Ponger", id: pongerId },
        ],
        kind: "file",
      },
      {
        id: pingerId,
        displayName: `${prefix}Pinger`,
        displayNamePrefixLength: prefix.length,
        scopeId: fileId,
        nestedNodes: [],
        kind: "interface",
        interfaceNode: {
          methods: [{
            name: "ping",
            codeOrder: 0,
            paramStructTypeId: pingParamsId,
            resultStructTypeId: pingResultsId,
          }],
        },
      },
      {
        id: pongerId,
        displayName: `${prefix}Ponger`,
        displayNamePrefixLength: prefix.length,
        scopeId: fileId,
        nestedNodes: [],
        kind: "interface",
        interfaceNode: {
          methods: [{
            name: "pong",
            codeOrder: 0,
            paramStructTypeId: pongParamsId,
            resultStructTypeId: pongResultsId,
          }],
        },
      },
      {
        id: pingParamsId,
        displayName: `${prefix}Pinger.ping$Params`,
        displayNamePrefixLength: prefix.length,
        scopeId: pingerId,
        nestedNodes: [],
        kind: "struct",
        structNode: {
          dataWordCount: 0,
          pointerCount: 1,
          isGroup: false,
          discriminantCount: 0,
          discriminantOffset: 0,
          fields: [{
            name: "p",
            codeOrder: 0,
            discriminantValue: 0xffff,
            slot: {
              offset: 0,
              type: { kind: "interface", typeId: pongerId },
            },
          }],
        },
      },
      {
        id: pingResultsId,
        displayName: `${prefix}Pinger.ping$Results`,
        displayNamePrefixLength: prefix.length,
        scopeId: pingerId,
        nestedNodes: [],
        kind: "struct",
        structNode: {
          dataWordCount: 0,
          pointerCount: 0,
          isGroup: false,
          discriminantCount: 0,
          discriminantOffset: 0,
          fields: [],
        },
      },
      {
        id: pongParamsId,
        displayName: `${prefix}Ponger.pong$Params`,
        displayNamePrefixLength: prefix.length,
        scopeId: pongerId,
        nestedNodes: [],
        kind: "struct",
        structNode: {
          dataWordCount: 1,
          pointerCount: 0,
          isGroup: false,
          discriminantCount: 0,
          discriminantOffset: 0,
          fields: [{
            name: "n",
            codeOrder: 0,
            discriminantValue: 0xffff,
            slot: { offset: 0, type: { kind: "uint32" } },
          }],
        },
      },
      {
        id: pongResultsId,
        displayName: `${prefix}Ponger.pong$Results`,
        displayNamePrefixLength: prefix.length,
        scopeId: pongerId,
        nestedNodes: [],
        kind: "struct",
        structNode: {
          dataWordCount: 0,
          pointerCount: 0,
          isGroup: false,
          discriminantCount: 0,
          discriminantOffset: 0,
          fields: [],
        },
      },
    ],
    requestedFiles: [{
      id: fileId,
      filename: "tests/fixtures/schemas/callback_codegen.capnp",
      imports: [],
    }],
  };
}

Deno.test("capnpc-deno documents generated callback-capable params", () => {
  const generated = generateTypescriptFiles(makeCallbackRequest());
  assertEquals(generated.length, 2);
  const types = fileByPath(generated, "callback_codegen_types.ts");
  const source = types.contents;

  assert(
    source.includes(
      "@param value - Local `Ponger` implementation or remote `RpcStub<Ponger>` callback capability.",
    ),
    "expected generated callback parameter JSDoc",
  );
  assert(
    source.includes("value: Ponger | RpcStub<Ponger>"),
    "expected generated callback-capable high-level method signature",
  );
  assert(
    source.includes(
      "p: exportCapabilityFromTransport(transport, Ponger, value)",
    ),
    "expected generated callback params to export local capabilities",
  );
});

Deno.test("capnpc-deno generates first-class streaming RPC methods", () => {
  const generated = generateTypescriptFiles(makeStreamingRequest());
  assertEquals(generated.length, 2);
  const types = fileByPath(generated, "streaming_codegen_types.ts");
  const source = types.contents;

  assert(
    source.includes("options?: RpcCallOptions): Promise<void>;"),
    "expected low-level streaming client to return void",
  );
  assert(
    /add\(params: \w*AddParams, ctx: RpcCallContext\): Promise<void> \| void;/
      .test(source),
    "expected low-level streaming server to return void",
  );
  assert(
    source.includes("return new Uint8Array(EMPTY_STRUCT_MESSAGE);"),
    "expected streaming server dispatch to return empty payload",
  );
  assert(
    source.includes("export interface Counter {") &&
      /add\(value: \w*AddParams\["value"\], options\?: RpcCallOptions\): Promise<void>;/
        .test(source),
    "expected high-level client streaming method",
  );
  assert(
    source.includes("export interface CounterService {") &&
      /add\(value: \w*AddParams\["value"\], ctx: RpcCallContext\): Promise<void> \| void;/
        .test(source),
    "expected high-level server streaming method with context",
  );
  assert(
    source.includes(
      "High-level generated RPC client for `Counter`.",
    ) &&
      source.includes(
        "High-level generated RPC server implementation for `Counter`.",
      ),
    "expected generated streaming service JSDoc",
  );
  assert(
    source.includes(
      "@param ctx - RPC call context. `ctx.signal` aborts when the caller requests early cancellation.",
    ),
    "expected generated server context JSDoc",
  );
  assert(
    source.includes(
      "export const Counter: RpcServiceToken<Counter, CounterService> = createRpcServiceToken({",
    ),
    "expected separate client/server service token types",
  );
  assert(
    source.includes("export function createCounterAddStreamSender(") &&
      /StreamSender<\w*AddParams\["value"\], void>/.test(source) &&
      /createStreamSender<\w*AddParams\["value"\], void>/.test(source),
    "expected typed generated stream sender helper",
  );
  assert(
    source.includes("Create a typed stream sender for `Counter.add`.") &&
      /@returns A `StreamSender` whose `send\(\)` accepts `\w*AddParams\["value"\]`\./
        .test(source),
    "expected generated stream sender JSDoc",
  );
  assert(
    source.includes(
      "import { EMPTY_STRUCT_MESSAGE, createRpcServiceToken, createStreamSender }",
    ) &&
      source.includes("StreamSenderOptions,"),
    "expected generated streaming imports",
  );
  assert(
    !source.includes("StreamResult"),
    "expected no generated dependency on a local StreamResult codec",
  );
});
