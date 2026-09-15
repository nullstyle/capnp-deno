# Toolchains and artifact delivery

capnp-deno has two independent WASM artifacts. Updating one does not replace the
other.

| Artifact                 | Purpose                                                                              | Identity and delivery                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| capnp-wasm compiler host | Compile `.capnp` sources to binary `CodeGeneratorRequest` for the TypeScript emitter | `tools/compiler_toolchain.json`; fetched into `.capnp-cache/compiler-host/package` or embedded in a standalone compiler |
| capnp-zig runtime        | Run RPC peer and low-level serde operations used by `@nullstyle/capnp`               | `tools/runtime-toolchain.json`; checked-in `generated/capnp_deno.wasm` and `generated/capnp_deno.provenance.json`       |

The published runtime uses Deno 2.6+ and contains no compiler host dependency.
Runtime imports resolve the packaged WASM directly; they do not download or
build a compiler.

## Versions and worker cancellation

Source schema compilation and compiler builds require **exactly Deno 2.6.8**.
Use `mise exec -- deno` in this checkout. The compiler-host package is currently
`0.1.0-rc.3`, built around Cap'n Proto 2.0-dev. The
[compiler pin](../tools/compiler_toolchain.json) is authoritative for the public
archive URL, producer revision, compiler revision, byte length, and SHA-256
identities; avoid maintaining copies of its hashes in instructions.

The exact Deno requirement follows a real non-yielding WASM worker test. Deno
2.6.8 allows a **two-second engine termination grace** after termination is
requested. The host rejects a timed-out or canceled job, then waits **2.1
seconds per compiler client** before starting a replacement worker. A rejected
promise is not proof that guest execution stopped immediately. This restart
spacing prevents that client from accumulating still-running workers during the
engine grace; it is not a global bound across independent compiler clients.
Other Deno versions fail before bounded worker compilation begins until their
termination behavior is verified. The normal runtime has no compiler-worker
version restriction.

A reusable compiler accepts one active job at a time. Its timeout covers both
workspace acquisition and guest execution. Call `dispose()` after the last job;
it cancels outstanding work and releases worker resources. Direct synchronous
compiler execution in the producer SDK has a different interruption contract and
is not capnpc-deno's bounded compilation path.

## Acquire once, compile offline

From the repository root:

```sh
mise exec -- deno task compiler:fetch
mise exec -- deno task check:compiler
mise exec -- deno task codegen generate --schema schema/example.capnp --out generated
```

`compiler:fetch` is the network step. It downloads the public archive identified
by the pin and verifies package membership, manifest, provenance, compiler, and
standard includes. Changed, missing, or unexpected files fail verification. The
producer checkout may remain private; consumers and CI fetch the pinned public
compiler-host release without private repository credentials.

After acquisition, normal source codegen uses only `--allow-read --allow-write`.
It does not invoke PATH `capnp`, Wasmtime, Python, or Zig, and does not require
network or subprocess permission. The worker receives a bounded snapshot of
explicit source/import roots. File traversal, bytes, imports, embeds, guest
memory, and output have limits. Ordered `-I` roots and source-prefix behavior
are preserved. Explicit schema/import files follow the host filesystem's symlink
behavior under Deno read permissions; `--src` discovery skips symlink entries.
The snapshot follows reachable import/embed dependencies rather than recursively
copying a common ancestor or drive. Invalid virtual paths and non-regular files
fail explicitly.

The compiler returns request bytes to the existing parser/emitter. The same
emitter also accepts saved `--request-bin` input and binary stdin in plugin
mode. Saved requests from older compilers remain compatibility fixtures: the
multi-schema request is from 1.3, while the evolution writer fixtures are from
1.5.0. Current 2.0-dev requests have separate provenance. Ordinary schema
compilation uses the pinned 2.0-dev frontend.

## Installed and standalone compiler

Build and verify the host-native executable:

```sh
mise exec -- deno task codegen:compile
mise exec -- deno task check:compiler-binary
```

The default output is `dist/capnpc-deno`, or `dist/capnpc-deno.exe` on Windows.
`codegen:compile <target> <output>` supports explicit targets. Compiler builds
embed the compiler, worker, standard includes, and pin; a neighboring
`<output>.provenance.json` identifies the executable bytes and build inputs. The
executable carries its Deno runtime. Running it needs neither a source checkout
nor a separate Deno installation or compiler cache.

`codegen:install` installs the compiled command; `codegen:uninstall` removes it.
`check:compiler-install` verifies installation, execution outside the checkout,
and removal in an isolated install root. Build/install tasks need subprocess
permission to run Deno itself. That is separate from ordinary compilation by the
installed binary. The binary's schema job uses its embedded assets and
read/write permissions.

`check:compiler-binary` verifies the receipt and runs the actual native binary
in a fresh directory with spaces, an empty PATH/cache, imported schemas, binary
embeds, and binary stdin. A successful cross-compilation alone is insufficient
release evidence. See
[current delivery status](modernization_sprint.md#delivery-status) for checks
still in progress.

## Reproduce the runtime artifact

```sh
mise exec -- deno task check:wasm
mise exec -- deno task build:wasm
mise exec -- deno task check:wasm-rebuild
mise exec -- deno task test:real
```

`check:wasm` validates the checked-in runtime receipt. Rebuilding requires the
clean source revision, Zig version, Binaryen version, optimization mode, and
flags in [the runtime pin](../tools/runtime-toolchain.json). The canonical Zig
step is `wasm-host`. Build outputs use isolated staging; successful builds write
the WASM and receipt together. An optional `CAPNPC_ZIG_ROOT` path must identify
that same pinned clean revision.

`check:wasm-rebuild` compares an isolated clean rebuild with the checked-in
artifact. Runtime users and ordinary tests can use the checked-in artifact
without running native build tools. Preserve separate commits for source
revision advances, host behavior changes, and artifact receipts.

## Native reference and fixture maintenance

Normal codegen does not require an official native `capnp` executable. The
optional local `test:native-interop` task builds source-matched Zig and C++
reference peers from the pinned vendor tree; it is a required Linux validation
lane in CI. It needs Zig, CMake, and a C++23 compiler and standard library. The
Ubuntu lane probes Clang 18 with GCC 14’s standard library, matching the
capnp-zig native oracle lane. Its C++ compiler, generator, headers, and
libraries come from the same source revision.

Maintenance-only fixture encoding/version operations use the verified
Python/Wasmtime driver because they are outside the compiler host's
compile-to-request API. Use `compiler:maintenance:fetch` and `fixtures:codegen`
for those fixtures. Keep these permissions and dependencies in maintenance
tasks. Do not add them to source generation or runtime loading.

## Validation and publication

[The reusable validation workflow](../.github/workflows/validation.yml) is
called by both CI and tagged releases at the triggering commit. It includes:

- non-mutating verification and generated/runtime integrity;
- compiler API/CLI, package consumers, socket and real-WASM tests on five native
  targets: Linux x86_64/arm64, macOS x86_64/arm64, and Windows x86_64;
- native compiler build, receipt check, and isolated executable tests on each
  corresponding host;
- a clean Linux runtime rebuild plus native Zig/C++ interop;
- mandatory browser WebTransport with pinned Playwright/esbuild;
- benchmark budgets and comparison against a successful main-branch baseline.

The release job downloads only those tested native artifacts and receipts after
all required validation succeeds. Source-package checks use the filtered
published runtime contents in an isolated consumer. Hosted Linux/macOS/Windows
acceptance must be recorded from an actual workflow run; local macOS checks and
workflow linting do not establish it.
