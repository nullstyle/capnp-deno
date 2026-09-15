# capnp-deno modernization sprint

Survey date: 2026-09-15 UTC. Delivery update: 2026-09-15 UTC. The compiler,
runtime, and RPC migration is implemented on `main`. The historical survey below
preserves the original findings and counts. Companion evidence:
[capnp-wasm survey](capnp_wasm_delta_survey.md).

## Delivery status

| Area                            | Delivered                                                                                                                             | Acceptance evidence                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| S1 — Compiler host              | Public compiler-host `0.1.0-rc.3`, exact inventory/provenance pins, bounded worker, ordered roots and source-prefix parity            | Verified public download, producer package consumers and native/browser compiler parity                                             |
| S2 — Deno compiler integration  | Bounded reachable-file snapshot, read/write-only source CLI, preserved request/stdin/layout modes, staged output                      | Compiler and CLI regressions, installed/standalone execution on five native targets; cold/warm baseline                             |
| S3 — Runtime identity           | Current capnp-zig revision, isolated canonical `wasm-host` rebuild, exact Zig/Binaryen pins, WASM provenance receipt                  | Clean hosted Linux rebuild matches checked-in bytes; package consumers use that artifact                                            |
| S4 — WASM ownership             | Exact-length frees, borrowed error handling, wrapper/serde scratch disposal, shared-instance recovery                                 | Real ownership tests on five native targets, including 2,000-cycle soaks                                                            |
| S5 — Service lifecycle          | Full-lifetime close subscriptions, initialization-race cleanup, exact-once disposal, custom/wrapped/local MessagePort coverage        | Socket and real-runtime suites on all five targets, mandatory browser WebTransport                                                  |
| S6 — Wire and native interop    | Framing corpus, TS/WASM copy checks, standing Zig/C++ matrix, bootstrap and cancellation corrections                                  | Four caller/server directions with callbacks, returned capabilities, Finish/Release, cancellation, recovery, and streaming barriers |
| S7 — Streaming admission        | Exact encoded-byte admission, one preparation candidate, callback rollback, ordinary-call barriers, retained Call-frame budget        | Behavioral regressions, paired throughput baseline, serialized allocation and retention measurements                                |
| S8 — Consumer and release gates | Shared CI/release validation, exact tag/version gate, five native binary targets, package/executable receipts, browser and benchmarks | Hosted native consumers, binary stdin, installation/tampered receipt rejection, and shared required gates                           |

The package version remains `0.5.0`; no runtime package release is announced.
The public compiler-host archive is a separately authorized toolchain release.

### Hosted evidence

[capnp-deno validation run 34936521133](https://github.com/nullstyle/capnp-deno/actions/runs/34936521133)
passed every required lane at `f0846ae`: source verification, all five native
targets, browser WebTransport, benchmark regression/comparison, clean Linux
runtime rebuilding, and the four-way native matrix. The final audit then added
release-tag rejection, expanded copy and native cancellation regressions, and
recorded measurements; these use the same standing validation workflow.

[capnp-zig validation run 34934160680](https://github.com/nullstyle/capnp-zig/actions/runs/34934160680)
passed all 25 jobs at the pinned runtime source `0c5e33f`. The compiler archive
remains pinned to producer source `a5ccaae`; later producer commit `672679a`
changes only CI installation of Deno outside the project to preserve its
lockfile.

### Local evidence after implementation

- Full verification passes formatting, lint, type checking, artifact receipts,
  RPC generation drift, and **1,177 unit tests**. Compiler acceptance passes
  **24/24**; isolated runtime-package and install/use/uninstall consumers pass.
  The complete fast benchmarks and **10/10** regression checks pass.

- Compiler-host rc.3 verification passed on Deno 2.6.8 for workers and on the
  producer's Deno 2.9.6 direct/rejection path. Real non-yielding worker probes
  established the two-second engine termination grace and per-client 2.1-second
  restart delay. Source compiler execution therefore enforces exactly Deno
  2.6.8; the earlier successful 2.9.6 smoke did not establish cancellation.
- Source CLI end-to-end checks passed 7/7 without granting the compiler child
  network or process access. RPC schema output matches fresh WASM generation.
  The local standalone compiler passed its outside-checkout, empty-PATH/cache,
  imported-schema/embed and binary-stdin probe. Isolated install/use/uninstall
  and fresh generated-output parity for four examples, positive crossfile
  fixtures, and the interop matrix passed. The saved 1.3 and new 2.0-dev
  requests produce identical TypeScript output.
- The runtime ownership tests cover 2,000 peer-wrapper cycles and 2,000 serde
  cycles, including another live shared-module user and memory growth.
- After the bootstrap fix, the real-WASM suite passed **43/43**, socket
  integration **33/33**, and browser WebTransport **1/1**. The focused
  callback-grant regressions cover late replies, timeout, failed writes,
  reference multiplicity, and bounded admission. These are local macOS arm64
  results.
- Native Zig ↔ Deno over framed pipes and native C++ ↔ Deno over TCP passed both
  fixture-update and normal drift-check runs. The matrix includes unary calls,
  callbacks, returned capabilities after parent Finish, typed failure and
  recovery, delayed streaming barriers, and cleanup. C++ eagerly pipelines its
  first call through bootstrap. The native receipt records matching source and
  schema/request identities in `.capnp-cache/native-interop/last-success.json`.
- Paired generated-serializer benchmarks measured **40.0 µs** count-only and
  **49.1 µs** byte-bounded for 32 immediate calls on an M5 Max / Deno 2.6.8.
  This is a local bookkeeping-cost comparison, not a network throughput claim.
- Reusable workflow files pass `actionlint` 1.7.12 (including shellcheck) and
  formatting. The exact tag/version gate also has positive and negative CLI
  checks plus maintained unit regressions.

### Current responsibilities

| Component                      | Responsibility                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| capnp-wasm compiler host       | Compile schema snapshots to `CodeGeneratorRequest` with pinned Cap'n Proto 2.0-dev and bounded worker execution |
| capnpc-deno                    | Resolve permitted files and CLI semantics, invoke the verified host, parse requests, and emit TypeScript        |
| capnp-deno + capnp-zig runtime | TypeScript codecs, sessions, services and transports plus the independently pinned Zig WASM peer                |

Current versions and hashes live in
[the compiler pin](../tools/compiler_toolchain.json) and
[runtime pin](../tools/runtime-toolchain.json), with build output identity in
[the runtime receipt](../generated/capnp_deno.provenance.json). See
[Toolchains and artifact delivery](toolchains.md) for actual commands,
permissions, and engine constraints.

The original proposal estimated a three-week sprint with two workstreams and
22–32 engineering days. That estimate is historical; the sections below record
what was delivered and the validation scope.

## Historical survey findings

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

### Checks run before implementation

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
commands and limits are recorded in the companion survey. The ownership,
service-close, and compiler probes now have maintained regressions described in
the delivery record below.

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

## Delivery record

### S1 — Verified compiler-host delivery

The selected public package contains the compiler, standard schemas, built
TypeScript host/worker/declarations, licenses, and integrity/provenance data. It
does not ship the Go SDK or other language generator implementations. The public
archive and exact package identities are pinned in capnp-deno. Acquisition and
verification are separate from offline schema compilation.

Worker cancellation uses the verified Deno 2.6.8 engine contract. Each client
waits beyond the engine termination grace before restarting; unsupported Deno
versions fail before bounded execution. The producer's package checks also cover
native request parity, roots/prefixes, imports, embeds, corruption, and external
consumers. Producer compiler browser checks cover Chromium, Firefox, and WebKit;
Deno's application transport browser lane uses Chromium. Producer Studio UI
checks are separate from compiler acceptance.

### S2 — Deno compiler/workspace integration

`tools/capnpc-deno/compiler.ts` runs the verified host in a worker.
`workspace.ts` snapshots reachable schema/import/embed files, preserves ordered
roots and prefixes, and enforces path/entry/byte limits. It reads explicit files
under Deno's permissions; `--src` discovery is separately bounded and skips
symlink entries. Output validation/staging preserves existing files on compiler
or emitter failure, with per-file replacement rather than a whole-tree
transaction guarantee.

Normal source generation grants only read/write permission. Saved requests,
binary stdin/plugin responses, config, schema/flat layout, and barrel behavior
remain supported. The saved multi-schema request is from compiler 1.3; evolution
writer fixtures remain on 1.5.0. These are compatibility evidence alongside a
separately identified current 2.0-dev request. Native encode/version fixture
maintenance stays behind separate verified Python/Wasmtime tasks.

Standalone delivery embeds the verified assets and engine; source compilation
and compiled delivery share the same pin. Generated-output parity, compatibility
fixtures, isolated package consumers, and standalone/install checks pass on all
five native targets.
[Cold and warm compiler measurements](benchmarks/compiler_baseline.md) record
fresh-worker and reused-worker costs, with request digests and explicit timing
boundaries.

### S3 — Runtime refresh and provenance

The vendored runtime now includes the reviewed native ordinary-call
error-recovery fix discovered during interop. The canonical `wasm-host` build
uses pinned ReleaseSmall/Binaryen settings in isolated output and records
source, tool versions, optimization, hash, ABI range, exports, and features.
`check:wasm` and `check:wasm-rebuild` verify artifact identity and
reproducibility. The compiler host remains independent of ordinary runtime
loading.

### S4 — WASM ownership

Borrowed error strings are read without freeing their backing storage. Owned
outputs preserve exact free lengths, including zero. ABI and serde wrapper
scratch allocations have explicit disposal; closing one wrapper preserves other
users of the shared module. Maintained real tests exercise failures, recovery,
shared users, and thousands of create/use/close cycles.

### S5 — Service closure

Service handles retain their close subscription for the full active lifetime,
then detach it on terminal closure or initialization failure. Regressions cover
custom/wrapped transports, asynchronous factory races, replay/unsubscribe,
exact-once disposal, and local MessagePort closure. Remote MessagePort closure
is not advertised where the platform provides no event.

Replies prepared before bridge closure are suppressed. Retained parameter-cap
ownership survives handler and middleware exceptions. Both clients keep bounded
per-question callback records after abort, timeout, or a write that may have
reached the peer; the first terminal reply settles those grants once. The new
`maxOutstandingParamCapQuestions` option defaults to 4,096, while cap-free calls
and control traffic remain available. Explicit Release messages and independent
references retain their existing semantics. See [Streaming RPC](streaming.md).

### S6 — Wire and native interoperability

The shared framing corpus is pinned by revision/hash and checked through Deno's
independent framing path. TS wire copying and text handling now cover the
observed double-far, empty-struct, malformed pointer, UTF-8/NUL, and copy-budget
gaps. The standing native runner builds source-matched Zig and C++ references
and checks generated fixture drift.

Native testing exposed defects in both implementations. Zig's generated server
made an ordinary failed call poison later streaming work. Deno lacked bootstrap
answers already produced by WASM, ignored modern Finish cancellation, omitted
terminal replies for canceled host calls, and rejected valid native
`Return(canceled)` messages. Maintained regressions now exercise each
correction.

Deno mirrors the actual bootstrap Return before host dispatch, accounts repeated
grants/answer holds, and closes on answer-table overflow. Canceled native calls
receive one terminal reply and release their callback grant once; a subsequent
call succeeds on the same connection. Native error tests respect the host's
public exception-disclosure policy.

The four-way matrix has passed locally and on hosted Linux. Its cancellation
extension checks actual pending calls, callback cleanup, and recovery; native
Zig's deferred server does not expose a handler-cancellation callback, so that
direction checks late-result cleanup instead of claiming cooperative abort.
Multi-party RPC, native Zig socket coverage, and full generic support remain
outside this matrix's claims.

Real WASM tests now exercise evolved-field copying, result capability routing
and Finish cleanup, and rejection of cyclic/amplified/malformed copies without
settling the call or prematurely releasing parameter grants. The TS reader now
rejects nonzero-offset double-far struct tags, matching WASM's untyped clone.
Native typed legacy-list decoding is not exposed through that ABI; historical
Layout A lists are rejected rather than silently interpreted as structs.

### S7 — Exact byte admission

Generated helpers serialize each item once and reserve its parameter-message
length before a transport assigns a question. This includes the parameter
segment table and excludes RPC envelopes, capability metadata, transport queues,
and producer-owned input. One encoded preparation candidate may wait outside the
admitted budget; stats report it separately. Abort/rejection before question
ownership rolls back new callback exports.

Server input admission separately counts full Call-frame bytes retained by
unfinished dispatches. Finish/Release control traffic still runs; a canceled
handler retains its charge until it actually settles. Pipelined child waits are
abortable even if the parent handler ignores cancellation. Generated ordinary
methods wait for accepted streaming handlers before running. These contracts and
their limits are documented in [Streaming RPC](streaming.md).

The
[streaming allocation measurement](performance.md#generated-stream-buffer-measurements)
records exactly one final parameter-buffer allocation per call in both modes.
With the same 1,024-item workload and delayed acknowledgments, a 192-byte window
reduces peak transport retention from 768 to 192 bytes, plus one 24-byte
preparation candidate. All retained buffers and byte charges drain to zero. The
smaller window intentionally reduces concurrency; its throughput is not an
estimate of bookkeeping overhead. The immediate-ack paired benchmark above
provides that separate comparison.

### S8 — Validation before publication

CI and release call one reusable workflow. Each native Linux x86_64/arm64, macOS
x86_64/arm64, and Windows x86_64 row runs compiler/runtime/package checks,
compiles its own executable, executes its isolated-consumer checks, and uploads
that binary plus provenance. Release publication depends on the entire shared
validation result at the tag's commit and downloads only those tested assets.
Before those builds, the tag must exactly equal `v` plus the `deno.json`
version; a mismatch fails before shared validation or asset publication.

Separate required lanes cover a clean Linux runtime rebuild, native interop,
browser WebTransport, and existing benchmark budgets/comparison. Unit tests are
not rerun solely to produce a second coverage pass. Successful main runs supply
benchmark baselines only after comparison succeeds.

## Completion and remaining scope

The compiler and runtime consumers are exercised independently with pinned
artifacts. Required tests fail when those artifacts are absent or invalid.
Native binaries execute on Linux x86_64/arm64, macOS x86_64/arm64, and Windows
x86_64; the mandatory browser lane is separate. Scope and engine constraints are
recorded in [Toolchains and artifact delivery](toolchains.md), including exact
Deno 2.6.8 compiler support and the Windows WebTransport IPv6 endpoint
requirement.

Review release notes and select a runtime package version before tagging a
future release. The sprint does not publish that package. The original user
`mise.toml` addition and `.zcode/` work remain uncommitted.

Follow-on candidates remain cross-file nested type exports, non-null struct/list
defaults, generic brands, richer reflection/source metadata, and expanded L3/L4
host interfaces. The migration does not claim those features.
