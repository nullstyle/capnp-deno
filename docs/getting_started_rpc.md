# capnp-deno RPC Getting Started

Updated: 2026-02-10

This guide is schema-first:

1. Define an interface in `.capnp`.
2. Generate `*_types.ts`.
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
  RpcServerRuntime,
  SessionRpcClientTransport,
} from "../mod.ts";
import {
  bootstrapPingerClient,
  PingerInterfaceId,
  registerPingerServer,
} from "../generated/schema/pinger_types.ts";

const transport = new InMemoryRpcHarnessTransport();
const runtime = await RpcServerRuntime.createWithRoot(
  transport,
  registerPingerServer,
  {
    async ping(_params) {
      return {};
    },
  },
  {
    autoStart: true,
  },
);

const sessionClient = new SessionRpcClientTransport(
  runtime.session,
  transport,
  {
    interfaceId: PingerInterfaceId,
    autoStart: false,
  },
);

try {
  const client = await bootstrapPingerClient(sessionClient);
  const result = await client.ping({});
  console.log(result);
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
- `createWithRoot()` is the default server path; explicit
  `capabilityIndex`/`referenceCount` wiring is only needed for advanced
  capability-table control.
- RPC codegen now fails generation when method param/result structs are missing,
  instead of emitting late-bound `unknown` fallbacks.
- `connectAndBootstrap(...)` is schema-agnostic and can be used repeatedly in
  one app with different generated `bootstrap*Client(...)` helpers from
  different schemas.
