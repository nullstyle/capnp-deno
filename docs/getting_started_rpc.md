# capnp-deno RPC Getting Started

Updated: 2026-02-09

This guide is schema-first:

1. Define an interface in `.capnp`.
2. Generate `*_rpc.ts` and `*_capnp.ts`.
3. Wire typed server/client helpers onto runtime transports.

## Prerequisites

- Build the runtime module:

```sh
just build-wasm
```

- Generate code from your schema:

```sh
deno task codegen generate --schema schema/pinger.capnp --out generated
```

## Minimal End-To-End Example

This runs in one process using the in-memory harness transport.

```ts
import {
  InMemoryRpcHarnessTransport,
  RpcServerBridge,
  RpcServerRuntime,
  SessionRpcClientTransport,
} from "../mod.ts";
import {
  bootstrapPingerClient,
  createPingerClient,
  PingerInterfaceId,
  registerPingerServer,
} from "../generated/schema/pinger_rpc.ts";

const transport = new InMemoryRpcHarnessTransport();
const bridge = new RpcServerBridge();

const runtime = await RpcServerRuntime.create(transport, bridge, {
  autoStart: true,
  runtimeModule: { expectedVersion: 1 },
});

const sessionClient = new SessionRpcClientTransport(
  runtime.session,
  transport,
  {
    interfaceId: PingerInterfaceId,
    autoStart: false,
  },
);

try {
  // Bootstrap once so server and client agree on the same capability index.
  const bootstrap = await sessionClient.bootstrap();

  registerPingerServer(
    bridge,
    {
      async ping(_params) {
        return {};
      },
    },
    {
      capabilityIndex: bootstrap.capabilityIndex,
      referenceCount: 2,
    },
  );

  const client = createPingerClient(sessionClient, bootstrap);
  const result = await client.ping({});
  console.log(result);

  // Convenience path when bootstrap capability wiring already exists.
  const clientViaBootstrap = await bootstrapPingerClient(sessionClient);
  await clientViaBootstrap.ping({});
} finally {
  await runtime.close();
}
```

## Explicit Finish/Release Lifecycle

Generated method calls auto-finish by default. Use low-level lifecycle control
when needed:

```ts
let questionId = -1;
const raw = await sessionClient.callRaw(
  { capabilityIndex: 0 },
  0,
  new Uint8Array(0),
  {
    autoFinish: false,
    onQuestionId: (id) => {
      questionId = id;
    },
  },
);

console.log(raw.contentBytes.byteLength);
await sessionClient.finish(questionId, { releaseResultCaps: true });
await sessionClient.release({ capabilityIndex: 0 }, 1);
```

## Notes

- Prefer generated `register*Server` and `create*Client`/`bootstrap*Client`
  helpers over hand-written method ordinals.
- RPC codegen now fails generation when method param/result structs are missing,
  instead of emitting late-bound `unknown` fallbacks.
