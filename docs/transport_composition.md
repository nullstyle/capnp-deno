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
`TcpTransport.connect(hostname, port)` factory for clients or accept connections
from `TcpServerListener` for servers.

### `TcpServerListener`

Binds a TCP port and yields a `TcpTransport` for each accepted connection via
`accept()`. Each yielded transport should be handed to its own
`RpcServerRuntime`.

### `WebSocketTransport`

Communicates over a standard `WebSocket` with `binaryType = "arraybuffer"`. Use
`WebSocketTransport.connect(url)` for clients. For servers, pass an already-open
`WebSocket` (from your HTTP framework) to the constructor.

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
`RpcSessionHarnessTransport`.

### `InMemoryRpcHarnessTransport`

In-memory `RpcSessionHarnessTransport` for testing. Queues outbound frames and
lets you inject inbound frames with `emitInbound()`. **Not for production
networking.**

### `NetworkRpcHarnessTransport`

Adapts a real `RpcTransport` (TCP, WebSocket, etc.) to the
`RpcSessionHarnessTransport` interface required by `SessionRpcClientTransport`.
Use this when connecting to a remote server from client code.

### `TcpRpcClientTransport`

Raw RPC client adapter that sends Bootstrap/Call/Finish/Release wire frames
directly over a started transport. Use this when you want generated stubs over
TCP without running a local client-side WASM peer.

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
TcpServerListener
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
const listener = new TcpServerListener({ port: 4000 });

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

## Decision Guide

| Scenario                     | Transport                            | Client wrapper                       | Server wrapper                    |
| ---------------------------- | ------------------------------------ | ------------------------------------ | --------------------------------- |
| Unit/integration tests       | `InMemoryRpcHarnessTransport`        | `SessionRpcClientTransport` (direct) | `RpcServerRuntime`                |
| TCP client to remote server  | `TcpTransport.connect()`             | `NetworkRpcHarnessTransport`         | --                                |
| TCP server accepting clients | `TcpServerListener` + `TcpTransport` | --                                   | `RpcServerRuntime` (one per conn) |
| WebSocket client             | `WebSocketTransport.connect()`       | `NetworkRpcHarnessTransport`         | --                                |
| WebSocket server             | `new WebSocketTransport(socket)`     | --                                   | `RpcServerRuntime`                |
| Worker / iframe IPC          | `MessagePortTransport`               | `NetworkRpcHarnessTransport`         | `RpcServerRuntime`                |

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
I/O. Use `TcpTransport`, `WebSocketTransport`, or `MessagePortTransport` for
anything that crosses a process boundary.

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
