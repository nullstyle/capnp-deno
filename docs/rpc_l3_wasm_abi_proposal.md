# Level-3 three-party handoff over the WASM host ABI — proposal

Status: **the Deno-side recipient pipeline is complete and live-tested**.
capnp-zig `v0.22.0` (feature bit `10`; upstream commits `50e5e6d`/`1b894a1`, tag
`9de73ba…`) ships the wasm exports; the vendored runtime here is that tag;
`@nullstyle/capnp/advanced` exposes the Experimental Deno wrappers
(`mintHandoffTokens`, `handoffCompletionFromContact`, `provideCapability`,
`acceptProvision`, `registerThirdPartyAwait`, `sendThirdPartyAnswer`); and the
TypeScript wire codec emits and parses `thirdPartyHosted` cap descriptors. A
real-wasm test drives the whole recipient pipeline through the actual host-call
relay: originate the Provide, deliver the vine as a `thirdPartyHosted`
descriptor, decode it on the recipient side, resolve the byte-identical
completion, and accept on the third connection. The
[Implementation deltas](#implementation-deltas) section records where the
shipped design differs from the original proposal. **The VatC gap is closed**:
capnp-zig main after v0.22.0 (`72d6d7f…`) exposes the vat-wide `ProvisionIndex`
over the wasm ABI (feature bit 11 — `capnp_provision_index_new/free`,
`capnp_peer_attach_provision_index`/`detach`). A vat represented by several
module-local peers attaches to one index; an inbound Provide registers its
provision and an inbound Accept on a sibling connection is served by the runtime
itself. The autonomous test drives the whole loop — Provide registered into the
shared index, Accept crossing connections, VatC's own capability-bearing answer
resolving the recipient's wait — with no host-forged Returns. Nothing here is a
Stable API; the next frontier is the native Zig/C++ three-vat interop matrix and
wiring the wrappers under real session stacks.

## Why

Cap'n Proto RPC's headline feature over raw request/response is the three-party
capability handoff: a Deno vat holds a capability from vat B and hands it to vat
C without proxying every later call through itself
(`startSession(client :Client)` across two connections). capnp-zig implements
the full origination side — `sendProvide`, `sendAccept`, `sendThirdPartyAnswer`,
`registerPendingThirdPartyAwait`, `resolvePromiseExportToThirdParty`, the
inbound Provide/Accept/Join arms, and the embargo/pickup machinery
(`src/rpc/peer/provide/`, `src/rpc/vat/`). The wire vocabulary is already
compiled into our WASM runtime: the vendored `src/rpc/capnp/rpc.capnp` carries
`provide`, `accept`, `thirdPartyHosted`, and `Join` messages, and it is
byte-identical to what `src/rpc/gen/capnp/` generates from.

None of it is reachable from Deno. The WASM host ABI
(`vendor/capnp-zig/src/wasm/capnp_host_abi.zig`) exposes only the two-party
core: peer lifecycle, frame push/pop, host-call bridge, Finish/release, and
bootstrap stubs. This document proposes the minimal ABI extension that exposes
origination and pickup behind an Experimental, feature-bit-gated surface, per
the capnp-zig upgrade handoff's integration guidance (pin exactly, keep wrappers
narrow, add downstream tests before any Stable claim).

## What the upstream runtime already gives us

- `Peer.sendProvide(provided_target, recipient, host_of_recipient, contact_payload) → ProvideHandle{question_id, vine_id}`
  — the Provide question goes to the recipient's connection; the vine lives on
  the host-of-recipient peer and is marked third-party-hosted.
- `Peer.sendAccept(provision, embargo, ctx, on_return) → question_id` and
  `sendAcceptNoRestore(..., suppress_auto_finish)` — redeem a provision on a
  third-party connection; the embargo makes pickup transparent to pipelining.
- `Peer.sendThirdPartyAnswer(answer_id, completion)` /
  `registerPendingThirdPartyAwait(completion, ctx, on_return)` — the third-party
  vat side of the completion handshake.
- `Peer.setHandoffPickupHandler(ctx, on_pickup)` with
  `HandoffPickupCallback(promise_peer, promise_id, accept_peer, ret, accept_caps)`.
- `VatNetwork` (`src/rpc/vat/network.zig`) — an application-supplied vtable with
  exactly two operations:
  - `mint_introduction` (run on the host-of-provided-cap side, VatB): pair the
    opaque `ThirdPartyToAwait` / `ThirdPartyToContact` tokens from a nonce;
  - `connect_to_introduced` (recipient side, VatA): resolve a
    `ThirdPartyToContact` to a live peer connected to VatC plus the
    `ThirdPartyCompletion` to present in the Accept. `LoopbackVatNetwork` is the
    in-process test double. Deno does not need a wasm-side network: the Deno
    host _is_ the vat network.

The WASM module already supports multiple peers per instance (`capnp_peer_new`),
which is the load-bearing fact: originator, recipient, and third-party
connections can all live as peers in one module, and the host pumps each peer's
transports exactly as it pumps the single peer today.

## Proposed ABI surface (feature bit 10, `FEATURE_L3_HANDOFF`)

Feature bits 0–9 are assigned; this takes bit 10 of the low word. The host
checks `capnp_wasm_feature_flags_lo() & (1 << 10)` before binding any L3
wrapper, and the module refuses L3 exports when built without them (the same
negotiation pattern as bits 6–9). All new exports follow the existing
conventions: `u32` peer handles, `(ptr, len)` byte views borrowed for the call,
`capnp_last_error_*` for failures, owned outputs freed by the caller with exact
lengths via `capnp_buf_free`.

New exports, one per origination API plus pickup registration:

```c
u32 capnp_peer_send_provide(
    u32 peer,                     // originator (holds the cap to hand off)
    u32 host_of_recipient_peer,   // connection to the recipient vat
    const u8* provided_target, u32 provided_target_len,   // MessageTarget, serialized
    const u8* recipient, u32 recipient_len,               // AnyPointer descriptor
    const u8* contact_payload, u32 contact_len,           // opaque bytes for the third party
    u32* out_question_id, u32* out_vine_id);              // ProvideHandle

u32 capnp_peer_send_accept(
    u32 peer, const u8* provision, u32 provision_len,
    const u8* embargo, u32 embargo_len,      // empty = no embargo
    u32* out_question_id);                   // completion arrives as a host call (kind below)

u32 capnp_peer_send_third_party_answer(
    u32 peer, u32 answer_id,
    const u8* completion, u32 completion_len);

u32 capnp_peer_register_pending_third_party_await(
    u32 peer, const u8* completion, u32 completion_len, u32* out_question_id);

u32 capnp_peer_set_handoff_pickup_handler(u32 peer, u32 enabled);
```

`sendProvideFromRetainedAnswer` (pipelined handoff from a retained answer) and
`sendAcceptNoRestore`'s `suppress_auto_finish` are deferred: they can be added
without a new feature bit once the base surface exists, and the first Deno
wrapper does not need them.

### New host-call kinds (over the existing bridge)

The host-call bridge (`capnp_peer_pop_host_call` /
`capnp_peer_respond_host_call_*`) already carries arbitrary wasm→host
invocations with owned byte payloads. Three new kinds complete the seam:

- `L3_MINT_INTRODUCTION` — in: `host_of_recipient` peer id, recipient hint
  bytes; out: `third_party_to_await` bytes, `third_party_to_contact` bytes. This
  is `VatNetwork.mint_introduction` executed by the Deno host, which mints the
  nonce and owns the token format.
- `L3_CONNECT_TO_INTRODUCED` — in: `third_party_to_contact` bytes; out: a peer
  id (the host dials VatC or resolves a registry entry and answers with a peer
  it created in the same module) plus `third_party_completion` bytes. This is
  `connect_to_introduced` with the Deno host as the dialer.
- `L3_HANDOFF_PICKUP` — notification only: promise peer id, `promise_id`, accept
  peer id, and the serialized `Return` payload. Surfaces the
  `HandoffPickupCallback`; the host responds with an empty success (callback
  errors are non-fatal upstream and remain so here).

Ownership rules mirror the bridge today: descriptor bytes crossing either way
are owned by the receiver and freed with exact lengths; the `Return` in a pickup
notification is borrowed for the response and copied by the host if retained; a
pickup host call holds the same per-peer budget slot as an ordinary host call so
retained Call-frame accounting stays uniform.

## Deno-side surface (Experimental, `src/advanced.ts`)

Narrow wrappers only, all named with an `Experimental` marker in JSDoc and
excluded from the Stable API snapshot:

- `provideCapability(recipientSession, capability, contact)` →
  `{ questionId, vineId }` handle with `finish()`/`release()`;
- `acceptProvision(session, provision, { embargo? })` → promise of the picked-up
  capability, resolved through the existing answer plumbing;
- `setHandoffPickupHandler(sessions, handler)` across a session pair;
- a `ThirdPartyIntroducer` function type the host implements to answer
  `L3_MINT_INTRODUCTION` / `L3_CONNECT_TO_INTRODUCED` — the Deno-side stand-in
  for `VatNetwork`, with the application owning dialing and token formats.

Sessions continue to wrap one peer each; an L3 group is two or three sessions
whose peers share one WASM module instance. The pump invariant (drain outbound
frames in order after each inbound frame) is unchanged — the host-call kinds
ride the same drain.

## Test plan (from the capnp-zig upgrade handoff, item 7)

1. Provide/Accept handoff: cap from a Zig or C++ reference vat, provided to a
   second reference vat, accepted through a third connection; the Deno vat drops
   its reference and the cap still works (no proxying through Deno).
2. Auto-pickup through the introducer: `L3_CONNECT_TO_INTRODUCED` dials on
   demand; token round-trip is opaque to the runtime.
3. Embargoed pickup: calls pipelined on the accepting capability before the
   embargo lifts are buffered, not lost.
4. Forwarded cap-bearing params/results across the handoff (the classic
   `startSession(client)` shape) in both directions.
5. Negative paths: expired/unknown token, mint without a live recipient
   connection, Accept after the vine was released, pickup handler error, and
   disconnect of any leg — each must settle every held question exactly once and
   free every recorded grant (extend the existing soak patterns).

Conformance runs against the native Zig and C++ reference peers through
`test:native-interop` extended with a three-vat fixture; the wasm-only suites
cover the Deno↔Deno loopback using two module-local peers.

## Rollout

1. capnp-zig implements the exports and host-call kinds behind a build flag or
   unconditionally-gated exports, with its own ABI tests
   (`tests/wasm_host_abi_test.zig` grows the L3 cases).
2. capnp-deno advances the vendor pin and rebuilds the artifact; the receipt
   records feature bit 10; `check:wasm` learns to require it once bound.
3. The `advanced.ts` wrappers land with the tests above; nothing is exported
   from `mod.ts`/`rpc.ts` until the cross-implementation matrix (Deno↔Zig↔C++)
   passes and capnp-zig declares the surface beyond Experimental.

## Open questions for capnp-zig

- Token format ownership: the host mints `ThirdPartyToContact` today via
  `encodeNonceToken`; should the ABI carry the nonce and let the host wrap it,
  or pass opaque blobs end to end and keep `encodeNonceToken` host-side?
- Should `L3_HANDOFF_PICKUP` responses be able to carry a reject reason that
  converts to a protocol `Disembargo`/exception, or is fire-and-forget with
  non-fatal errors (the upstream contract) sufficient for v1?
- Peer lifetime: when the host answers `L3_CONNECT_TO_INTRODUCED` with a new
  peer, who owns its disposal ordering relative to the accepting question —
  proposal: the accepting session, mirroring bootstrap stub ownership.
- Whether `FEATURE_L3_HANDOFF` should also gate a `capnp_schema_manifest_json`
  addition naming the L3 wire messages, so generated TypeScript can assert
  schema coverage at bind time.

## Implementation deltas (v1, capnp-zig `50e5e6d`)

Reading the origination internals settled the open questions and simplified the
surface considerably:

- **No `VatNetwork` host-call kinds are needed.** Upstream `Peer.sendProvide`
  takes the `ThirdPartyToAwait` recipient blob and the `ThirdPartyToContact`
  bytes as plain arguments — the peer never calls the network during
  origination. The Deno host mints and resolves tokens entirely host-side (this
  repository already owns the token format), so `L3_MINT_INTRODUCTION` and
  `L3_CONNECT_TO_INTRODUCED` from the proposal are unnecessary; only the
  embedder-side introducer remains.
- **The pickup-handler export is deferred.** Upstream auto-pickup requires
  `attachVatNetwork` and resolves connections synchronously inside inbound frame
  processing, which a wasm module cannot do. The Deno replacement is the
  host-driven path: TS observes inbound `thirdPartyHosted` descriptors and
  originates the Accept itself on the connection it resolved — exactly the
  `acceptProvision` flow the Deno API section describes.
- **The event channel is a dedicated owned-output pop**
  (`capnp_peer_pop_l3_event`), not host-call-bridge notifications. Kinds 1/2
  carry the complete inbound RPC message byte-identically (Return plus cap-table
  descriptors), so the existing TS wire parser reads capability placement; kind
  3 carries an exception reason for synthetic Returns such as the shutdown
  drain. Await events carry question id 0 (parked questions have no wire id
  until adoption); correlate them by frame content.
- **`sendProvide` v1 targets `importedCap` only**; the retained-answer and
  promised-answer target forms are deferred (they need no new feature bit once
  added).
- **`sendThirdPartyAnswer` v1 auto-allocates** the callee-chosen answer id and
  returns it; the `WithId` form is deferred.
- **Exactly-once delivery is defensively guarded** (a `delivered` flag per
  origination): the upstream Return machinery can leave a question reachable
  after its Return (a `noFinishNeeded` Return stays finishable) and the shutdown
  drain re-delivers. Budgets: 64 outstanding origins, 256 queued events, 4 MiB
  event bytes.

The rollout's step 1 (upstream implementation + ABI tests) is complete;
`zig build test` is 245/245 steps green upstream. Step 2 (vendor bump and
artifact rebuild) waits on the next capnp-zig release tag.
