# Diagnostics

Use `createRpcDebugTracer()` when generated `connect()` / `serve()` calls fail
and you need to see the RPC lifecycle without dumping raw Cap'n Proto payloads.

```ts
import {
  connect,
  createRpcDebugTracer,
  serve,
  TcpTransport,
} from "@nullstyle/capnp";
import { Pinger } from "../examples/ping/gen/schema_types.ts";

const debug = createRpcDebugTracer({ log: true });

using server = serve(
  Pinger,
  TcpTransport.listen({ hostname: "127.0.0.1", port: 4000 }),
  new PingServer(),
  { debug },
);

using client = await connect(
  Pinger,
  await TcpTransport.connect("127.0.0.1", 4000),
  { debug },
);
```

The tracer can be passed as an existing `RpcDebugTracer` or as
`RpcDebugTracerOptions`:

- `log: true` writes concise lines with `console.debug`.
- `log: (line, event) => ...` lets applications route logs elsewhere.
- `maxEvents` bounds the in-memory ring buffer. The default is `500`.
- payload bytes are redacted by default. Use
  `includePayloadHex: { maxBytes: 64 }` only for trusted local debugging.

Generated service tokens carry method metadata. Passing a token to `connect()` /
`serve()` registers that metadata with the tracer automatically, so Call frames
format with names such as `rpc=Pinger.ping` in addition to the numeric interface
and method ids. For lower-level setups, register the generated metadata
explicitly:

```ts
import { createRpcDebugTracer } from "@nullstyle/capnp";
import { PingerDebugMethods } from "../examples/ping/gen/schema_types.ts";

const debug = createRpcDebugTracer({ log: true });
debug.registerSchema?.(PingerDebugMethods);
```

## What Events Contain

Frame events include:

- direction: `send` or `receive`
- message name and tag
- frame size
- question or answer id
- interface id and method id for Call frames
- generated service, interface, and method names when metadata is registered
- capability id and cap-table count where available
- Return kind and exception reason for exception returns
- redacted payload byte length, or an explicitly enabled bounded hex prefix

Observability events include the runtime event name and any structured
`CapnpError.metadata` fields, such as `serviceName`, `methodName`, `questionId`,
`interfaceId`, `methodId`, and `capabilityIndex`.

## Reading Common Failures

- `transport does not support exporting local capabilities`: a generated client
  tried to pass a local callback implementation through a transport that lacks
  `exportCapability`. Use `connect()` / `RpcWireClient` /
  `SessionRpcClientTransport`, or pass an existing `RpcStub`.
- `rpc outbound client is unavailable for capability callbacks`: a generated
  server received a capability parameter, but the runtime context cannot call
  back through `ctx.outboundClient`. Serve through `serve()` or
  `RpcServerRuntime`.
- `unknown method ordinal`: client and server generated stubs disagree on the
  interface method table, or a low-level caller used the wrong method id.
- `interface mismatch for capability`: a capability was called using an
  interface id different from the service registered for that capability.
- `rpc wait timed out after Nms`: the Call frame was sent but no matching Return
  was observed before the timeout. Check tracer events for the question id.

## Programmatic Inspection

```ts
const events = debug.snapshot();
const failedCall = events.find((event) =>
  event.messageName === "Call" &&
  event.interfaceId === Pinger.interfaceId
);
debug.clear();
```

Use `formatRpcDebugEvent(event)` to render a stable one-line summary for custom
logs. The formatter does not reveal payload bytes unless a tracer captured an
explicit hex snippet.
