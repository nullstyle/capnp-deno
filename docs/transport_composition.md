# Transport Composition Guide

Updated: 2026-02-10

How to wire transports, sessions, and runtimes for different deployment
scenarios.

## Overview

capnp-deno uses a layered architecture for RPC communication:

```
Application code
       |
  Client / Server API    (SessionRpcClientTransport, RpcServerRuntime)
       |
  RpcSession             (binds a WasmPeer to a transport)
       |
  MiddlewareTransport    (optional: logging, metrics, frame limits)
       |
  RpcTransport           (TcpTransport, WebSocketTransport, MessagePortTransport)
       |
  Network / IPC
```

Each layer has a single responsibility. You compose them by passing the lower
layer into the constructor of the layer above.

## Core Invariant

After each inbound frame, the session drains **all** outbound frames from the
WASM peer before processing the next inbound frame. This preserves Cap'n Proto
message ordering. The `RpcSession.pumpInboundFrame` method enforces this by
calling `peer.pushFrame(frame)` and immediately sending every resulting outbound
frame via `transport.send()`.

On the server side, `RpcServerRuntime` extends this invariant: after draining
outbound frames it also pumps host calls from the WASM peer (up to
`maxCallsPerInboundFrame`) before accepting the next inbound frame.

**Do not** process inbound frames concurrently on the same session.

## Component Reference

### `RpcTransport` (interface)

The lowest-level contract: `start(onFrame)`, `send(frame)`, `close()`. All
concrete transports implement this. You never need to implement it yourself
unless you are adding a new wire protocol.

### `TcpTransport`

Communicates over a Deno `Deno.Conn` TCP socket. Uses `CapnpFrameFramer` to
reassemble Cap'n Proto frames from the byte stream. Use the static
`TcpTransport.connect(hostname, port)` factory for clients or
`TcpTransport.listen({ ... })` for servers.

### `WebSocketTransport`

Communicates over a standard `WebSocket` with `binaryType = "arraybuffer"`. Use
`WebSocketTransport.connect(url)` for clients. For servers, pass an already-open
`WebSocket` (from your HTTP framework) to the constructor.

### `WebTransportTransport`

Communicates over a WebTransport bidirectional stream running on HTTP/3/QUIC.
Use `WebTransportTransport.connect(url)` for clients. Client URLs must use
`https:`. On the server side, accept or upgrade a WebTransport session and wrap
it with `WebTransportTransport.accept(session)`, or use
`WebTransportTransport.listen(...)` with `serve(...)`.

Browser and Deno loopback clients usually trust development certificates with
`createWebTransportCertificateHashOptions(...)`. Use
`getWebTransportRuntimeSupport()` to detect whether the current runtime has the
client and server primitives before enabling this path.

### `MessagePortTransport`

Communicates over a `MessagePort` (Web Workers, iframes, Deno workers). Pass one
side of a `MessageChannel` to each transport instance.

### `MiddlewareTransport`

Wraps any `RpcTransport` with a stack of `RpcTransportMiddleware` interceptors.
Interceptors can inspect, transform, or drop frames in both directions. Ships
with built-in factories: `createLoggingMiddleware`,
`createFrameSizeLimitMiddleware`, `createRpcMetricsMiddleware`,
`createRpcIntrospectionMiddleware`.

### `RpcSession`

Binds a WASM peer to a transport. Receives inbound frames, processes them
through the peer, and sends outbound responses. One session per connection.

### `SessionRpcClientTransport`

Client-side RPC API. Provides `bootstrap()`, `call()`, `callRaw()`, and
`callRawPipelined()`. Drives an `RpcSession` through an
`RpcSessionHarnessTransport`. It also supports `exportCapability(...)` for
generated clients that pass local callback implementations as interface
parameters; callback frames are dispatched through a local bridge while the
client waits for the original result. Generated `-> stream` sender helpers can
also use this transport; they are application-level RPC call flow control, not
transport byte streams.

### `InMemoryRpcHarnessTransport`

In-memory `RpcSessionHarnessTransport` for testing. Queues outbound frames and
lets you inject inbound frames with `emitInbound()`. **Not for production
networking.**

### `NetworkRpcHarnessTransport`

Adapts a real `RpcTransport` (TCP, WebSocket, etc.) to the
`RpcSessionHarnessTransport` interface required by `SessionRpcClientTransport`.
Use this when connecting to a remote server from client code.

### `RpcWireClient`

Raw RPC client adapter that sends Bootstrap/Call/Finish/Release wire frames
directly over a started transport. Use this when you want generated stubs over
TCP, WebSocket, or WebTransport without running a local client-side WASM peer.
It also supports `exportCapability(...)`, so generated clients can pass local
callback implementations over real network transports. Generated `-> stream`
sender helpers work over this adapter as ordinary RPC calls with bounded
in-flight windows.

### `RpcServerRuntime`

Server-side runtime that combines `RpcSession` + `RpcServerBridge` + automatic
host-call pumping. One runtime per accepted connection.

## Stack Diagrams

### In-Memory Testing (client + server in same process)

```
 SessionRpcClientTransport
      |             |
 RpcSession    reads outbound frames
      |
InMemoryRpcHarnessTransport  <-- shared between client and runtime
      |
 RpcServerRuntime
      |
 RpcServerBridge
```

```ts
const transport = new InMemoryRpcHarnessTransport();
const bridge = new RpcServerBridge();

const runtime = await RpcServerRuntime.create(transport, bridge, {
  autoStart: true,
});

const client = new SessionRpcClientTransport(
  runtime.session,
  transport,
  { interfaceId: MyInterfaceId, autoStart: false },
);

const cap = await client.bootstrap();
```

### TCP Client Connecting to Remote Server

```
SessionRpcClientTransport
     |             |
RpcSession    reads outbound frames
     |
NetworkRpcHarnessTransport
     |
TcpTransport  ----> TCP connection ----> remote server
```

```ts
const tcp = await TcpTransport.connect("localhost", 4000);
const adapter = new NetworkRpcHarnessTransport(tcp);
const client = await SessionRpcClientTransport.create(adapter, {
  interfaceId: MyInterfaceId,
  startSession: true,
});

const cap = await client.bootstrap();
```

### TCP Server Accepting Connections

```
TcpTransport.listen()
     |
     | accept() yields TcpTransport per connection
     v
RpcServerRuntime  (one per connection)
     |
RpcSession
     |
TcpTransport
```

```ts
const listener = TcpTransport.listen({ port: 4000 });

for await (const tcpTransport of listener.accept()) {
  const bridge = new RpcServerBridge();
  // Register capabilities on bridge...

  const runtime = await RpcServerRuntime.create(tcpTransport, bridge, {
    autoStart: true,
  });
  // runtime is now serving this connection
}
```

### WebSocket Client / Server

**Client:**

```
SessionRpcClientTransport
     |
NetworkRpcHarnessTransport
     |
WebSocketTransport  ----> ws://server/rpc
```

```ts
const ws = await WebSocketTransport.connect("ws://localhost:8080/rpc");
const adapter = new NetworkRpcHarnessTransport(ws);
const client = await SessionRpcClientTransport.create(adapter, {
  interfaceId: MyInterfaceId,
  startSession: true,
});
```

**Server** (inside your HTTP handler):

```ts
// `socket` is a WebSocket from your HTTP framework
const transport = new WebSocketTransport(socket);
const bridge = new RpcServerBridge();
// Register capabilities...

const runtime = await RpcServerRuntime.create(transport, bridge, {
  autoStart: true,
});
```

### High-Level WebSocket Service API

If you are using generated `RpcServiceToken` values, prefer the generic
`connect(...)` / `serve(...)` helpers with transport-owned WebSocket server
primitives:

```ts
using client = await connect(
  Pinger,
  await WebSocketTransport.connect("ws://127.0.0.1:8080/rpc", ["capnp-rpc"]),
);

const listener = WebSocketTransport.listen({
  hostname: "127.0.0.1",
  port: 8080,
  path: "/rpc",
  protocols: ["capnp-rpc"],
});
using server = serve(
  Pinger,
  listener,
  ({ peer }) => new PingServer(peer),
);
```

For custom HTTP routers, use `WebSocketTransport.handler(...)` as the upgrade
surface and bind it once with `serve(...)`:

```ts
const wsHandler = WebSocketTransport.handler({
  path: "/rpc",
  protocols: ["capnp-rpc"],
});
using rpc = serve(
  Pinger,
  wsHandler,
  ({ peer }) => new PingServer(peer),
);

const httpServer = Deno.serve({ hostname: "127.0.0.1", port: 8080 }, (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/rpc") return wsHandler.handle(req);
  if (url.pathname === "/api") return new Response("capnweb route");
  return new Response("not found", { status: 404 });
});
```

#### Browser <-> Deno WebSocket Contract

`WebSocketTransport.listen(...)` and `WebSocketTransport.handler(...)` define
the same server-side contract for browser and Deno clients:

1. Handshake requirements:
   - Non-upgrade HTTP requests receive `426`.
   - If `path` is configured and does not match, the request receives `404`.
   - If `protocols` is configured and no requested protocol matches, the upgrade
     is rejected with `426`.
2. Runtime wiring:
   - Each accepted socket is upgraded via `Deno.upgradeWebSocket(...)`.
   - The upgraded socket is wrapped in `WebSocketTransport` and yielded through
     the accept source.
   - `serve(...)` creates a per-connection
     `RpcServerRuntime.createWithRoot(...)`.
3. Bootstrap wiring:
   - `serve(...)` registers a root capability for bootstrap automatically
     (default index `0`, reference count `1`).
   - Override with `rootCapabilityIndex` / `rootReferenceCount` if needed.
   - If you wire WebSocket manually without `serve(...)`, use
     `serveConnection(...)` or `RpcServerRuntime.createWithRoot(...)` so
     bootstrap requests do not fail.
4. Frame-limit policy:
   - Apply WebSocket frame validation using `transport.frameLimits`.
   - Use `transport.maxInboundFrameBytes` / `transport.maxOutboundFrameBytes`
     for per-frame byte limits.
5. Error and close behavior:
   - Initialization/accept errors (upgrade failure, runtime setup failure) are
     reported via `onConnectionError`.
   - Per-connection transport errors are reported via `transport.onError`.
   - Closing the `serve(...)` handle stops accepting new upgrades and closes
     active runtimes.
   - `await handle.drain({ forceAfterMs })` stops accepting new upgrades, waits
     for active runtimes to close naturally, and force-closes the remaining
     runtimes after the grace window.
   - Use `serve(..., { maxActiveConnections })` to cap active runtimes at the
     listener. Surplus accepted transports are closed immediately, reported via
     `onConnectionError`, and reflected in `handle.stats.refusedConnections`.
   - Use `serve(..., { connectionInitTimeoutMs })` to bound per-connection
     service factory and runtime initialization. Timeouts close the accepted
     transport, report through `onConnectionError`, and increment
     `handle.stats.failedConnections`.
6. Fallback order and reconnect layering:
   - Browser clients should prefer `connect(...)` over
     `WebSocketTransport.connect(...)` when they want typed service stubs.
   - For transport-level retry (connect/open failures), layer
     `connectWebSocketTransportWithReconnect(...)` under your client factory.
   - For RPC-level retry/remap across reconnects, wrap the client with
     `ReconnectingRpcClientTransport`.
7. Capability-scope caveats:
   - Capability IDs are connection-scoped and are not stable across reconnects.
   - `finish(questionId)` and `release(capability)` are connection-scoped and
     are not retried automatically after reconnect.
   - Non-bootstrap capability retries require `remapCapabilityOnReconnect`.

### High-Level WebTransport Service API

If you are using generated `RpcServiceToken` values, prefer `connect(...)` with
`WebTransportTransport.connect(...)` and `serve(...)` with
`WebTransportTransport.listen(...)`:

```ts
const support = getWebTransportRuntimeSupport();
if (!support.client) {
  throw new Error(`WebTransport unavailable: ${support.missing.join(", ")}`);
}

const listener = WebTransportTransport.listen({
  hostname: "127.0.0.1",
  port: 4443,
  path: "/p2p",
  cert: certPem,
  key: keyPem,
});
using server = serve(
  Presence,
  listener,
  ({ peer }) => new PresenceServer(peer),
);

using client = await connect(
  Presence,
  await WebTransportTransport.connect("https://127.0.0.1:4443/p2p", {
    webTransport: createWebTransportCertificateHashOptions(certHashBytes),
  }),
);
```

WebTransport specifics:

1. `WebTransportTransport.listen(...)` requires Deno's unstable QUIC APIs
   (`--unstable-net`) plus a TLS certificate and private key.
2. `connect(...)` over `WebTransportTransport.connect(...)` opens a single
   bidirectional stream for Cap'n Proto RPC traffic. Client URLs must use
   `https:`; `http:` is rejected before the session constructor is called.
3. `serve(...)` over `WebTransportTransport.listen(...)` upgrades each accepted
   QUIC connection with `Deno.upgradeWebTransport(...)`, waits for the first
   bidirectional stream, and boots a per-connection
   `RpcServerRuntime.createWithRoot(...)`.
4. For local development, prefer certificate-hash pinning via
   `createWebTransportCertificateHashOptions(hash)`. The helper accepts 32-byte
   `Uint8Array` / `ArrayBuffer` values or a 64-character SHA-256 hex string.
5. Listener paths are normalized so `"p2p"` and `"/p2p"` match the same client
   URL path. Path mismatch, upgrade failure, first-stream timeout, and abnormal
   close are reported through `TransportError`, `onConnectionError`, and
   observability.
6. For retry-on-connect behavior, layer
   `connectWebTransportTransportWithReconnect(...)` under your client factory.
7. Browser WebTransport coverage is opt-in:
   `mise run test:browser-webtransport`. Mise installs Chromium first, then runs
   `deno task test:browser-webtransport` with `CAPNP_DENO_BROWSER_E2E=1`.

### MessagePort (Workers / Iframes)

```
Worker A                          Worker B
--------                          --------
SessionRpcClientTransport         RpcServerRuntime
     |                                 |
NetworkRpcHarnessTransport        MessagePortTransport
     |                                 |
MessagePortTransport              port2
     |
port1
     \____________ MessageChannel ____________/
```

```ts
const channel = new MessageChannel();

// Worker A (client side)
const clientTransport = new MessagePortTransport(channel.port1);
const adapter = new NetworkRpcHarnessTransport(clientTransport);
const client = await SessionRpcClientTransport.create(adapter, {
  interfaceId: MyInterfaceId,
  startSession: true,
});

// Worker B (server side)
const serverTransport = new MessagePortTransport(channel.port2);
const runtime = await RpcServerRuntime.create(serverTransport, bridge, {
  autoStart: true,
});
```

For generated high-level clients, bind one side as a single accepted server
connection and connect the other side normally:

```ts
const channel = new MessageChannel();

const serverTransport = new MessagePortTransport(channel.port1, {
  closePortOnClose: true,
});
using server = await serveConnection(
  Pinger,
  {
    transport: serverTransport,
    localAddress: { transport: "messageport" },
    remoteAddress: { transport: "messageport" },
  },
  new PingServer(),
);

const clientTransport = new MessagePortTransport(channel.port2, {
  closePortOnClose: true,
});
using client = await connect(Pinger, clientTransport);
```

Generated callbacks and generated `-> stream` sender helpers work over this
shape the same way they do over TCP, WebSocket, and WebTransport.

## Generated RPC Transport Parity

| Transport         | Generated `connect()` | Generated `serve()` / `serveConnection()`              | Local callback exports             | Generated `-> stream` helpers | Notes                                                  |
| ----------------- | --------------------- | ------------------------------------------------------ | ---------------------------------- | ----------------------------- | ------------------------------------------------------ |
| TCP               | Yes                   | Yes, via `TcpTransport.listen()`                       | Yes                                | Yes                           | Primary server/client path.                            |
| WebSocket         | Yes                   | Yes, via `WebSocketTransport.listen()` or `.handler()` | Yes                                | Yes                           | Useful for browser/Deno RPC.                           |
| WebTransport      | Yes                   | Yes, via `WebTransportTransport.listen()`              | Yes                                | Yes                           | Requires `--unstable-net` and certificate trust setup. |
| MessagePort       | Yes                   | Yes, via `serveConnection()`                           | Yes                                | Yes                           | Use paired `MessagePortTransport` instances.           |
| In-memory harness | Advanced              | Advanced                                               | Yes, with host-call bridge support | Yes                           | Test/runtime harness, not a production transport.      |

## Decision Guide

| Scenario                     | Transport                                                                                  | Client wrapper                                              | Server wrapper                    |
| ---------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | --------------------------------- |
| Unit/integration tests       | `InMemoryRpcHarnessTransport`                                                              | `SessionRpcClientTransport` (direct)                        | `RpcServerRuntime`                |
| TCP client to remote server  | `TcpTransport.connect()`                                                                   | `NetworkRpcHarnessTransport`                                | --                                |
| TCP server accepting clients | `TcpTransport.listen()`                                                                    | --                                                          | `RpcServerRuntime` (one per conn) |
| WebSocket client             | `connect(service, await WebSocketTransport.connect())`                                     | `SessionRpcClientTransport` or `NetworkRpcHarnessTransport` | --                                |
| WebSocket server             | `serve(service, WebSocketTransport.listen()/handler(), impl)`                              | --                                                          | `RpcServerRuntime`                |
| WebTransport client          | `connect(service, await WebTransportTransport.connect())`                                  | `RpcWireClient` or `NetworkRpcHarnessTransport`             | --                                |
| WebTransport server          | `serve(service, WebTransportTransport.listen(), impl)` or `WebTransportTransport.accept()` | --                                                          | `RpcServerRuntime`                |
| Worker / iframe IPC          | `MessagePortTransport`                                                                     | `NetworkRpcHarnessTransport`                                | `RpcServerRuntime`                |

## Middleware

`MiddlewareTransport` wraps any `RpcTransport` and can be inserted anywhere a
transport is accepted. Apply it **before** passing the transport to `RpcSession`
or `RpcServerRuntime`.

```ts
const tcp = await TcpTransport.connect("localhost", 4000);
const metrics = createRpcMetricsMiddleware();

const transport = new MiddlewareTransport(tcp, [
  createLoggingMiddleware({ prefix: "[client]" }),
  createFrameSizeLimitMiddleware(1024 * 1024),
  metrics.middleware,
]);

// Use `transport` where you would normally use `tcp`
const adapter = new NetworkRpcHarnessTransport(transport);
const client = await SessionRpcClientTransport.create(adapter, {
  interfaceId: MyInterfaceId,
  startSession: true,
});
```

On the server side:

```ts
for await (const tcp of listener.accept()) {
  const wrapped = new MiddlewareTransport(tcp, [
    createLoggingMiddleware({ prefix: "[server]" }),
  ]);
  const runtime = await RpcServerRuntime.create(wrapped, bridge, {
    autoStart: true,
  });
}
```

Middleware executes in array order for both `onSend` and `onReceive`. If any
middleware returns `null`, the frame is dropped and subsequent middleware is not
called.

## Common Mistakes

**Using `InMemoryRpcHarnessTransport` for real networking.** It has no network
I/O. Use `TcpTransport`, `WebSocketTransport`, `WebTransportTransport`, or
`MessagePortTransport` for anything that crosses a process boundary.

**Using `NetworkRpcHarnessTransport` on the server side.**
`NetworkRpcHarnessTransport` is a client-side adapter. On the server, pass the
real transport directly to `RpcServerRuntime`.

**Sharing one `RpcSession` across multiple connections.** Each connection needs
its own session. `RpcSession` binds 1:1 with a peer and a transport.

**Processing inbound frames concurrently.** The session serializes frame
processing internally via a promise chain. Do not call `pumpInboundFrame` from
multiple concurrent contexts.

**Forgetting to call `start()`.** `RpcSession`, `RpcServerRuntime`, and all
transports require an explicit `start()` call (or `autoStart: true` in factory
methods) before frames flow.

**Placing `MiddlewareTransport` after the session.** Middleware wraps the raw
transport, not the session. The session takes a transport as input; wrap the
transport before passing it to the session.
