# Deno/TypeScript Cap'n Proto: Arena Gap Analysis

Date: 2026-02-08
Codebase: `/ref/capnp-deno/` at commit `bb7a94f`

## 1. Executive Summary

### What works today

The `capnp-deno` library has solid foundations for a Cap'n Proto RPC
implementation:

- **Codegen**: `capnpc-deno` parses `CodeGeneratorRequest` and emits three files
  per schema (`_capnp.ts` for binary codecs, `_rpc.ts` for client/server stubs,
  `_meta.ts` for reflection metadata). Struct types with primitives, enums,
  text, data, lists, nested structs, unions/groups, interface pointers, and
  AnyPointer fields are supported.
- **Wire format**: Complete encode/decode for Bootstrap, Call, Return (results +
  exception), Finish, and Release RPC messages. Cap tables are encoded/decoded in
  both call params and return payloads.
- **Client transport**: `SessionRpcClientTransport` provides bootstrap, call,
  callRaw, callRawPipelined, finish, and release. Middleware, timeouts, and abort
  signals are supported.
- **Promise pipelining**: Level 2 RPC. `RpcPipeline` builds promisedAnswer
  targets with getPointerField transforms. Client sends pipelined calls on the
  wire. Server resolves pipelined calls through the answer table.
- **Server bridge**: `RpcServerBridge` dispatches calls to registered
  `RpcServerDispatch` handlers, manages cap table lifecycle (export, retain,
  release), answer table for pipelining, and eviction.
- **Server runtime**: `RpcServerRuntime` combines session + bridge + WASM peer
  with automatic host-call pumping after each inbound frame.
- **Transports**: TCP (with framing), WebSocket, and MessagePort transports with
  backpressure, queue limits, and timeouts.
- **Resilience**: Reconnect policies, reconnecting client transport, connection
  pool, circuit breaker.
- **Test coverage**: 91.7% branch / 95.5% line across the whole project. 115+
  tests passing.

### What does not work / is missing

Several capabilities required by the Arena benchmark are missing or incomplete:

1. **No TCP server listener** -- Only `TcpTransport.connect()` exists (client
   side). There is no `Deno.listen()`-based server accept loop. An Arena
   contestant must accept inbound TCP connections.
2. **Generated server stubs return raw bytes, not structured responses with cap
   tables** -- The generated `createXxxServer()` dispatch adapter always returns
   plain `Uint8Array`. When a server method needs to return capabilities (e.g.,
   `getChain` returning a `ChainLink`, `getFanout` returning `List(Worker)`),
   the generated code has no mechanism to build `RpcCallResponse` objects with
   `capTable` entries. The user must manually construct cap table entries and
   return `RpcCallResponse` from a raw `RpcServerDispatch`, bypassing the
   generated typed stubs entirely.
3. **No generated client-side capability resolution from cap tables** -- The
   generated `createXxxClient` returns decoded structs, but has no way to
   resolve capability fields in the result (e.g., resolving a `ChainLink` cap
   pointer to a callable client stub). The `callRaw` API exposes the cap table,
   but there is no glue to automatically create typed client stubs from returned
   capabilities.
4. **`List(Interface)` codegen is incomplete** -- The type model supports
   `{ kind: "list", elementType: { kind: "interface", typeId: ... } }`, and
   `typeToTs` maps this to `(CapabilityPointer | null)[]`. However, the binary
   codec for lists of interface pointers (cap table index lists) is not verified
   to work end-to-end. The Arena's `getFanout` returns `List(Worker)` which
   requires encoding/decoding a list of capability pointers.
5. **Passing capabilities as call parameters is manual** -- The `collaborate`
   scenario requires passing a `Collaborator` capability as a parameter. The
   `paramsCapTable` option exists on `callRaw`, but the generated client code
   does not automatically populate it from typed params with capability fields.
6. **No streaming support** -- Cap'n Proto streaming (`-> stream` annotation) is
   not implemented. The Arena `stream` scenario requires it.
7. **No bidirectional bootstrap** -- The current model is strictly client
   bootstraps from server. The `collaborate` scenario requires the server to call
   back into a client-provided capability, which works at the wire level through
   cap table passing but has no higher-level API support.
8. **`SessionRpcClientTransport` requires `RpcSessionHarnessTransport`** -- The
   high-level client transport cannot be used directly with a plain
   `RpcTransport` (e.g., a real TCP connection). It requires the
   `InMemoryRpcHarnessTransport` or equivalent harness with `emitInbound` and
   `nextOutboundFrame`. This means the client-side RPC path is only usable for
   testing, not for real network connections, unless the user builds their own
   harness adapter.

### Overall readiness

The library is approximately **40-50% ready** for a full Arena benchmark
contestant. The core wire format, session management, and server dispatch
infrastructure are solid. However, the generated code lacks the capability
plumbing needed for most Arena scenarios, and there is no server-side TCP
listener. The `ping` and `echo` scenarios could be made to work with moderate
effort. The `transfer` scenario is straightforward. The `getChain`, `getFanout`,
`collaborate`, and `stream` scenarios require significant additional work.


## 2. Scenario-by-Scenario Assessment

### 2.1 ping -- `Arena.ping() -> ()`

**Can it be implemented today?** Yes, with moderate effort.

**What works**: Codegen produces correct params/results types for void methods.
Server dispatch works. Wire encode/decode is complete.

**Gaps**:
- No TCP server listener (must write a `Deno.listen()` loop manually).
- `SessionRpcClientTransport` is harness-only; need to connect it to a real TCP
  transport or build an adapter.

**Effort to close gaps**: Moderate (write ~50-100 lines of glue code for TCP
listen and transport adapter).

---

### 2.2 echo -- `Arena.echo(payload :Data) -> (payload :Data)`

**Can it be implemented today?** Yes, with moderate effort.

**What works**: `Data` type maps to `Uint8Array` in both codegen types and
binary codecs. The `TYPE_DATA` descriptor handles encoding/decoding byte lists.

**Gaps**: Same as `ping` (TCP listener, transport adapter). Plus: need to verify
that `Data` field encode/decode round-trips correctly through the full RPC path
(params encoded by client codec -> wire -> server codec decode -> server codec
encode -> wire -> client codec decode). The binary codec for `Data` fields uses
the byte-list pointer format which appears correct but has limited end-to-end RPC
testing.

**Effort to close gaps**: Moderate.

---

### 2.3 getChain -- `Arena.getChain() -> (link :ChainLink)`

**Can it be implemented today?** No, not through generated stubs.

**What works**: Wire-level cap table encoding/decoding works. The server bridge
can return `RpcCallResponse` with `capTable` entries. Promise pipelining through
the answer table works (needed for `ChainLink.next()` which returns another
`ChainLink`).

**Gaps**:
- Generated server stubs do not support returning capabilities. The
  `createXxxServer` wrapper calls `dispatch` and returns raw bytes. There is no
  codegen path to encode a cap table entry for an interface field in the result.
  The user must bypass generated stubs and implement `RpcServerDispatch`
  directly.
- Generated client stubs do not resolve capabilities from the result cap table.
  The user must use `callRaw` and manually create client stubs from cap table
  entries.
- Chaining requires creating new `ChainLink` capabilities dynamically for each
  `next()` call and registering them with `bridge.exportCapability()`.

**Effort to close gaps**: Significant. Codegen changes needed for
capability-returning methods, or manual implementation bypassing generated stubs.

---

### 2.4 getFanout -- `Arena.getFanout(width :UInt32) -> (workers :List(Worker))`

**Can it be implemented today?** No.

**What works**: The type model recognizes `List(Interface)`. The TypeScript type
is generated as `(CapabilityPointer | null)[]`.

**Gaps**:
- All gaps from `getChain` apply (no generated cap table return support).
- Additionally, `List(Interface)` in the result requires encoding a list of
  capability pointers in the result struct AND populating corresponding cap table
  entries. The binary codec for lists of interface pointers needs the cap table
  to be wired through the encode path, which the current `StructCodec.encode`
  does not support (it returns `Uint8Array` with no cap table side channel).
- Dynamically creating N `Worker` capabilities and exporting them all requires
  careful cap index management.

**Effort to close gaps**: Major. Requires codec changes to support cap table
pass-through in encode/decode, plus all the capability return gaps.

---

### 2.5 transfer -- `Arena.transfer(size :UInt64) -> (payload :Data)`

**Can it be implemented today?** Yes, with moderate effort.

**What works**: `UInt64` maps to `bigint`. `Data` maps to `Uint8Array`. Both are
supported in codegen and binary codecs.

**Gaps**: Same infrastructure gaps as `ping`/`echo` (TCP listener, transport
adapter). The server needs to allocate and return a `Data` blob of the requested
size.

**Effort to close gaps**: Moderate (same as echo).

---

### 2.6 collaborate -- `Arena.collaborate(peer :Collaborator) -> (result :Data)`

**Can it be implemented today?** No.

**What works**: The wire format supports passing capabilities as call parameters
via `paramsCapTable`. The server bridge passes `paramsCapTable` through
`RpcCallContext`.

**Gaps**:
- Receiving a capability parameter on the server side requires interpreting the
  `paramsCapTable` to identify the imported `Collaborator` capability, then
  making calls back to it. But the server has no built-in mechanism to make
  outbound calls to imported capabilities. The server bridge dispatches inbound
  calls but does not provide a client-side call path for the server to call back
  into client-exported capabilities.
- Generated client stubs do not automatically encode capability parameters into
  the cap table. The user must use `callRaw` with manual `paramsCapTable`
  construction.
- The server needs to act as both a capability host (receiving the collaborate
  call) and a capability client (calling `Collaborator.offer`). This
  bidirectional RPC pattern requires a two-party vat setup or equivalent, which
  does not exist in `capnp-deno`.

**Effort to close gaps**: Major. Requires building a bidirectional RPC facility
where the server can make outbound calls on imported capabilities.

---

### 2.7 stream -- `Arena.stream(count :UInt32, size :UInt32) -> (received :UInt32)`

**Can it be implemented today?** No.

**What works**: Nothing specific to streaming.

**Gaps**:
- Cap'n Proto streaming (the `-> stream` annotation) is explicitly listed as
  missing in the project status. There is no streaming message type in the wire
  format module (no `RPC_MESSAGE_TAG_STREAM` or similar).
- The Arena schema does not actually use `-> stream` annotation; the `stream`
  method returns a normal result. However, the benchmark intent is to test
  streaming data transfer, which likely requires the server to stream data back
  via repeated calls or a custom protocol. If it uses standard Cap'n Proto
  streaming, that is not implemented.
- If `stream` is just a normal method that the client calls once and gets back
  `received :UInt32`, it would work like `transfer` (moderate effort). The
  actual streaming behavior depends on the Arena harness protocol.

**Effort to close gaps**: Moderate if it is a normal RPC call; Major if it
requires Cap'n Proto streaming support.


## 3. Detailed Gap List

### GAP-01: No TCP Server Listener

**Severity**: Blocking
**Location**: `src/transports/tcp.ts`
**Difficulty**: Moderate
**Blocks**: ALL scenarios (ping, echo, getChain, getFanout, transfer,
collaborate, stream)

**Description**: `TcpTransport` only has `connect()` (client-side). There is no
server-side TCP listener that calls `Deno.listen()`, accepts connections, and
wraps each `Deno.Conn` in a `TcpTransport`. An Arena contestant must accept
incoming connections.

**What needs to happen**: Add a `TcpTransport.listen()` or separate
`TcpServerListener` class that:
1. Calls `Deno.listen({ port, hostname })`
2. Accepts connections in a loop
3. Wraps each accepted `Deno.Conn` in a `TcpTransport`
4. Hands each transport to an `RpcServerRuntime`

---

### GAP-02: SessionRpcClientTransport Only Works with Harness Transport

**Severity**: Blocking
**Location**: `src/rpc_client.ts`
**Difficulty**: Significant
**Blocks**: ALL client-side scenarios

**Description**: `SessionRpcClientTransport` requires an
`RpcSessionHarnessTransport` (which has `emitInbound` and `nextOutboundFrame`).
The only implementation is `InMemoryRpcHarnessTransport`, designed for testing.
A real TCP or WebSocket transport implements `RpcTransport` (start/send/close)
but not `RpcSessionHarnessTransport`.

The architecture routes frames: Transport -> Session -> WasmPeer -> Transport.
But the client transport wants to inject frames into the session (emitInbound)
and read outbound frames (nextOutboundFrame), which requires intercepting the
session's frame flow. With a real transport, the session's outbound frames go
directly to the network, not to a queue the client can read from.

**What needs to happen**: Either:
- Build an adapter that splits a real transport into the harness interface, or
- Redesign the client transport to work directly with `RpcSession` + real
  transport, registering response handlers that get called when the session
  processes return frames from the WASM peer.

---

### GAP-03: Generated Server Stubs Cannot Return Capabilities

**Severity**: Blocking for capability scenarios
**Location**: `tools/capnpc-deno/emitter_rpc.ts` (lines 221-259)
**Difficulty**: Significant
**Blocks**: getChain, getFanout, collaborate

**Description**: The generated `createXxxServer()` dispatch adapter always
returns `Uint8Array` from the server handler:

```ts
const result = await server[methodName](decoded, ctx);
return ResultsCodec.encode(result);
```

This encode path produces raw bytes with no cap table. When a result struct
contains interface pointer fields (like `link :ChainLink` or
`workers :List(Worker)`), those fields encode as capability indices that
reference cap table entries. But the codec has no way to produce or attach cap
table entries.

The underlying `RpcServerDispatch.dispatch()` interface supports returning
`RpcCallResponse` (with `capTable`), but the generated wrapper throws away this
capability by always encoding to `Uint8Array`.

**What needs to happen**:
1. Modify the generated server dispatch to detect when result types contain
   interface fields.
2. For such methods, generate code that builds `RpcCallResponse` objects with
   both encoded content and cap table entries.
3. The server handler signature needs to change to allow returning capabilities
   (e.g., returning `{ link: someCapPointer }` where the codegen knows to
   extract the cap pointer and add it to the cap table).

---

### GAP-04: Generated Client Stubs Cannot Resolve Returned Capabilities

**Severity**: Blocking for capability scenarios
**Location**: `tools/capnpc-deno/emitter_rpc.ts` (lines 172-218)
**Difficulty**: Significant
**Blocks**: getChain, getFanout

**Description**: The generated `createXxxClient()` methods call
`transport.call()` which returns raw bytes, then decode them:

```ts
const response = await transport.call(capability, ordinal, payload, options);
return ResultsCodec.decode(response);
```

The decoded result has `CapabilityPointer | null` for interface fields, but the
actual capability index is meaningless without the cap table from the response.
And even with the cap table, there is no code to create a typed client stub
(e.g., `createChainLinkClient`) from the returned capability.

**What needs to happen**:
1. For methods returning capabilities, the generated client should use `callRaw`
   instead of `call` to access the cap table.
2. Extract capability indices from the decoded struct's interface fields.
3. Map them through the response cap table to get the imported capability index.
4. Create typed client stubs using the corresponding `createXxxClient` factory.

---

### GAP-05: StructCodec Has No Cap Table Channel

**Severity**: Significant
**Location**: `tools/capnpc-deno/emitter_types.ts`,
`tools/capnpc-deno/emitter_preamble.ts`
**Difficulty**: Significant
**Blocks**: getChain, getFanout, collaborate

**Description**: `StructCodec<T>` has the signature:
```ts
encode(value: T): Uint8Array;
decode(bytes: Uint8Array): T;
```

There is no way to pass a cap table in or get one out. When encoding a struct
with interface pointer fields, the codec writes capability indices into the
struct's pointer section, but these indices need to be correlated with cap table
entries in the enclosing RPC message. Similarly, when decoding, capability
indices in the struct need to be resolved against the message's cap table.

**What needs to happen**: Either:
- Extend `StructCodec` to accept/return a cap table side-channel, or
- Add a separate `StructCodecWithCaps` variant for types with capability fields,
  or
- Handle cap table correlation in the generated RPC stubs rather than in the
  codec.

---

### GAP-06: No Server-Side Outbound Call Facility

**Severity**: Blocking for collaborate
**Location**: `src/rpc_server.ts`, `src/rpc_client.ts`
**Difficulty**: Major
**Blocks**: collaborate

**Description**: The server bridge (`RpcServerBridge`) only handles inbound
calls. It has no facility for the server to make outbound calls on capabilities
it has received as parameters (imported capabilities). The `collaborate` scenario
requires the server to call `Collaborator.offer()` on a capability passed in by
the client.

In full Cap'n Proto RPC, both sides of a connection can be both a client and a
server simultaneously (the "vat" model). The `capnp-deno` architecture separates
client and server into different runtime paths with no shared session.

**What needs to happen**: Implement a bidirectional RPC facility:
1. The server session needs to be able to send Call messages (not just Return).
2. The server needs a client-like API to call methods on imported capabilities.
3. The WASM peer likely already handles this bidirectionally, but the Deno host
   code does not expose this path.

This is architecturally the most significant gap.

---

### GAP-07: No Cap'n Proto Streaming Support

**Severity**: Blocking for stream (if streaming is required)
**Location**: `src/rpc_wire/`, `src/rpc_client.ts`, `src/rpc_server.ts`
**Difficulty**: Major
**Blocks**: stream

**Description**: The `-> stream` Cap'n Proto annotation and the corresponding
streaming call protocol are not implemented. No streaming message types exist in
the wire format. No streaming API exists on client or server.

Note: If the Arena `stream` scenario is just a normal RPC call (client calls
`stream()`, server processes and returns `received`), this gap does not apply.
The gap only matters if the protocol requires actual Cap'n Proto streaming.

**What needs to happen**: Implement streaming message types, flow control, and
client/server APIs for streamed calls.

---

### GAP-08: Generated Client Stubs Cannot Pass Capability Parameters

**Severity**: Blocking for collaborate
**Location**: `tools/capnpc-deno/emitter_rpc.ts` (lines 186-192)
**Difficulty**: Moderate
**Blocks**: collaborate

**Description**: The generated client method encodes params via:
```ts
const payload = ParamsCodec.encode(params);
```

This produces raw bytes. If the params struct has interface fields (e.g.,
`peer :Collaborator`), the codec writes a capability index into the pointer
section, but there is no mechanism to populate the corresponding
`paramsCapTable` on the outbound call. The `callRaw` API supports
`paramsCapTable`, but the generated code uses the simplified `call` path.

**What needs to happen**: For methods with capability parameters, generate code
that:
1. Extracts capability pointers from the typed params.
2. Builds a `paramsCapTable` array.
3. Uses `callRaw` with the cap table instead of `call`.

---

### GAP-09: No Resolve/Disembargo Messages

**Severity**: Moderate
**Location**: `src/rpc_wire/`
**Difficulty**: Significant
**Blocks**: Potentially getChain, collaborate (for full correctness)

**Description**: The wire format only handles Bootstrap, Call, Return, Finish,
and Release messages. Cap'n Proto Level 3 RPC requires Resolve and Disembargo
messages for correct capability lifecycle when promises resolve to different
capabilities. The WASM peer may handle these internally, but the Deno host code
does not decode or route them.

For simple Arena scenarios where pipelining is single-hop, this may not matter.
But for deep chains (`ChainLink.next().next().next()...`) or complex capability
passing, missing Resolve/Disembargo could cause correctness issues.

---

### GAP-10: No Cross-Language Interop Testing

**Severity**: Moderate
**Location**: Test suite
**Difficulty**: Moderate
**Blocks**: Arena validation confidence

**Description**: All tests use `FakeCapnpWasm` or in-memory transports. There
are no tests connecting to a real Cap'n Proto RPC peer (e.g., a C++ or Rust
implementation). The real WASM tests (`real_wasm_*_test.ts`) test serde and basic
RPC flow against the compiled `capnp_deno.wasm`, but not against a remote peer
over TCP.

**What needs to happen**: Add integration tests that connect to a reference
Cap'n Proto RPC server (or run a Deno server and connect from a reference
client) to validate wire compatibility.

---

### GAP-11: `interfaceId` Scoping in Client Transport

**Severity**: Moderate
**Location**: `src/rpc_client.ts` (line 509)
**Difficulty**: Moderate
**Blocks**: getChain, getFanout (multiple interface types on one connection)

**Description**: `SessionRpcClientTransport` is constructed with a single
`interfaceId` that is used for ALL calls made through that transport. This means
you cannot call methods on two different interfaces through the same transport
instance. The Arena requires calling `Arena.getChain()` (Arena interface) and
then `ChainLink.next()` (ChainLink interface) on the same connection.

The `callRaw` API sends whatever `interfaceId` was set at construction time.
To call a different interface, you need a separate
`SessionRpcClientTransport` instance, but that would use a separate question ID
space and potentially a separate session.

**What needs to happen**: Either:
- Allow `interfaceId` to be overridden per-call, or
- Generate client stubs that inject the correct `interfaceId` into each call.

---

### GAP-12: No Automatic `encodeStructMessage` / `decodeStructMessage` in Generated Runtime

**Severity**: Low (infrastructure is present)
**Location**: `tools/capnpc-deno/emitter_preamble.ts`
**Difficulty**: Trivial

**Description**: The runtime preamble (embedded in generated `_capnp.ts` files)
includes `encodeStructMessage` and `decodeStructMessage` functions. These appear
to work for non-capability types. However, they are duplicated into each
generated file rather than imported from a shared runtime module. This means bug
fixes need to be applied to the codegen template.

This is a code quality issue, not a blocking functional gap.


## 4. Recommended Priority Order for Fixes

### Priority 1: Infrastructure (unblocks ALL scenarios)

1. **GAP-01: TCP Server Listener** -- Write a `Deno.listen()` wrapper. ~50 lines
   of code. Unblocks all server-side scenarios.
   *Difficulty: Moderate. Time estimate: 2-4 hours.*

2. **GAP-02: Client Transport for Real Connections** -- Build an adapter or
   redesign so `SessionRpcClientTransport` works with real TCP transports, not
   just the in-memory harness.
   *Difficulty: Significant. Time estimate: 1-2 days.*

3. **GAP-11: Per-Call interfaceId** -- Allow the client transport to override
   `interfaceId` per call. Small change but blocks multi-interface usage.
   *Difficulty: Moderate. Time estimate: 2-4 hours.*

### Priority 2: Data-Only Scenarios (ping, echo, transfer)

With Priority 1 complete, the `ping`, `echo`, and `transfer` scenarios should
work with minimal additional changes (just verifying `Data` field codecs work
end-to-end over real RPC).

### Priority 3: Capability Return (unblocks getChain, getFanout)

4. **GAP-05: StructCodec Cap Table Channel** -- Add a cap table side-channel to
   the codec or handle it in generated stubs.
   *Difficulty: Significant. Time estimate: 2-3 days.*

5. **GAP-03: Server Stubs Return Capabilities** -- Modify codegen to generate
   server dispatch that can return `RpcCallResponse` with cap table entries.
   *Difficulty: Significant. Time estimate: 2-3 days.*

6. **GAP-04: Client Stubs Resolve Capabilities** -- Modify codegen to generate
   client code that resolves capabilities from response cap tables into typed
   client stubs.
   *Difficulty: Significant. Time estimate: 2-3 days.*

### Priority 4: Capability Parameters (unblocks collaborate)

7. **GAP-08: Client Capability Parameters** -- Generate cap table population for
   outbound calls with interface params.
   *Difficulty: Moderate. Time estimate: 1-2 days.*

8. **GAP-06: Server Outbound Calls** -- This is the hardest gap. The server
   needs to be able to call methods on imported capabilities. Requires
   bidirectional RPC.
   *Difficulty: Major. Time estimate: 1-2 weeks.*

### Priority 5: Streaming (unblocks stream)

9. **GAP-07: Streaming Support** -- If needed, implement Cap'n Proto streaming.
   *Difficulty: Major. Time estimate: 1-2 weeks.*

### Priority 6: Correctness and Polish

10. **GAP-09: Resolve/Disembargo** -- Needed for full Level 3 correctness.
    *Difficulty: Significant. Time estimate: 1 week.*

11. **GAP-10: Cross-Language Interop Tests** -- Essential for Arena confidence.
    *Difficulty: Moderate. Time estimate: 2-3 days.*

### Summary Timeline Estimate

| Milestone | Scenarios Unlocked | Estimated Effort |
|---|---|---|
| Infrastructure (P1) | None standalone, but required for all | 3-5 days |
| Data scenarios (P2) | ping, echo, transfer | 1-2 days |
| Capability return (P3) | getChain, getFanout | 1-2 weeks |
| Capability params (P4) | collaborate | 2-3 weeks |
| Streaming (P5) | stream | 1-2 weeks |
| **Total to full Arena** | **All 7 scenarios** | **6-10 weeks** |

### Fastest Path to Partial Arena Participation

To participate in the Arena with the least effort, focus on `ping`, `echo`, and
`transfer` (3 of 7 scenarios). This requires only Priority 1 (infrastructure)
and Priority 2 (data codecs), which could be completed in approximately 1 week.
The remaining 4 scenarios all require capability plumbing that is a much larger
investment.
