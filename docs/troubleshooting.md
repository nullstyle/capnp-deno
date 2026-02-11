# Troubleshooting Guide

Updated: 2026-02-10

This guide maps common errors encountered while using capnp-deno to their likely
causes and fixes. Use the quick-reference table below to jump to the relevant
section, or read through by error category.

## Quick-Reference Table

| Error message pattern                                                                      | Category      | Likely cause                                                                                    | Fix                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `InvalidInlineCompositePointer`                                                            | ABI/WASM      | Mismatched schema version between client and server WASM modules                                | Rebuild both client and server WASM from the same schema; see [ABI/WASM Errors](#abiwasm-errors)                                       |
| `UnknownQuestion`                                                                          | ABI/WASM      | Sending a call to a question ID the peer does not recognize                                     | Ensure `finish` was not sent before pipelined calls complete; see [ABI/WASM Errors](#abiwasm-errors)                                   |
| `InvalidPointer`                                                                           | ABI/WASM      | Corrupted or incorrectly encoded Cap'n Proto message pushed to the WASM peer                    | Verify the frame bytes are a valid Cap'n Proto message; see [ABI/WASM Errors](#abiwasm-errors)                                         |
| `capnp_wasm_abi_version mismatch`                                                          | ABI/WASM      | WASM module ABI version does not match the runtime's expected version                           | Update either the WASM module or the `expectedVersion` option; see [Version Negotiation](#version-negotiation-errors)                  |
| `missing wasm export: ...`                                                                 | ABI/WASM      | WASM module is missing a required or expected export                                            | Rebuild the WASM module or check the runtime's capability requirements; see [Missing Exports](#missing-wasm-exports)                   |
| `unknown rpc message tag: N`                                                               | Protocol      | Frame contains an unrecognized RPC message type                                                 | Check that both peers speak the same protocol version; see [Protocol Errors](#protocol-errors)                                         |
| `rpc message root pointer is null`                                                         | Protocol      | Frame is too short or has a null root struct pointer                                            | Verify the frame is a properly framed Cap'n Proto message; see [Malformed Frames](#malformed-frames)                                   |
| `bootstrap not configured`                                                                 | Protocol      | Server has no `onBootstrap` handler in `RpcServerBridgeOptions`                                 | Provide `onBootstrap` when constructing `RpcServerBridge`; see [Bootstrap Failures](#bootstrap-failures)                               |
| `rpc bootstrap failed: ...`                                                                | Protocol      | Server returned an exception to a bootstrap request                                             | Check server logs for the exception reason; see [Bootstrap Failures](#bootstrap-failures)                                              |
| `unknown capability index: N`                                                              | Protocol      | Call targets a capability that was never exported or was already released                       | Export the capability before the client calls it; see [Capability Resolution](#capability-resolution-failures)                         |
| `interface mismatch for capability N`                                                      | Protocol      | Call's `interfaceId` does not match the registered dispatch                                     | Check that client and server use the same generated schema; see [Capability Resolution](#capability-resolution-failures)               |
| `TcpTransport is closed`                                                                   | Transport     | Attempting to use a transport after it was closed                                               | Check connection lifecycle; see [Transport Errors](#transport-errors)                                                                  |
| `capnp frame size ... exceeds configured limit`                                            | Transport     | Received frame is larger than `maxFrameBytes`                                                   | Increase `maxFrameBytes` or investigate oversized messages; see [Frame Size Limits](#frame-size-limits)                                |
| `RpcSession is closed`                                                                     | Session       | Operating on a session after `close()` was called                                               | Ensure session lifecycle ordering; see [Session Errors](#session-errors)                                                               |
| `rpc wait timed out after Nms`                                                             | Session       | No response received within the configured timeout                                              | Check server health and increase `timeoutMs` or `defaultTimeoutMs`; see [Timeout and Abort](#timeout-and-abort-errors)                 |
| `transport is closed` / `transport is not started`                                         | Session       | Client transport used before `start()` or after `close()`                                       | Call `start()` or set `autoStart: true`; see [Session Errors](#session-errors)                                                         |
| `host-call pump was explicitly enabled, but wasm host-call bridge exports are unavailable` | Runtime       | WASM module does not support the host-call bridge, but `hostCallPump.enabled` was set to `true` | Set `hostCallPump.enabled: false` or use a WASM module with host-call support; see [Server Runtime Warnings](#server-runtime-warnings) |
| `unsupported BufferSource`                                                                 | Instantiation | `instantiatePeer` received a value that is not a URL, string, Response, or BufferSource         | Pass a valid source; see [Instantiation Errors](#instantiation-errors)                                                                 |
| `failed to fetch wasm module: 404`                                                         | Instantiation | The URL for the WASM module returned an HTTP error                                              | Check the URL path and server availability; see [Instantiation Errors](#instantiation-errors)                                          |

---

## ABI/WASM Errors

These errors originate from the Zig-based WASM module (the Cap'n Proto RPC
engine compiled to WebAssembly). They surface as `WasmAbiError` (a subclass of
`AbiError`) with a numeric `code` and a descriptive message string.

The WASM module validates pointer structures, question/answer tables, and
capability tables internally. When validation fails, it sets an error that the
TypeScript ABI layer reads and throws.

### Common WASM Error Types

The `errorType` in the error's `metadata` field is extracted from the WASM error
message. Common types include:

#### `InvalidInlineCompositePointer`

**What it means:** The WASM peer encountered an inline composite list pointer
whose tag word is invalid -- typically because the struct data/pointer counts do
not match what the schema expects.

**Common causes:**

- The client and server were built from different versions of the `.capnp`
  schema file. A schema change (adding/removing fields) changes the struct
  layout in the serialized message, but the WASM module expects the old layout.
- The params content bytes passed to a `call` or `callRaw` invocation were not
  produced by the correct generated encoder.
- A capability-passing call (`startSession(client :Client)`) was assembled
  manually with incorrect struct layout.

**How to fix:**

1. Rebuild both the client and server WASM modules from the same `.capnp`
   schema: `just build-wasm`.
2. Re-run code generation: `deno task codegen generate --schema ... --out ...`.
3. If assembling params manually, verify the byte layout matches the schema's
   struct definition (data word count, pointer count, field offsets).

#### `UnknownQuestion`

**What it means:** The WASM peer received a message referencing a question ID
that it does not have in its question or answer table.

**Common causes:**

- A `finish` message was sent for a question before pipelined calls targeting
  that question completed. Once finished, the question is evicted from the
  answer table.
- The client sent a call with a `promisedAnswer` target referencing a question
  that has already been finished or was never registered.
- Question ID collision between server-originated outbound calls and
  WASM-peer-originated calls (the default offset at `0x40000000` should prevent
  this, but custom `nextQuestionId` values can cause overlap).

**How to fix:**

1. When using `callRawPipelined`, do **not** call `finish` until all pipelined
   calls that reference the question have completed.
2. Ensure `autoFinish: true` (the default) is not prematurely finishing
   questions that have downstream pipeline dependents.
3. If using custom `nextQuestionId` values, ensure they do not overlap with the
   WASM peer's internal question ID space.

#### `InvalidPointer`

**What it means:** A pointer word in the Cap'n Proto message has an invalid
structure (wrong kind bits, out-of-range offset, or illegal combination of
fields).

**Common causes:**

- Passing raw bytes to `pushFrame` that are not a valid Cap'n Proto framed
  message (missing the segment table header).
- Truncated network data delivered as a complete frame.

**How to fix:**

1. Ensure frames passed to the WASM peer include the full segment table header
   (minimum 8 bytes: 4-byte segment count + 4-byte segment 0 size).
2. Use the `CapnpFrameFramer` or a transport that handles framing automatically
   (`TcpTransport`, `WebSocketTransport`).

#### Other WASM Error Types

The WASM module may also produce errors with types matching these patterns:
`InvalidSegment`, `InvalidMessage`, `InvalidExport`, `InvalidTable`,
`InvalidList`, `InvalidStruct`, `InvalidCapability`, `InvalidAnswer`. These
follow the same diagnostic pattern: check the error message for context, verify
schema compatibility, and ensure frames are properly formed.

### Version Negotiation Errors

#### `capnp_wasm_abi_version mismatch: expected N, got M`

**What it means:** The WASM module reports ABI version `M` but the runtime
expected version `N`.

**How to fix:**

- Update the WASM module to match the runtime, or pass `{ expectedVersion: M }`
  to `instantiatePeer` / `WasmAbi` if version `M` is intentional.

#### `capnp_wasm_abi_version mismatch: expected N, supported range MIN..MAX`

**What it means:** The WASM module supports versions `MIN` through `MAX`, and
the requested version `N` is outside that range.

**How to fix:**

- Use a WASM module that supports the required version, or adjust
  `expectedVersion` to a value within the supported range.

#### `missing capnp_wasm_abi_version export`

**What it means:** The WASM module does not export a version function, and
`requireVersionExport: true` was set.

**How to fix:**

- Either remove `requireVersionExport: true` (the default is `false`) or rebuild
  the WASM module with version exports enabled.

### Missing WASM Exports

#### `missing wasm export: <name>`

**What it means:** A required WASM function (like `capnp_alloc`,
`capnp_peer_new`, etc.) is not present in the WASM module's exports.

**Common causes:**

- Using a WASM module that was not built with the capnp-zig toolchain.
- Using an outdated WASM module that lacks exports added in newer versions.

**How to fix:**

- Rebuild the WASM module: `just build-wasm`.
- Check `WasmAbiCapabilities` for which optional exports are detected.

#### `missing wasm memory export: memory`

**What it means:** The WASM module does not export a `memory` object.

**How to fix:**

- Ensure the WASM module is compiled with an exported memory (`--export-memory`
  or equivalent linker flag).

---

## Protocol Errors

Protocol errors (`ProtocolError`) indicate violations of the Cap'n Proto RPC
wire format or unexpected message structures. These are thrown during frame
decoding, encoding, or dispatch.

### Malformed Frames

#### `rpc message root pointer is null`

**What it means:** The decoded frame's root struct pointer is a null pointer
(all zero bits), which means the message body is empty or corrupted.

**Common causes:**

- An empty or zero-filled byte array was sent as a frame.
- The frame was truncated during transmission.

**How to fix:**

1. Verify that the transport is delivering complete frames. If using TCP, ensure
   `CapnpFrameFramer` is assembling frames correctly.
2. Check that the sender is encoding a proper Cap'n Proto message (not an empty
   `Uint8Array`).

#### `rpc message is not <expected_type>`

**What it means:** The frame's message tag does not match the expected type for
the decode function being called (e.g., calling `decodeCallRequestFrame` on a
Return frame).

**Common causes:**

- Frames being delivered to the wrong handler.
- A protocol mismatch between client and server.

**How to fix:**

- Use `decodeRpcMessageTag()` to inspect the frame type before calling a
  specific decode function, or use `decodeRpcMessage()` for automatic dispatch.

#### `unsupported rpc message tag for server bridge: N`

**What it means:** The `RpcServerBridge.handleFrame()` received a message type
it does not handle (neither Call, Bootstrap, Finish, Release, Return, Resolve,
nor Disembargo).

**How to fix:**

- Ensure both peers are using compatible versions of the Cap'n Proto RPC
  protocol.

### Bootstrap Failures

#### `bootstrap not configured -- provide onBootstrap in RpcServerBridgeOptions`

**What it means:** The server received a Bootstrap request, but no `onBootstrap`
handler was registered.

**How to fix:**

- Provide an `onBootstrap` callback when constructing `RpcServerBridge`:

```ts
const bridge = new RpcServerBridge({
  onBootstrap: ({ questionId }) => {
    return { capabilityIndex: myCapability.capabilityIndex };
  },
});
```

See [getting_started_rpc.md](getting_started_rpc.md) for a complete example.

#### `rpc bootstrap failed: <reason>`

**What it means:** The server returned an exception in response to the client's
Bootstrap request.

**Common causes:**

- The server's `onBootstrap` handler threw an error.
- The server's bootstrap capability was not exported before the client
  connected.

**How to fix:**

- Check the server-side error logs for the exception reason.
- Ensure the bootstrap capability is exported via `bridge.exportCapability(...)`
  before the session starts.

#### `bootstrap result did not include a hosted capability`

**What it means:** The server's Bootstrap return message had no sender-hosted or
receiver-hosted capability descriptor in its cap table.

**How to fix:**

- Ensure the server's `onBootstrap` handler returns a `capabilityIndex` that
  corresponds to an exported capability with a sender-hosted cap descriptor.

### Capability Resolution Failures

#### `unknown capability index: N`

**What it means:** A Call frame targets capability index `N`, but no dispatch
handler is registered for that index in the `RpcServerBridge`.

**Common causes:**

- The capability was never exported via `bridge.exportCapability(...)`.
- The capability was released (its reference count reached zero) before the call
  arrived.
- Client and server disagree on capability indices due to a wiring bug.

**How to fix:**

1. Verify that the capability is exported before any calls target it.
2. Check that `releaseCapability` is not being called prematurely.
3. Use the `onUnhandledError` callback on the bridge to log dispatch failures.

#### `interface mismatch for capability N: expected X got Y`

**What it means:** The incoming call's `interfaceId` does not match the
`interfaceId` (or `interfaceIds`) declared by the registered dispatch handler.

**Common causes:**

- The client is calling with an interface ID from a different schema version.
- The dispatch handler's `interfaceId` does not include the parent interface IDs
  for inherited interfaces.

**How to fix:**

1. Regenerate both client and server code from the same `.capnp` schema.
2. For inherited interfaces, use the generated RPC stubs which include
   `interfaceIds` covering all parent interfaces. Alternatively, set
   `interfaceIds` on your dispatch manually:

```ts
const dispatch: RpcServerDispatch = {
  interfaceId: MyInterface_InterfaceId,
  interfaceIds: [MyInterface_InterfaceId, ParentInterface_InterfaceId],
  dispatch(methodId, params, ctx) { ... },
};
```

#### `promisedAnswer target question resolved with exception: ...`

**What it means:** A pipelined call targeted a question whose result was an
exception rather than a successful return.

**How to fix:**

- Handle errors from the original call before making pipelined calls, or accept
  that pipelined calls will fail if the original call fails.

#### `promisedAnswer references unknown question N`

**What it means:** A pipelined call references a question ID that is not in the
server's answer table.

**Common causes:**

- The referenced question was already finished and evicted.
- The question ID was never registered (the original call was never received).

**How to fix:**

- Ensure `finish` is not sent for a question until all pipelined calls
  referencing it are complete. Use `callRawPipelined` and manage `finish`
  manually.

### Wire Encoding/Decoding Errors

#### `unsupported return tag: N`

**What it means:** A Return frame has a tag that is neither `results` (0) nor
`exception` (1). Other return types (e.g., `canceled`, `resultsSentElsewhere`)
are not yet supported.

#### `unsupported call target tag: N`

**What it means:** A Call frame's target uses a tag other than `importedCap` (0)
or `promisedAnswer` (1).

#### `unsupported promisedAnswer op tag: N`

**What it means:** A PromisedAnswer transform operation uses a tag other than
`noop` (0) or `getPointerField` (1).

---

## Transport Errors

Transport errors (`TransportError`) cover I/O problems in the underlying network
or IPC layer.

### Connection Lifecycle

#### `TcpTransport is closed` / `WebSocketTransport is closed` / `MessagePortTransport is closed`

**What it means:** An operation was attempted on a transport that has already
been closed.

**How to fix:**

- Check that your code does not call `send()` or `start()` after `close()`.
- If the transport was closed by the remote peer, handle the close event and
  create a new transport (or use `ReconnectingRpcClientTransport` for automatic
  reconnection).

#### `TcpTransport already started` / `WebSocketTransport already started`

**What it means:** `start()` was called more than once on the same transport
instance.

**How to fix:**

- Call `start()` exactly once per transport instance.

#### `TcpTransport not started`

**What it means:** `send()` was called before `start()`.

**How to fix:**

- Call `start()` before sending frames, or set `autoStart: true` on the client
  transport.

### Frame Size Limits

#### `capnp frame size N exceeds configured limit M`

**What it means:** The assembled frame is larger than `maxFrameBytes`.

**Common causes:**

- A legitimate large message that exceeds the default 64 MB limit.
- A corrupt or malicious frame header claiming an unreasonably large size.

**How to fix:**

- If the message is legitimately large, increase `maxFrameBytes` in the
  `CapnpFrameFramerOptions`.
- If the frame is unexpected, investigate the sender for bugs.

#### `capnp frame segment count N exceeds configured limit M`

**What it means:** The frame claims to have more segments than `maxSegmentCount`
allows.

**How to fix:**

- Increase `maxSegmentCount` if multi-segment messages are expected.
- Default is 512 segments, which is generous for most use cases.

#### `capnp frame traversal words N exceeds configured limit M`

**What it means:** The total word count across all segments exceeds
`maxTraversalWords`.

**How to fix:**

- Increase `maxTraversalWords` or investigate why messages are so large.

#### `capnp framer buffer size N exceeds configured limit M`

**What it means:** The framer's internal buffer has accumulated more bytes than
`maxBufferedBytes` while waiting for a complete frame.

**Common causes:**

- A very large frame is being assembled incrementally.
- A corrupt length header caused the framer to expect an enormous frame.

**How to fix:**

- Increase `maxBufferedBytes` for legitimately large messages.
- Investigate the stream for corruption if the sizes are unreasonable.

### Reconnection Errors

#### `reconnect aborted`

**What it means:** The reconnection attempt was cancelled (e.g., via an abort
signal or because `close()` was called).

#### `connection pool is at capacity`

**What it means:** All slots in the connection pool are in use and no new
connections can be created.

**How to fix:**

- Increase the pool's maximum size, or release idle connections.

### Circuit Breaker

#### `circuit breaker is OPEN`

**What it means:** The circuit breaker has tripped due to too many consecutive
connection failures and is rejecting new connection attempts.

**How to fix:**

- Wait for the cooldown period to elapse (default 30 seconds), after which a
  probe attempt will be allowed.
- Fix the underlying connection issue (server down, network partition).

---

## Session Errors

Session errors (`SessionError`) cover RPC session lifecycle problems.

### Lifecycle

#### `RpcSession is closed`

**What it means:** An operation was attempted on a session that has been closed.

**How to fix:**

- Ensure all calls complete before calling `session.close()`.
- Do not reuse a session after closing it; create a new one.

#### `RpcSession already started`

**What it means:** `session.start()` was called more than once.

**How to fix:**

- Call `start()` exactly once per session.

#### `RpcSession start is already in progress`

**What it means:** A concurrent call to `start()` is already executing.

**How to fix:**

- Await the first `start()` call before attempting another.

### Timeout and Abort Errors

#### `rpc wait timed out after Nms`

**What it means:** No Return frame was received for a pending question within
the configured timeout.

**Common causes:**

- The server is slow or unresponsive.
- The transport dropped the response frame.
- The server never sent a Return (e.g., the dispatch handler is stuck).

**How to fix:**

1. Increase `timeoutMs` on the call, or `defaultTimeoutMs` on the client
   transport.
2. Check server-side logs for dispatch errors.
3. Ensure the server's `RpcServerBridge.handleFrame()` is returning response
   frames correctly.

#### `rpc wait aborted`

**What it means:** The call was cancelled via an `AbortSignal`.

**How to fix:**

- This is expected behavior when the caller explicitly aborts. If unintended,
  check the signal source.

#### `rpc wait rejected: question N is not awaiting a return`

**What it means:** An attempt was made to await a Return for a question that was
never registered or has already been observed.

**How to fix:**

- This is usually an internal state error. File a bug if you see it in normal
  usage.

### Server Runtime Warnings

These are not thrown as errors by default but are emitted via the
`hostCallPump.onWarning` callback.

#### `host-call pump is disabled because wasm host-call bridge exports are unavailable`

**What it means:** The WASM module does not export the host-call bridge
functions (`capnp_peer_pop_host_call`, `capnp_peer_respond_host_call_*`).
Host-call pumping has been automatically disabled.

**Impact:** Server-side dispatch of calls from the WASM peer to host-side
handlers will not work. This is expected if the WASM module does not use host
calls.

**How to fix:**

- If host calls are needed, rebuild the WASM module with host-call bridge
  support.
- If not needed, this warning is informational and can be ignored.

#### `host-call pump was explicitly enabled, but wasm host-call bridge exports are unavailable`

**What it means:** `hostCallPump.enabled` was explicitly set to `true`, but the
WASM module lacks the required exports.

**How to fix:**

- Either set `hostCallPump.enabled: false` (or omit it to auto-detect), or
  rebuild the WASM module with host-call bridge support.

#### `host-call pump limit reached (N)`

**What it means:** The total number of host calls pumped has reached the
configured `maxCallsTotal` limit. If `failOnLimit` is `true` (the default), this
is thrown as a `SessionError`.

**How to fix:**

- Increase `hostCallPump.maxCallsTotal` for workloads with many host calls.
- Set `failOnLimit: false` to silently disable further pumping instead of
  throwing.

---

## Instantiation Errors

Instantiation errors (`InstantiationError`) occur when loading or compiling the
WASM module.

#### `unsupported BufferSource`

**What it means:** The `source` argument passed to `instantiatePeer` is not a
recognized type.

**How to fix:**

- Pass one of: `URL`, URL string, file path string, `Response`, `ArrayBuffer`,
  `Uint8Array`, or other `ArrayBufferView`.

#### `failed to fetch wasm module: <status> <statusText>`

**What it means:** The HTTP fetch for the WASM module URL failed.

**Common causes:**

- Incorrect URL path.
- The server hosting the WASM file is not running.
- Missing CORS headers for cross-origin fetches.

**How to fix:**

- Verify the URL is correct and the server is reachable.
- For local files, use a `file:` URL or a plain file path.

---

## Codegen / Type-Check Errors

These are not runtime errors but compiler errors from generated code.

#### `T extends Record<string, unknown>` constraint failures

**What it means:** Generated interfaces do not include an index signature, but
the runtime API's generic constraints require one.

**How to fix:**

- This is a known issue (see
  [capnp-examples_feedback.md](capnp-examples_feedback.md), item 1).
- Regenerate code with the latest version of `capnpc-deno`.
- As a workaround, add `// @ts-ignore` or cast through `unknown`.

---

## Debugging Tips

### Enable observability

All major components accept an `observability` option that emits structured
diagnostic events. Use this to trace frame flow, session lifecycle, and errors:

```ts
const observability = {
  onEvent(event) {
    console.log(`[${event.name}]`, event.attributes, event.error ?? "");
  },
};

const session = new RpcSession(peer, transport, { observability });
const client = new SessionRpcClientTransport(session, transport, {
  interfaceId: MyInterfaceId,
  observability,
});
```

### Inspect error metadata

`CapnpError` instances may carry structured `metadata` with fields like
`errorType`, `questionId`, `interfaceId`, `methodId`, `capabilityIndex`, and
`phase`:

```ts
try {
  await client.call(cap, 0, params);
} catch (error) {
  if (error instanceof CapnpError) {
    console.log("kind:", error.kind);
    console.log("metadata:", error.metadata);
  }
}
```

### Use `onUnhandledError` on the server bridge

Register an error handler to see dispatch failures that would otherwise be
returned as exceptions to the client:

```ts
const bridge = new RpcServerBridge({
  onUnhandledError: (error, call) => {
    console.error(
      `dispatch error for question=${call.questionId}`,
      `iface=${call.interfaceId} method=${call.methodId}:`,
      error,
    );
  },
});
```

### Check the answer table

The `RpcServerBridge.answerTableSize` property shows how many in-flight or
completed-but-unfinished questions are tracked. A steadily growing answer table
indicates that `finish` messages are not being sent:

```ts
console.log("answer table entries:", bridge.answerTableSize);
```

### Verify transport wiring

A common source of confusion is incorrect transport composition. Refer to
[transport_composition.md](transport_composition.md) for the canonical wiring
patterns. The key invariant: each player/connection needs its own full stack
(peer, transport, bridge, runtime).

---

## Further Reading

- [Getting Started with RPC](getting_started_rpc.md) -- end-to-end setup guide
- [Transport Composition](transport_composition.md) -- how to wire transports,
  sessions, and runtimes
- [WASM Host ABI](wasm_host_abi.md) -- low-level ABI reference
