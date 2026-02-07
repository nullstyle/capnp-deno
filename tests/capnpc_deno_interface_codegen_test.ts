import { generateTypescriptFiles } from "../tools/capnpc-deno/emitter.ts";
import { parseCodeGeneratorRequest } from "../tools/capnpc-deno/request_parser.ts";
import { assert, assertEquals } from "./test_utils.ts";

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

async function importGeneratedModule(
  source: string,
): Promise<Record<string, unknown>> {
  const url = `data:application/typescript;base64,${btoa(source)}`;
  return await import(url);
}

async function importRpcWithInlineCapnp(
  capnpSource: string,
  rpcSource: string,
): Promise<{ capnp: Record<string, unknown>; rpc: Record<string, unknown> }> {
  const capnpUrl = `data:application/typescript;base64,${btoa(capnpSource)}`;
  const rpcPatched = rpcSource.split("./interface_anypointer_codegen_capnp.ts")
    .join(capnpUrl);
  const rpcUrl = `data:application/typescript;base64,${btoa(rpcPatched)}`;
  const [capnp, rpc] = await Promise.all([import(capnpUrl), import(rpcUrl)]);
  return { capnp, rpc };
}

function fileByPath(
  files: Array<{ path: string; contents: string }>,
  path: string,
): { path: string; contents: string } {
  const file = files.find((candidate) => candidate.path === path);
  assert(file !== undefined, `expected generated file: ${path}`);
  return file;
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
  assertEquals(generated.length, 3);
  const capnp = fileByPath(generated, "interface_anypointer_codegen_capnp.ts");
  const rpc = fileByPath(generated, "interface_anypointer_codegen_rpc.ts");
  const meta = fileByPath(generated, "interface_anypointer_codegen_meta.ts");

  const source = capnp.contents;
  assert(
    source.includes("export interface CapabilityPointer"),
    "expected CapabilityPointer runtime type",
  );
  assert(
    source.includes("export type AnyPointerValue"),
    "expected AnyPointerValue runtime type",
  );
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
    rpc.contents.includes("export interface PingerClient"),
    "expected Pinger client interface in rpc module",
  );
  assert(
    rpc.contents.includes("createPingerClient"),
    "expected generated rpc client constructor",
  );
  assert(
    rpc.contents.includes("createPingerServer"),
    "expected generated rpc server dispatch constructor",
  );
  assert(
    rpc.contents.includes("export interface RpcFinishOptions"),
    "expected generated rpc finish options",
  );
  assert(
    rpc.contents.includes("finish?(questionId: number"),
    "expected generated rpc lifecycle finish hook",
  );
  assert(
    rpc.contents.includes("PingerInterfaceId"),
    "expected generated rpc interface id constant",
  );
  assert(
    meta.contents.includes("export const interfaceMethods = ["),
    "expected interface method metadata export",
  );
});

Deno.test("capnpc-deno generated interface/anyPointer codec roundtrips", async () => {
  const request = parseCodeGeneratorRequest(decodeBase64(REQUEST_BASE64));
  const generated = generateTypescriptFiles(request);
  assertEquals(generated.length, 3);

  const mod = await importGeneratedModule(
    fileByPath(generated, "interface_anypointer_codegen_capnp.ts").contents,
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
});

Deno.test("capnpc-deno generated rpc server dispatch decodes and encodes methods", async () => {
  const request = parseCodeGeneratorRequest(decodeBase64(REQUEST_BASE64));
  const generated = generateTypescriptFiles(request);
  assertEquals(generated.length, 3);

  const capnpFile = fileByPath(
    generated,
    "interface_anypointer_codegen_capnp.ts",
  );
  const rpcFile = fileByPath(generated, "interface_anypointer_codegen_rpc.ts");
  const { capnp, rpc } = await importRpcWithInlineCapnp(
    capnpFile.contents,
    rpcFile.contents,
  );

  const paramsCodec = capnp.PingParamsCodec as
    | { encode(value: unknown): Uint8Array }
    | undefined;
  const resultsCodec = capnp.PingResultsCodec as
    | { decode(value: Uint8Array): unknown }
    | undefined;
  assert(paramsCodec !== undefined, "expected PingParamsCodec export");
  assert(resultsCodec !== undefined, "expected PingResultsCodec export");

  let called = 0;
  const dispatchFactory = rpc.createPingerServer as
    | ((server: {
      ping(params: unknown, ctx: unknown): Promise<unknown> | unknown;
    }) => {
      interfaceId: bigint;
      dispatch(
        methodOrdinal: number,
        params: Uint8Array,
        ctx: unknown,
      ): Promise<Uint8Array>;
    })
    | undefined;
  assert(dispatchFactory !== undefined, "expected createPingerServer export");
  const dispatch = dispatchFactory({
    ping(params, ctx) {
      called += 1;
      assertEquals(typeof params, "object");
      assertEquals(typeof ctx, "object");
      return {};
    },
  });

  const encoded = await dispatch.dispatch(
    0,
    paramsCodec.encode({}),
    { capability: { capabilityIndex: 7 }, methodOrdinal: 0 },
  );
  const decoded = resultsCodec.decode(encoded) as Record<string, unknown>;
  assertEquals(Object.keys(decoded).length, 0);
  assertEquals(called, 1);

  let thrown: unknown;
  try {
    await dispatch.dispatch(
      999,
      paramsCodec.encode({}),
      { capability: { capabilityIndex: 7 }, methodOrdinal: 999 },
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
  assertEquals(generated.length, 3);

  const capnpFile = fileByPath(
    generated,
    "interface_anypointer_codegen_capnp.ts",
  );
  const rpcFile = fileByPath(generated, "interface_anypointer_codegen_rpc.ts");
  const { capnp, rpc } = await importRpcWithInlineCapnp(
    capnpFile.contents,
    rpcFile.contents,
  );

  const createClient = rpc.createPingerClient as
    | ((transport: {
      call(
        capability: unknown,
        methodOrdinal: number,
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
    }, capability: { capabilityIndex: number }) => {
      ping(params: Record<string, unknown>, options?: {
        finish?: { releaseResultCaps?: boolean };
      }): Promise<Record<string, unknown>>;
    })
    | undefined;
  assert(createClient !== undefined, "expected createPingerClient export");

  const paramsCodec = capnp.PingParamsCodec as
    | { decode(bytes: Uint8Array): unknown }
    | undefined;
  const resultsCodec = capnp.PingResultsCodec as
    | { encode(value: unknown): Uint8Array }
    | undefined;
  assert(paramsCodec !== undefined, "expected PingParamsCodec export");
  assert(resultsCodec !== undefined, "expected PingResultsCodec export");

  let callCount = 0;
  let finishQuestionId = -1;
  let releaseResultCaps = false;
  const client = createClient({
    call(_capability, methodOrdinal, params, options) {
      callCount += 1;
      assertEquals(methodOrdinal, 0);
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
  }, { capabilityIndex: 9 });

  const result = await client.ping({}, {
    finish: { releaseResultCaps: true },
  });
  assertEquals(Object.keys(result).length, 0);
  assertEquals(callCount, 1);
  assertEquals(finishQuestionId, 42);
  assertEquals(releaseResultCaps, true);
});
