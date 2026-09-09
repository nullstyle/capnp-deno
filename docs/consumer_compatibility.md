# Schema evolution and connection closure

These checks follow up on two failures found while using capnp-deno as an
external client of capnp-zig's KVStore service.

## Reading older messages

Generated codecs use the incoming message's data and pointer counts. A field
added after an older writer was built reads as its schema default when its slot
is absent. A present null pointer also selects the field default. An explicit
empty Text or Data value remains empty when the field has a nonempty default.
Inline-composite lists use the element stride stored in the message, so growing
the element schema does not move subsequent elements.

The generator retains explicit Text, Data, boolean, integer, floating-point, and
enum defaults. Scalar encoding and decoding apply the default's XOR mask,
including fields added into existing padding, as required by the
[Cap'n Proto encoding specification](https://capnproto.org/encoding.html#default-values).
Regenerate bindings to gain explicit-default support; older generated code
discarded those defaults. Unsupported non-null aggregate defaults produce a
code-generation error identifying the field instead of silently changing its
meaning.

Missing schema slots do not relax validation of pointers actually present in a
message. Truncated or out-of-bounds pointer targets still fail decoding.

Run the generated codec and RPC response regressions from the repository root:

```sh
mise exec -- deno test \
  --allow-read=tests/fixtures/codegen_requests,src,generated/capnp_deno.wasm \
  tests/codegen/capnpc_deno_evolution_test.ts
```

The fixture records requests and messages produced by Cap'n Proto 1.5.0,
providing an independent wire-format oracle for defaults and schema evolution.
To regenerate it with the reference compiler:

```sh
mise exec -- deno run --allow-run=capnp \
  --allow-write=tests/fixtures/codegen_requests \
  tests/codegen/generate_evolution_fixtures.ts
```

## Pending RPC calls at EOF

`RpcWireClient` observes terminal transport closure and rejects pending calls,
including calls with no timeout configured. Omit `defaultTimeoutMs` to disable
the default deadline; `client.stats.defaultTimeoutMs` then reports `null`.
Closure also updates its `closed` status and prevents new requests. Call
deadlines remain useful for peers that stay connected without replying.

`RpcTransport.subscribeClose` is optional for existing custom transports. A
transport that implements it must notify observers once at terminal closure and
replay closure to late subscribers. Wrappers forward the subscription.
MessagePort has no remote-close event, so its notification covers local closure.

The loopback regression sends sixteen calls, verifies that all sixteen are
pending with no deadlines, then closes the server connection. It checks direct
and wrapped transports, prompt rejection, and cleanup before explicit client
closure:

```sh
mise exec -- deno task test:integration
```

## External KVStore verification

On 2026-09-08, the updated client and regenerated evolved bindings passed the
original probes against the unchanged capnp-zig ReleaseSafe KVStore server at
`b54749094222bce6c1f97ab072c5fbcb4e4dbe71`, using Deno 2.6.8 on macOS arm64. The
server executable's SHA-256 was
`12a7f66cbb59bff9ee48e2581244bee0b9bc3c6bca1a6165c32b1f3d0cc38479`.

| Check                                                                  | Result                                                                                                      |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Added request field and response `source :Text = "new-client-default"` | Old server accepted the write; new client decoded its response and the declared default                     |
| Sent-call cancellation                                                 | Eight Calls and eight matching early-cancellation Finish frames; subsequent requests succeeded              |
| Fresh connections                                                      | Five bootstrap/read/close cycles succeeded                                                                  |
| Normal server shutdown during reads                                    | 67,568 completed reads; sixteen active calls rejected on closure without configured deadlines               |
| Settlement after TCP close notification                                | 1 ms; client closed and pending Returns zero before explicit cleanup                                        |
| Restart and persistence                                                | Both scenarios recovered the acknowledged marker at version 1; all four server processes exited with code 0 |

The TCP options callback runs after RPC closure subscribers, so its observed
pending count was already zero. The independent loopback tests verify sixteen
pending calls before inducing EOF. The earlier external client waited about
1,000 ms for configured call deadlines after EOF; this probe configures none.
These are bounded interoperability checks, not production-soak evidence.

The local scripts, generated client, logs, and `service-receipt.json` are
retained under `.zig-cache/consumer-gaps/`. The durable generated-code and
loopback tests above exercise the corresponding failure cases without requiring
another checkout. The complete local gate passed 1,065 unit tests, 32 socket
integration tests, 16 real-WASM tests, seven CLI end-to-end tests, formatting,
lint, type checking, and generated RPC synchronization.
