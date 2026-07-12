/**
 * Schema methods literally named `close` must stay reachable through hydrated
 * `RpcStub`s: the generated lifecycle proxy forwards `close` to the wire
 * method when the schema interface defines one, and capability release for
 * such stubs moves to `Symbol.dispose`/`Symbol.asyncDispose` only. Stubs for
 * interfaces without a schema `close` keep the lifecycle `close()`.
 *
 * Fixture: tests/fixtures/schemas/close_collision_codegen.capnp precompiled
 * to tests/fixtures/codegen_requests/close_collision_request.b64.
 */

import { generateTypescriptFiles } from "../../tools/capnpc-deno/emitter.ts";
import { parseCodeGeneratorRequest } from "../../tools/capnpc-deno/request_parser.ts";
import type {
  CapabilityPointer,
  RpcCallOptions,
  RpcClientTransport,
} from "../../src/rpc.ts";
import { assert, assertEquals } from "../test_utils.ts";

const REQUEST_FIXTURE =
  "tests/fixtures/codegen_requests/close_collision_request.b64";

const ENCODING_RUNTIME_URL = new URL(
  "../../src/encoding.ts",
  import.meta.url,
).href;
const RPC_RUNTIME_URL = new URL(
  "../../src/rpc.ts",
  import.meta.url,
).href;

const RPC_STUB_CAPABILITY = Symbol.for("@nullstyle/capnp/rpcStubCapability");

const HUB_CAPABILITY = 1;
const SESSION_CAPABILITY = 7;
const PLAIN_CAPABILITY = 9;

async function decodeFixture(path: string): Promise<Uint8Array> {
  const base64 = (await Deno.readTextFile(path)).trim();
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function patchRuntimeImport(source: string): string {
  return source
    .replaceAll(`"@nullstyle/capnp/encoding"`, `"${ENCODING_RUNTIME_URL}"`)
    .replaceAll(`"@nullstyle/capnp/rpc"`, `"${RPC_RUNTIME_URL}"`);
}

async function importGeneratedModule(
  source: string,
): Promise<Record<string, unknown>> {
  const patched = patchRuntimeImport(source);
  const url = `data:application/typescript;base64,${btoa(patched)}`;
  return await import(url);
}

async function generateTypesModuleSource(): Promise<string> {
  const request = parseCodeGeneratorRequest(
    await decodeFixture(REQUEST_FIXTURE),
  );
  const generated = generateTypescriptFiles(request);
  const types = generated.find((file) =>
    file.path === "close_collision_codegen_types.ts"
  );
  assert(types !== undefined, "expected close_collision_codegen_types.ts");
  return types.contents;
}

interface RecordedCall {
  capabilityIndex: number;
  methodId: number;
}

interface RecordedRelease {
  capabilityIndex: number;
  referenceCount: number | undefined;
}

interface RecordingHarness {
  transport: RpcClientTransport;
  calls: RecordedCall[];
  releases: RecordedRelease[];
}

function createRecordingTransport(
  mod: Record<string, unknown>,
): RecordingHarness {
  const encodeStructMessage = mod.encodeStructMessage as (
    descriptor: unknown,
    value: unknown,
  ) => Uint8Array;
  const calls: RecordedCall[] = [];
  const releases: RecordedRelease[] = [];
  const transport: RpcClientTransport = {
    call(
      capability: CapabilityPointer,
      methodId: number,
      _params: Uint8Array,
      _options?: RpcCallOptions,
    ): Promise<Uint8Array> {
      calls.push({ capabilityIndex: capability.capabilityIndex, methodId });
      if (capability.capabilityIndex === HUB_CAPABILITY && methodId === 0) {
        return Promise.resolve(encodeStructMessage(mod.OpenResultsStruct, {
          session: { capabilityIndex: SESSION_CAPABILITY },
        }));
      }
      if (capability.capabilityIndex === HUB_CAPABILITY && methodId === 1) {
        return Promise.resolve(
          encodeStructMessage(mod.OpenPlainResultsStruct, {
            aux: { capabilityIndex: PLAIN_CAPABILITY },
          }),
        );
      }
      if (
        capability.capabilityIndex === SESSION_CAPABILITY && methodId === 0
      ) {
        return Promise.resolve(
          encodeStructMessage(mod.CloseResultsStruct, { ok: true }),
        );
      }
      if (
        capability.capabilityIndex === SESSION_CAPABILITY && methodId === 1
      ) {
        return Promise.resolve(
          encodeStructMessage(mod.PingResultsStruct, { echo: "pong" }),
        );
      }
      throw new Error(
        `unexpected call: capability=${capability.capabilityIndex} method=${methodId}`,
      );
    },
    release(
      capability: CapabilityPointer,
      referenceCount?: number,
    ): void {
      releases.push({
        capabilityIndex: capability.capabilityIndex,
        referenceCount,
      });
    },
  };
  return { transport, calls, releases };
}

interface HubServiceClient {
  open(options?: RpcCallOptions): Promise<Record<PropertyKey, unknown>>;
  openPlain(options?: RpcCallOptions): Promise<Record<PropertyKey, unknown>>;
}

async function openHubStubs(mod: Record<string, unknown>): Promise<
  RecordingHarness & {
    session: Record<PropertyKey, unknown>;
    aux: Record<PropertyKey, unknown>;
  }
> {
  const harness = createRecordingTransport(mod);
  const createSessionHubClient = mod.createSessionHubClient as (
    transport: RpcClientTransport,
    capability: CapabilityPointer,
  ) => object;
  const createSessionHubServiceClient = mod.createSessionHubServiceClient as (
    client: object,
    transport: RpcClientTransport,
  ) => HubServiceClient;
  const hub = createSessionHubServiceClient(
    createSessionHubClient(harness.transport, {
      capabilityIndex: HUB_CAPABILITY,
    }),
    harness.transport,
  );
  const session = await hub.open();
  const aux = await hub.openPlain();
  return { ...harness, session, aux };
}

Deno.test("close collision: schema close keeps its generated signature", async () => {
  const source = await generateTypesModuleSource();

  assert(
    source.includes(
      'close(options?: RpcCallOptions): Promise<CloseResults["ok"]>;',
    ),
    "expected the high-level interface to keep the schema close signature",
  );
  assert(
    source.includes('const hasSchemaClose = Reflect.has(client, "close");'),
    "expected the stub lifecycle proxy to detect schema close methods",
  );
  assert(
    source.includes('if (prop === "close" && !hasSchemaClose) return close;'),
    "expected the stub lifecycle proxy to forward schema close methods",
  );
});

Deno.test("close collision: hydrated stub forwards close to the wire method", async () => {
  const mod = await importGeneratedModule(await generateTypesModuleSource());
  const { session, calls, releases } = await openHubStubs(mod);

  const sessionCalls = () =>
    calls.filter((call) => call.capabilityIndex === SESSION_CAPABILITY);

  const closeResult = await (session.close as (
    options?: RpcCallOptions,
  ) => Promise<boolean>)();
  assertEquals(closeResult, true, "expected the decoded wire close result");
  assertEquals(
    JSON.stringify(sessionCalls()),
    JSON.stringify([{ capabilityIndex: SESSION_CAPABILITY, methodId: 0 }]),
    "expected exactly one wire call to CloseableSession.close",
  );
  assertEquals(
    releases.length,
    0,
    "schema close must not release the capability",
  );

  // Other schema methods still pass through the proxy.
  const echo = await (session.ping as (
    options?: RpcCallOptions,
  ) => Promise<string>)();
  assertEquals(echo, "pong");

  // The stub still carries its capability tag for dehydration.
  assertEquals(
    (session[RPC_STUB_CAPABILITY] as CapabilityPointer).capabilityIndex,
    SESSION_CAPABILITY,
  );
});

Deno.test("close collision: capability release moves to Symbol.asyncDispose", async () => {
  const mod = await importGeneratedModule(await generateTypesModuleSource());
  const { session, calls, releases } = await openHubStubs(mod);

  const dispose = session[Symbol.asyncDispose] as () => Promise<void>;
  await dispose();
  assertEquals(
    JSON.stringify(releases),
    JSON.stringify([
      { capabilityIndex: SESSION_CAPABILITY, referenceCount: 1 },
    ]),
    "expected asyncDispose to release the session capability once",
  );

  // Release is idempotent and never routes through the wire method.
  await dispose();
  assertEquals(releases.length, 1);
  assertEquals(
    calls.filter((call) => call.capabilityIndex === SESSION_CAPABILITY).length,
    0,
  );
});

Deno.test("close collision: interfaces without close keep the lifecycle close()", async () => {
  const mod = await importGeneratedModule(await generateTypesModuleSource());
  const { aux, calls, releases } = await openHubStubs(mod);

  await (aux.close as () => Promise<void>)();
  assertEquals(
    JSON.stringify(releases),
    JSON.stringify([
      { capabilityIndex: PLAIN_CAPABILITY, referenceCount: 1 },
    ]),
    "expected lifecycle close to release the plain capability",
  );
  assertEquals(
    calls.filter((call) => call.capabilityIndex === PLAIN_CAPABILITY).length,
    0,
    "lifecycle close must not invoke a wire method",
  );
});
