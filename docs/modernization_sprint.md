# capnp-deno modernization sprint

Survey date: 2026-09-15 UTC. Status: proposed; no runtime, dependency, or
release changes have been made. Companion evidence:
[capnp-wasm survey](capnp_wasm_delta_survey.md).

## Recommendation

Plan a **three-week sprint with two parallel workstreams** to deliver Deno-only
schema compilation, a reproducible current capnp-zig runtime, and bounded,
correct RPC lifecycles. Budget **22–32 engineering days**, including 3–4 days of
integration contingency. A single contributor should budget roughly 4–6 weeks;
publication decisions or new platform failures can extend either estimate.

The intended release is the next capnp-deno minor, provisionally `0.6.0`, after
compatibility review. This plan does not authorize publishing an SDK or tagging
a release.

Keep three responsibilities distinct:

| Module                         | Responsibility after the sprint                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| capnp-wasm compiler host       | Compile schema bytes into `CodeGeneratorRequest` using pinned Cap'n Proto 2.0-dev; isolate execution and enforce compiler limits. |
| capnpc-deno                    | Discover permitted files, preserve CLI path/layout semantics, interpret the request, and generate TypeScript.                     |
| capnp-deno + capnp-zig runtime | TypeScript codecs, service/session/transports, and the Zig WASM peer. The compiler SDK does not replace this runtime.             |

The compiler's binary request is the existing integration seam. The survey
proved it works without rewriting the TypeScript generator. The published
runtime should remain independent of compiler tooling and retain its existing
entrypoints. See
[compiler integration evidence](capnp_wasm_delta_survey.md#in-process-integration-is-already-feasible)
and [current package contents](../deno.json).

## Survey findings

### Revision and compatibility baseline

| Item                    | Observed state                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| capnp-deno              | `24ccd29`, last updated September 8; package version `0.5.0`.                                                                                       |
| Vendored capnp-zig      | `ae1ef92cf54761b8fbb46a8fb0bcd90a2bd80e50`, v0.11.0; vendor bump committed August 15.                                                               |
| Target capnp-zig        | `c30abbbdde561931f3f179884f24d1309c5599ae`, 85 commits ahead, including v0.18.0 and the subsequent WASM compiler migration.                         |
| capnp-wasm              | `0c45c08aa7a836a09e2d715f790823288769b04c`; compiler 2.0-dev. Exact archive/module/include pins are in the companion survey.                        |
| Deno / Zig              | Repo pins Deno `2.6.8` and Zig `0.17.0-dev.1683+5ceec001b`; Zig already matches current capnp-zig. The README's Zig `0.15.2` prerequisite is stale. |
| Checked-in runtime WASM | 293,045 bytes; SHA-256 `0c05ef20ecc06d9cd4eeaf08d9a6574755ed855bf64e004beeceeeabae221851`. No accompanying build provenance manifest.               |
| Runtime interface       | Existing and current rebuilt modules have the same 38 export entries, no imports, ABI version 1, and feature flags `1023 / 0`.                      |

Revision facts came from local Git histories/gitlinks. Relevant source:
[tool pins](../mise.toml), [runtime artifact build](../scripts/build_wasm.sh),
[ABI negotiation](../src/wasm/abi.ts), and
[upstream ABI contract](/Users/nullstyle/prj/zig/capnp-zig/docs/wasm_host_abi.md).

The dependency bump brings transitive wire/copy correctness and native RPC
improvements. Native reflection, advanced streaming, and L3/L4 changes are not
automatically exposed through the unchanged WASM interface. Do not advertise
them as Deno features merely because the gitlink advances.

| Upstream development                                                                                             | Consequence for capnp-deno                                                                                             |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Standard double-far struct/list validation and copying, including present empty structs and legacy compatibility | Rebuilt WASM inherits fixes; exercise equivalent encodings through the independent TS reader/copy path.                |
| Capability-aware copy staging, rollback, and work/output/allocation limits                                       | Validate cap-table accounting and failure cleanup through the Deno host; an upstream fix does not establish TS parity. |
| Full schema request bundles, dynamic reflection, and concrete generic views                                      | Useful future specifications; current WASM exports and Deno's schema model do not expose this feature set.             |
| Exact-byte streaming admission, deferred acknowledgments, and ordinary-call barriers                             | Provides a reference for S7 and native interop, rather than automatically upgrading Deno's call-count-only sender.     |
| Vendored framing conformance corpus                                                                              | A ready-made independent fixture source for S6.                                                                        |
| Native QUIC/worker/Windows I/O improvements                                                                      | Relevant reference scenarios, but Deno owns its transports; no blanket claim that these fixes apply to Deno.           |

Sources:
[double-far validation](/Users/nullstyle/prj/zig/capnp-zig/src/serialization/message.zig:1266),
[pointer copying](/Users/nullstyle/prj/zig/capnp-zig/src/serialization/message/clone_any_pointer.zig:37),
[copy budgets](/Users/nullstyle/prj/zig/capnp-zig/src/serialization/copy_budget.zig:6),
[reflection](/Users/nullstyle/prj/zig/capnp-zig/docs/reflection.md:9),
[streaming](/Users/nullstyle/prj/zig/capnp-zig/docs/streaming.md:7), and
[framing corpus](/Users/nullstyle/prj/zig/capnp-zig/tests/fixtures/framing/README.md:7).

### Checks actually run

| Check                                      | Result and scope                                                                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-mutating formatting / lint             | 222 / 176 files passed.                                                                                                                                                             |
| Type checking / generated-fixture checking | Passed on pinned Deno 2.6.8.                                                                                                                                                        |
| Unit suite                                 | 1,065 passed, no failures.                                                                                                                                                          |
| Existing real-WASM suite                   | 16/16 passed against the checked-in runtime.                                                                                                                                        |
| Current upstream runtime                   | Temp-only build passed; the same 16/16 tests passed in an isolated checkout with its explicit Deno config.                                                                          |
| Compiler SDK smoke                         | Existing parser/emitter accepted representative 2.0-dev requests on Deno 2.6.8 and 2.9.6, with no subprocess/network permission and read permission revoked before guest execution. |
| Compiler output comparison                 | All 14 TS/meta files across five representative jobs matched byte-for-byte between native 1.5.0, native 2.0-dev, and WASM 2.0-dev. Requests themselves differ.                      |

These are local macOS arm64 results, not hosted Windows/Linux acceptance. They
do not prove complete schema-feature parity. Existing non-null struct/list
default rejection remains intentional. The initial isolated-runtime error-class
failure disappeared when the temporary checkout used its own Deno config; it is
not an upstream regression.

Baseline logs are
`/tmp/capnp-deno-survey-{fmt,lint,check,generated,unit,real}.log`;
current-runtime log is `/tmp/capnp-deno-survey-real-current.log`. Compiler probe
commands and limits are recorded in the companion survey. Disposable probes must
become maintained regression tests during implementation.

### Confirmed defects and missing guarantees

1. **WASM ownership violations.** `takeLastError()` frees borrowed static error
   text; `freeOutBuffer()` converts a legitimate zero length into one, violating
   the exact-length free contract. Real-module probes reproduce `InvalidFree`
   after reading an error and after incorrectly freeing a zero-length
   allocation. Separately, wrapper scratch allocations have no disposal path:
   repeated wrapper creation/closure exhausts the module's tracked allocations
   after 512 cycles. `WasmSerde` also holds persistent scratch storage. These
   are existing host defects, not a new ABI break.
   ([Host cleanup](/Users/nullstyle/prj/local/capnp-deno/src/wasm/abi.ts:1014),
   [error handling](/Users/nullstyle/prj/local/capnp-deno/src/wasm/abi.ts:1233),
   [scratch allocation](/Users/nullstyle/prj/local/capnp-deno/src/wasm/abi.ts:1122),
   [peer close](/Users/nullstyle/prj/local/capnp-deno/src/wasm/peer.ts:150),
   [serde scratch](/Users/nullstyle/prj/local/capnp-deno/src/encoding/serde.ts:120),
   [exact-length rule](/Users/nullstyle/prj/zig/capnp-zig/docs/wasm_host_abi.md:149),
   [borrowed errors](/Users/nullstyle/prj/zig/capnp-zig/docs/wasm_host_abi.md:195))
2. **Generic transport closure misses service supervision.** With the real
   bundled runtime and a custom transport implementing replayable
   `subscribeClose`, closing the transport left the service handle/runtime open
   and never disposed the service. Explicit handle closure then disposed it
   once. The supervisor recognizes only concrete TCP/WebSocket/WebTransport
   classes, while the public transport contract already provides closure
   subscription.
   ([Supervisor](/Users/nullstyle/prj/local/capnp-deno/src/rpc/server/service.ts:451),
   [contract](/Users/nullstyle/prj/local/capnp-deno/src/rpc/transports/internal/transport.ts:52))
3. **Compiler choice and runtime artifact identity are ambient.** Normal codegen
   invokes PATH `capnp`; install/compiled CLI permissions and CI assume that
   executable. Runtime rebuilding accepts two historical output names, uses
   unpinned optional Binaryen, and silently keeps unoptimized output if
   optimization fails. These should become explicit build inputs and receipts.
   ([Compiler call](/Users/nullstyle/prj/local/capnp-deno/tools/capnpc-deno/main.ts:45),
   [build script](../scripts/build_wasm.sh), [permissions](../deno.json))
4. **Release portability is unproven.** CI runs on Ubuntu only; release builds
   cross-compile five binaries but never execute them or require the
   test/package gates. Real-WASM CI rebuilds and tests without comparing the
   artifact to the published file set. `verify` formats files in place. Windows
   drive-path loading is a source-supported concern, not a reproduced Windows
   failure. ([CI](../.github/workflows/ci.yml),
   [release](../.github/workflows/release.yml),
   [loader](/Users/nullstyle/prj/local/capnp-deno/src/wasm/load.ts:46))

The previous [interop/performance sprint](interop_performance_sprint.md) is
largely implemented: external serialization fixtures, callback/capability and
streaming tests, named benchmarks, and budget reporting already exist. Extend
those assets. The September 8 [native KVStore probes](consumer_compatibility.md)
are useful evidence, but are not a standing native cross-implementation CI job.

## Sprint backlog

Effort ranges below exclude the shared integration contingency. Names describe
proposed work, not features already implemented.

### S1 — Deliver a verified compiler-host package

**P0; capnp-wasm owner; 1–2 days.** Produce the smallest useful bundle:
compiler, standard schemas, built TypeScript host/declarations/worker, licenses,
and complete integrity/provenance data. Omit other language generators and Go
SDK. Pin its identity in capnp-deno. Reuse producer packaging and verification
rather than forking its WASI implementation into capnp-deno.

**Acceptance:** reproducible staging; missing/modified/extra package files fail
verification; clean external Deno consumer; compiler/module/include identity
matches the selected 2.0-dev toolchain; required worker assets resolve outside
the producer checkout. Separate bootstrap acquisition from compilation:
bootstrap downloads/verifies assets; the installed or compiled CLI uses verified
local or embedded bytes. Missing/corrupt assets fail clearly. Test outside the
checkout with fresh caches, including cancellation followed by worker restart.

**Distribution decision:** the existing public compiler-only archive excludes
SDK implementation code. During implementation, prepare and verify this concrete
new bundle first, then obtain the explicit decision to publish SDK bytes before
uploading it or placing them in a public repository. If that decision is
deferred, the existing Python/Wasmtime driver can unblock repository generation,
but does not satisfy the Deno-only shipped-CLI goal. Record that reduced scope
explicitly.

### S2 — Make normal codegen run entirely inside Deno

**P0; compiler/codegen owner; 3–5 days; depends on S1.** Replace the native
process call with a compiler module that snapshots permitted files, maps logical
names, and returns request bytes. Preserve saved-request and stdin plugin modes,
config precedence, schema/flat layout, successive barrel merging, and
diagnostics. Bound traversal, file count, and bytes before constructing the
snapshot; define symlink handling and never scan an entire drive merely to
obtain a common root. Use the producer worker for real deadlines/cancellation; a
timer around synchronous guest execution cannot interrupt it.

Move normal task/install/compiled-binary paths off `--allow-run=capnp`. Migrate
RPC/schema generation and request fixtures to the pinned compiler host. The SDK
currently exposes compile/generate, not general `encode` commands: keep
developer fixture encoding/version probes on the existing verified
Python/Wasmtime driver, in a separate maintenance task. Do not expand the SDK
command interface just for fixture refresh or add process permission to normal
codegen. Stage generated output and validate destinations before publishing
files; define per-file atomic replacement and stale-file behavior without
promising whole-tree transactions.

**Acceptance:** existing CLI end-to-end/golden suite; full generated-output
review; ordered `-I` precedence and standard-import isolation; binary embeds;
spaces, Unicode, same-basename files, absolute paths, and Windows volumes;
resource-limit, timeout, cancellation, and recovery tests; no generated changes
on compiler/emitter failure. Installed and compiled CLIs work offline after
artifact acquisition, without native `capnp`, Wasmtime, or process permission.
Compiled worker/module embedding is a required platform test, not an assumption.

Preserve old 1.5.0 writer fixtures as compatibility oracles and add 2.0-dev
fixtures. The current request model ignores compiler/source-position metadata;
do not introduce version-specific parsing or lossless reflection without an
observed need. Full generics and composite defaults remain outside this ticket.

### S3 — Refresh and identify the runtime artifact

**P0; runtime owner; 2–3 days.** Advance capnp-zig to the surveyed current
commit (or a deliberately reviewed successor). Keep the submodule bump separate
from host behavior fixes. Use canonical `wasm-host` with explicit
`-Dwasm-optimize` and isolated build/cache output. Make the expected WASM output
unambiguous, pin optimization inputs, and generate a build receipt containing
source commit, Zig/Binaryen versions and flags, artifact hash, ABI range,
exports, and feature flags.

**Acceptance:** old-artifact/new-artifact real-test matrix; version/feature
negotiation failures remain explicit; clean rebuild matches the checked-in
artifact under the documented deterministic build configuration; package
preflight uses those exact bytes. Do not require capnp-wasm or its compiler to
load the ordinary runtime. Refresh RPC fixtures and schemas with independently
reviewed semantic versus metadata changes.

### S4 — Repair WASM allocation and error ownership

**P0; runtime owner; 2–3 days; can start immediately.** Make borrowed reads and
owned allocations explicit inside `WasmAbi`. Preserve the exact allocated or
returned length, including zero. Never free borrowed error text. Audit error
retrieval, scratch out-parameters, frame pops/commit, host-call frames, and peer
closure against the upstream contract. Keep original failures from being masked
by cleanup failures. Give persistent ABI/serde scratch an explicit disposal
path; distinguish peer, wrapper, and shared module ownership so disposing one
wrapper does not shut down others. Validate ABI compatibility before allocation
or unwind failed constructors. Replace the fake test that currently expects
borrowed error text to be freed.

**Acceptance:** real tests for zero-length buffers, error read/clear/reuse,
failed operations followed by valid operations, and repeated create/call/close
cycles on one module instance, including serde and multiple shared wrappers. A
soak of thousands of cycles exceeding the reproduced 512-cycle failure must keep
allocations available and exhibit no accumulating `InvalidFree` state. Run on
both bundled baseline and newly built runtime; retain existing fake tests for
host control flow. Land narrow upstream fixes only if a producer defect is
proved.

### S5 — Unify service and transport closure

**P1; lifecycle owner; 2–3 days; independent of compiler work.** Supervise
services through the existing closure-subscription interface. Remove
concrete-class knowledge where that contract suffices. Preserve compatibility
for transports without the optional subscription and document the corresponding
obligation. The service handle must own its subscription throughout active
service, then unsubscribe on terminal closure or failed initialization. Existing
code detaches the initialization observer immediately before returning an active
handle; merely changing the helper to call `subscribeClose` would miss later
closure again.
([Current detach](/Users/nullstyle/prj/local/capnp-deno/src/rpc/server/service.ts:1393))

**Acceptance:** actual custom and wrapped transports close the service handle,
runtime, and instance exactly once; close before/during an async factory
prevents activation and disposes late results; replay/unsubscribe races; local
MessagePort closure; direct TCP/WS/WebTransport cases; cancellation rejects
pending callers and releases callback capabilities; post-activation closure
works and no listeners remain after disposal. Do not claim that remote
MessagePort closure is detectable when its platform supplies no such event.

### S6 — Share framing evidence and automate native interoperability

**P1; integration owner; 3–4 days; uses S3/S5.** Consume the current capnp-zig
framing corpus by revision/hash and run it through Deno's independent framer and
wire path. Define Deno's default versus explicitly configured segment/message/
buffer limits rather than silently copying unrelated defaults. Extend existing
interop tests into a standing native Zig peer and matched C++ reference job.

**Acceptance:** common split/coalesced, multi-segment, truncated, overflow, and
limit cases; standard/legacy double-far structs and lists, empty-struct
presence, malformed nested pointers, evolved-list unknown-field retention,
strict text, and copy-budget behavior through both TS and WASM paths; external
old/new schema defaults; bidirectional generated unary RPC, callback and
returned capabilities, cancellation/Finish/Release, typed errors, and streaming
barriers. Assert cleanup as well as returned values. Native reference
compilers/generators must match their own runtime libraries; keep those
reference tools separate from normal Deno codegen.

Sources:
[upstream corpus](/Users/nullstyle/prj/zig/capnp-zig/tests/fixtures/framing/framing_fixtures.json),
[Deno framer](/Users/nullstyle/prj/local/capnp-deno/src/rpc/wire/framer.ts:164),
[current interop coverage](interop.md).

### S7 — Add byte-bounded streaming admission

**P1; RPC/codegen owner; 3–4 days; uses S2/S5/S6.** Current `StreamSender`
bounds call count only. Add an encoded-byte budget alongside that window, with
generated helpers supplying accurate encoded sizes and avoiding duplicate
serialization. Account for retained/in-flight data through acknowledgment or
cancellation and make oversized-item behavior explicit. Keep capacity waits and
sender stats consistent with both limits. Define server-side retained-input
admission as well; transport queue limits alone do not bound work retained by an
asynchronous handler.

**Acceptance:** mixed tiny/large messages respect call and byte budgets; a
single oversized item fails promptly; byte reservations are released on
error/cancel; slow handlers and delayed acknowledgments cannot grow retained
work without a bound; a following non-streaming call observes the expected
barrier; current callback/cancellation semantics and native interoperability
remain correct. Measure allocation/throughput against the existing streaming
benchmarks.

This requires Deno work. Upstream native streaming improvements are not exported
automatically by the WASM ABI. The first implementation task is to define the
accounting point and size measurement in the generated send path; do not
substitute an estimated byte count while documenting a hard exact-byte limit.
State whether the accounting includes framing and capability descriptors, and
test that exact definition against the bytes actually sent.
([Current options](/Users/nullstyle/prj/local/capnp-deno/src/rpc/session/streaming.ts:46))

### S8 — Make release artifacts prove themselves

**P0 release gate; release owner; 3–4 days; start scaffolding early, finish
last.** Add Linux/macOS/Windows execution for compiler CLI, runtime loading, and
isolated consumer smoke tests. Make fast verification non-mutating. Check
generation and artifact drift. Exercise the installed package's filtered
contents in a directory without the source checkout, vendor tree, or developer
caches.

**Acceptance:** execute representative native release binaries on each supported
OS, including Windows paths with spaces and binary stdin; verify all advertised
target artifacts or label compile-only targets explicitly. Test runtime and
compiler delivery independently. Every isolated runtime consumer must perform a
generated unary call plus a callback/error case, not merely import its WASM.
Keep published runtime imports dependency-clean. The tag workflow validates
exact tag/version and depends on required test, integrity, and consumer gates
before uploading assets. No CI token should need private-producer access once
the selected public delivery model is established. Run an explicit
browser/WebTransport lane when changing its lifecycle; record unsupported cases
instead of silently calling them tested.

## Sequence and landing plan

| Period | Compiler/release stream                                                          | Runtime/RPC stream                                            | Exit evidence                                                                          |
| ------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Week 1 | S1 package/decision; S2 workspace and request integration; S8 platform skeleton  | S4 ownership fixes; S3 reproducible runtime update; begin S5  | Verified compiler package locally, real host regressions green, pinned runtime receipt |
| Week 2 | Finish S2 installed/compiled CLI and generation parity; begin consumer packaging | Finish S5; S6 shared corpus/native peers; begin S7            | Native-free codegen and real lifecycle/interop gates                                   |
| Week 3 | S8 clean consumers and release gates; documentation and platform fixes           | Finish S7, cancellation/streaming interop and allocation soak | All required gates on exact release candidate; reviewable release artifacts            |

Use scoped Conventional Commits. Keep host fixes, submodule advance, compiler
integration, and regenerated artifacts reviewable as separate landing units, per
the repository's guidance. Preserve the existing user `mise.toml` addition and
`.zcode/` work. Update the stale prerequisites, ABI/additions guide, and release
checklist as part of the relevant ticket rather than creating another obsolete
roadmap.

## Completion criteria and scope control

The sprint is complete when a clean consumer can generate TypeScript with the
pinned 2.0-dev compiler, run that output with the identified current Zig
runtime, exercise lifecycle and byte limits, and reproduce the result on all
three supported operating systems. Required compiler/runtime tests must fail
when their artifacts are absent or invalid; browser availability remains
explicitly scoped.

Keep existing interop/performance gates and add meaningful allocation, compiler
cold/warm, and byte-window measurements. Do not spend the sprint re-creating
existing benchmarks or raising the Deno version merely because the producer uses
a newer one: the compiler spike already works on 2.6.8. A Deno bump needs a
specific required feature or a separate runtime/browser compatibility result.

If time runs short, a reduced release milestone may defer S7 as a named
follow-on while still completing compiler delivery, runtime ownership, closure,
interop, and release gates. That milestone must omit byte-limit feature claims
and is not full completion of this sprint. Do not cut the new regression tests
or public-package verification to fit the date.

Follow-on candidates: cross-file nested type exports (currently rejected),
non-null struct/list defaults, generic brands, richer reflection/source
metadata, and expanded L3/L4 host interfaces. Each needs its own observable
consumer benefit; none is a prerequisite for adopting the surveyed
compiler/runtime revisions.
