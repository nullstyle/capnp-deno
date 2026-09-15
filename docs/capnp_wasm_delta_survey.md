# capnp-wasm delta survey

Surveyed 2026-09-15 UTC. This is planning evidence, not an implementation
change.

## Baseline and conclusion

capnp-deno is at `24ccd29` (2026-09-08); its last capnp-zig vendor bump was
`1889392` (2026-08-15), pinning `ae1ef92cf54761b8fbb46a8fb0bcd90a2bd80e50`. The
capnp-wasm checkout is at `0c45c08aa7a836a09e2d715f790823288769b04c`. Its
remote/project/package name is **capnpc-wasm** despite the local directory name.
These revisions were read from the local Git histories and gitlinks.

**Use capnp-wasm as capnp-deno's schema compiler frontend. Keep capnp-deno's
TypeScript generator and its capnp-zig-backed serialization/RPC runtime.**
capnp-wasm ports synchronous command tools; it explicitly does not port KJ's
asynchronous I/O or RPC libraries. Its generator targets are C++, Rust, Go, and
Zig, not TypeScript. capnp-deno already has a clean binary request boundary at
which to integrate it.
([Port scope](/Users/nullstyle/prj/local/capnp-wasm/patches/capnproto/README.md:47),
[SDK targets](/Users/nullstyle/prj/local/capnp-wasm/sdk/typescript/mod.ts:30),
[Deno compile boundary](/Users/nullstyle/prj/local/capnp-deno/tools/capnpc-deno/main.ts:31))

The recommended sprint outcome is **Deno-only schema generation with no native
`capnp` or Wasmtime subprocess**, backed by a verified, producer-owned compiler
host package. A separate publication decision is required before publicly
shipping SDK implementation bytes; prior compiler-only publication does not
cover those bytes.

## What arrived since the vendor bump

All capnp-wasm implementation history begins on September 8, after the August 15
vendor bump. Relevant commits, as recorded by local Git:

| Commit    | Implemented capability relevant to capnp-deno                                       |
| --------- | ----------------------------------------------------------------------------------- |
| `ffd8aa5` | WASI Cap'n Proto compiler and command generators; native request/output comparisons |
| `a180f06` | In-memory TypeScript/Deno/browser and Go compiler hosts                             |
| `f727fca` | Generate from saved requests; browser engine verification                           |
| `dc8a490` | capnp-zig generator/runtime integration across hosts                                |
| `ac9b91e` | Resource limits and externally consumable package verification                      |
| `41037ae` | Updated browser engines and repeated worker cancellation/recovery tests             |
| `a2326f6` | Schema Studio, demonstrating multi-file browser compilation and output downloads    |
| `0c45c08` | Pinned Wasmtime launcher and compiler-only toolchain archive                        |

These are implemented features, not roadmap items. SDK registry publication,
signing, and a stable SDK interface remain future release actions in current
producer documentation. Some release-evidence prose is historical; in particular
the statement that both archives remain private predates the compiler-only
publication below.
([SDK implementation](/Users/nullstyle/prj/local/capnp-wasm/sdk/typescript/mod.ts:138),
[release status](/Users/nullstyle/prj/local/capnp-wasm/docs/releases.md:1),
[archive publication caveat](/Users/nullstyle/prj/local/capnp-wasm/docs/releases.md:77))

## Compiler artifact and delivery

capnp-zig's new `c30abbb` toolchain pins the same compiler-only archive used by
SLCP. The public GitHub release was checked through `gh release view` during
this survey: it is an uploaded, non-draft prerelease, with a 908,300-byte
archive. The private producer repository was independently confirmed with
`gh repo view nullstyle/capnpc-wasm --json isPrivate`.
([Public release](https://github.com/nullstyle/slcp-zig/releases/tag/capnp-wasm-tools-v0.1.0-rc.2),
[consumer pin](/Users/nullstyle/prj/zig/capnp-zig/tools/capnp-toolchain.json:1))

| Identity                             | Pinned value                                                       |
| ------------------------------------ | ------------------------------------------------------------------ |
| Package                              | `capnp-wasm-tools-0.1.0-rc.2.tgz`                                  |
| Compiler                             | Cap'n Proto `2.0-dev`                                              |
| Upstream compiler revision           | `851c45bb39c34c3f20f9d9ebe9f34a7e39109b6f`                         |
| Producer revision                    | `0c45c08aa7a836a09e2d715f790823288769b04c`                         |
| Archive SHA-256                      | `84f6dd426dd0e94dd5d7fd3dd0e9390e84905ac4b5e6957af57788967e5065f4` |
| Compiler SHA-256                     | `5429b7277b18b6e3f65430068ac41ac327ef8dd359603955f16ec576e0c3a14a` |
| Wasmtime, when using external driver | `48.0.1`                                                           |

The producer gitlink fixes the upstream revision; capnp-zig's pin additionally
fixes the manifest and include-tree hashes. The survey's local compiler module
hash matched the consumer pin.
([Upstream port pin](/Users/nullstyle/prj/local/capnp-wasm/patches/capnproto/README.md:3),
[all consumer hashes](/Users/nullstyle/prj/zig/capnp-zig/tools/capnp-toolchain.json:1),
[runtime pin](/Users/nullstyle/prj/zig/capnp-zig/mise.toml:7))

The archive includes compiler, schemas, launcher, licenses, and provenance. It
**omits SDK implementations and all generator modules**. It can serve public CI
today, but by itself cannot provide Deno in-process compilation. The complete
private candidate includes a dependency-free ESM bundle, declarations, worker,
all six command modules, and Go SDK. Importing raw SDK source instead would pull
in `ref/browser_wasi_shim`; consumers should receive the built bundle.
([Archive split](/Users/nullstyle/prj/local/capnp-wasm/docs/releases.md:77),
[bundle contract](/Users/nullstyle/prj/local/capnp-wasm/docs/releases.md:86),
[raw source imports](/Users/nullstyle/prj/local/capnp-wasm/sdk/typescript/runtime.ts:4))

**Smallest recommended new producer package:** the existing compiler and
includes, `typescript/mod.js`, `mod.d.ts`, `worker.js`, required
third-party/project licenses, and the existing integrity/provenance verifier.
Omit C++/Rust/Go/Zig/schema-printer generator modules and the Go SDK. Keep it
producer-owned; do not copy the WASI shim into capnp-deno as an independently
maintained runtime. This package is a proposal, not an existing release flavor.
Reuse reproducible staging and complete inventory verification from the existing
packager.
([Packager exports](/Users/nullstyle/prj/local/capnp-wasm/scripts/release.ts:103),
[provenance](/Users/nullstyle/prj/local/capnp-wasm/scripts/release.ts:153))

Publication gate: prepare and verify this package and the capnp-deno integration
locally, then request the explicit SDK-publication decision before uploading it
or committing SDK bytes to a public repository. If publication is deferred, the
already public compiler archive plus capnp-zig's portable Python/Wasmtime driver
is a viable repository tooling stage; it does not meet the Deno-only
distribution goal. Do not add a silent native-compiler fallback.

## In-process integration is already feasible

`createCompiler({ compiler: bytes, generators: {} })` followed by
`compile({ files, includeFiles, entrypoints, generators: [] })` returns the
standard unpacked `CodeGeneratorRequest`. Feed `result.request` into the
existing `parseCodeGeneratorRequest` and `generateTypescriptFiles`. Request-file
and stdin plugin modes already bypass native compilation and can remain
supported.
([SDK compile](/Users/nullstyle/prj/local/capnp-wasm/sdk/typescript/mod.ts:147),
[Deno request modes](/Users/nullstyle/prj/local/capnp-deno/tools/capnpc-deno/main.ts:97),
[Deno emitter](/Users/nullstyle/prj/local/capnp-deno/tools/capnpc-deno/emitter.ts:47))

The SDK snapshots byte-oriented inputs, exposes a read-only memory filesystem,
starts fresh guest instances, preserves diagnostic text/stage/exit status, and
bounds guest memory, workspace, requests, and output. The direct API blocks the
calling JavaScript thread while executing. The worker API has a 30-second
default deadline, terminates execution on cancellation, and restarts for the
next request. A CLI timeout must use a worker; wrapping the direct promise in a
timer cannot interrupt the guest.
([Command isolation](/Users/nullstyle/prj/local/capnp-wasm/sdk/typescript/runtime.ts:172),
[limits](/Users/nullstyle/prj/local/capnp-wasm/sdk/typescript/types.ts:1),
[worker cancellation](/Users/nullstyle/prj/local/capnp-wasm/sdk/typescript/worker-client.ts:62),
[deadline](/Users/nullstyle/prj/local/capnp-wasm/sdk/typescript/worker-client.ts:137))

The adapter still needs real design work: disk files and ordered `-I` roots must
be snapshotted into canonical relative POSIX paths; binary embeds must stay
bytes; colliding include names need explicit first-match semantics; generated
filenames and cross-file imports must preserve current CLI layout behavior. The
SDK uses one `/src` and `/include` namespace and deliberately does not discover
files or access the host filesystem. Its virtual filesystem avoids the external
driver's same-volume restriction once files have been loaded.
([Workspace contract](/Users/nullstyle/prj/local/capnp-wasm/sdk/typescript/README.md:76),
[current path handling](/Users/nullstyle/prj/local/capnp-deno/tools/capnpc-deno/cli.ts:584),
[external-driver restriction](/Users/nullstyle/prj/zig/capnp-zig/docs/capnp-wasm-toolchain.md:50))

## Survey probes: actual compatibility evidence

Two disposable probes were run without editing source, dependency pins, or
generated output. Scripts remain at `/tmp/capnp-deno-wasm-survey.ts` and
`/tmp/capnp-deno-wasm-parity-survey.ts`; they are survey evidence, not committed
acceptance tests.

1. Loaded the built SDK and pinned compiler, supplied current capnp-deno
   fixtures and producer includes as bytes, revoked read permission, and
   compiled with no process/network permission. The unchanged Deno
   parser/emitter succeeded for Person, unions/groups, three cross-file schemas,
   evolution defaults, and streaming. Both existing non-null struct/list default
   fixtures were rejected with their expected explicit unsupported-default
   errors.
2. Compared the complete emitted path/content pairs for those five successful
   jobs against `/opt/homebrew/bin/capnp` **1.5.0** and the producer's native
   **2.0-dev**. All **14 TypeScript/metadata output files matched byte for
   byte** for both native versions and WASM. Native cwd and SDK workspace gave
   the same requested filenames; no generated-source normalization was needed.
   Binary requests themselves differ across compiler versions.

Exact commands, with each `mise exec` launched from the specified repository:

```sh
# From capnp-deno (Deno 2.6.8) and again from capnp-wasm (Deno 2.9.6):
mise exec -- deno run --no-config --no-prompt --allow-read \
  /tmp/capnp-deno-wasm-survey.ts

# From capnp-deno, Deno 2.6.8:
mise exec -- deno run --no-config --no-prompt --allow-read \
  --allow-run=/opt/homebrew/bin/capnp,/Users/nullstyle/prj/local/capnp-wasm/build/native/bin/capnp \
  /tmp/capnp-deno-wasm-parity-survey.ts
```

This establishes frontend/parser/emitter compatibility for those fixtures on
macOS arm64. It does not establish complete generated API parity, all-platform
CLI packaging, worker support in standalone executables, or RPC ABI
compatibility. capnp-deno's request model currently drops compiler version,
source information, and node byte ranges; richer 2.0-dev metadata therefore does
not automatically appear in its `_meta.ts` output. Adding lossless reflection
would be separate feature work.
([Parser model](/Users/nullstyle/prj/local/capnp-deno/tools/capnpc-deno/request_parser.ts:27),
[modeled node fields](/Users/nullstyle/prj/local/capnp-deno/tools/capnpc-deno/model.ts:27))

## Proposed compiler workstream

Estimates are engineering-day planning ranges, not measured delivery dates.

| Order | Deliverable                                                                                               | Effort / main risk                            | Required acceptance                                                                                                                                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Producer-owned minimal compiler-host package and pinned consumer bootstrap                                | 1–2 days; SDK distribution decision           | Reproducible archive, clean source/ref hashes, complete inventory/tamper tests, external Deno consumer, public-delivery decision recorded                                                                                             |
| 2     | Deno compiler adapter and workspace mapping behind existing binary request boundary                       | 2–3 days; include precedence and filenames    | Existing CLI modes/config/layout/barrel behavior retained; imports, embeds, spaces, Unicode, same-basename files, explicit includes, denied paths, compile diagnostics                                                                |
| 3     | Worker timeout/cancellation plus bounded output publication                                               | 1–2 days; worker packaging and partial writes | Active guest really terminates; reuse after failure; no emitted output on compile/generator failure; resource-limit diagnostics; existing output protected before publish                                                             |
| 4     | Remove native compiler requirements from normal CLI, tasks, install/compile/release paths, and codegen CI | 1–2 days; standalone assets/Windows           | Installed and standalone CLI work on Linux/macOS/Windows without `capnp` on PATH or process/network permission; cached/offline generation; plugin stdin and saved-request modes still pass                                            |
| 5     | Full compiler-generation drift and compatibility gate                                                     | 1–2 days; unsupported schema corners          | Compare all existing goldens and generated APIs, preserve explicit unsupported-feature errors, add cross-version request fixtures and current 2.0-dev corpus coverage; keep native tools only as independent interoperability oracles |

Likely compiler-path total: **6–11 engineering days**, with package work and
test fixture expansion partly parallelizable. This fits alongside the separate
capnp-zig runtime/toolchain uplift. The immediate integration inventory includes
`main.ts`, Deno task permissions, standalone binary build flags, native-plugin
Just recipes, compiler-dependent tests, and repeated native package installation
in CI.
([CLI](/Users/nullstyle/prj/local/capnp-deno/tools/capnpc-deno/main.ts:45),
[tasks](/Users/nullstyle/prj/local/capnp-deno/deno.json:39),
[compiled permissions](/Users/nullstyle/prj/local/capnp-deno/scripts/build_capnpc_deno_binary.sh:16),
[Just plugin recipes](/Users/nullstyle/prj/local/capnp-deno/Justfile:156),
[CI bootstrap](/Users/nullstyle/prj/local/capnp-deno/.github/workflows/ci.yml:27))
