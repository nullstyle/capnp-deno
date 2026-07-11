# capnp-deno RPC Getting Started

Updated: 2026-07-11

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
} from "@nullstyle/capnp";
import {
  bootstrapPingerClient,
  PingerInterfaceId,
  registerPingerServer,
} from "./generated/schema/pinger_types.ts";

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

## Generated Streaming RPC

Methods declared as `-> stream` are generated as application-level streaming RPC
calls. Client methods return `Promise<void>`, server handlers return
`void | Promise<void>`, and codegen emits a typed stream sender helper for each
streaming method.

```capnp
interface CounterSink {
  add @0 (value :UInt32) -> stream;
  total @1 () -> (sum :UInt64, count :UInt32);
}
```

Server:

```ts
import { serve, TcpTransport } from "@nullstyle/capnp";
import type { RpcCallContext } from "@nullstyle/capnp";
import {
  CounterSink,
  type CounterSinkService,
} from "./generated/schema_types.ts";

class CounterServer implements CounterSinkService {
  #sum = 0n;
  #count = 0;

  add(value: number, ctx: RpcCallContext): void {
    if (ctx.signal.aborted) return;
    this.#sum += BigInt(value);
    this.#count++;
  }

  total() {
    return { sum: this.#sum, count: this.#count };
  }
}

serve(
  CounterSink,
  TcpTransport.listen({ hostname: "127.0.0.1", port: 4010 }),
  () => new CounterServer(),
);
```

Client:

```ts
import { connect, TcpTransport } from "@nullstyle/capnp";
import {
  CounterSink,
  createCounterSinkAddStreamSender,
} from "./generated/schema_types.ts";

using counter = await connect(
  CounterSink,
  await TcpTransport.connect("127.0.0.1", 4010),
);

const sender = createCounterSinkAddStreamSender(counter, { maxInFlight: 4 });
for (const value of [1, 2, 3, 5, 8]) {
  await sender.send(value);
}
await sender.flush();

console.log(await counter.total());
```

Use `sender.cancel(reason?)` to abort pending stream calls. The generated helper
forwards cancellation to the underlying RPC call, and server handlers can
observe it through `ctx.signal`.

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
