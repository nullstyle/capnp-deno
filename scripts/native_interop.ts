/** Build source-matched native reference peers and run the four-way matrix. */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileSchemasToRequest } from "../tools/capnpc-deno/compiler.ts";
import { readCompilerPin } from "../tools/compiler_artifact.ts";
import { type RuntimeToolchain, sha256 } from "../tools/runtime_artifact.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = join(root, "tests/interop/native");
const source = join(root, "vendor/capnp-zig");
const cppSource = join(source, "vendor/ext/capnproto");
const cache = join(root, ".capnp-cache/native-interop");
const pin: RuntimeToolchain = JSON.parse(
  await Deno.readTextFile(join(root, "tools/runtime-toolchain.json")),
);
const cxx = Deno.env.get("CXX") ?? "c++";
const updateFixtures = Deno.args.length === 1 &&
  Deno.args[0] === "--update-fixtures";
if (Deno.args.length && !updateFixtures) {
  throw new Error("usage: native_interop.ts [--update-fixtures]");
}
if (Deno.build.os !== "linux" && Deno.build.os !== "darwin") {
  throw new Error("native interoperability currently supports Linux and macOS");
}
await Deno.mkdir(cache, { recursive: true });

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; input?: Uint8Array; timeoutMs?: number } = {},
): Promise<Uint8Array> {
  const child = new Deno.Command(command, {
    args,
    cwd: options.cwd ?? root,
    stdin: options.input ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
  }, options.timeoutMs ?? 600_000);
  const heartbeat = setInterval(
    () => console.log(`${command}: native verification still running`),
    30_000,
  );
  const output = child.output();
  try {
    if (options.input) {
      const writer = child.stdin.getWriter();
      await writer.write(options.input);
      await writer.close();
    }
    const result = await output;
    const log = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
    await Deno.writeTextFile(join(cache, "last-command.log"), log);
    if (!result.success || timedOut) {
      throw new Error(
        `${command} ${timedOut ? "timed out" : `exited ${result.code}`}\n${
          log.slice(-12_000)
        }`,
      );
    }
    return result.stdout;
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
  }
}

async function capture(command: string, args: string[]): Promise<string> {
  return new TextDecoder().decode(await run(command, args)).trim();
}

if (await capture("zig", ["version"]) !== pin.zigVersion) {
  throw new Error(`native verification requires Zig ${pin.zigVersion}`);
}
if (
  await capture("git", ["-C", source, "rev-parse", "HEAD"]) !==
    pin.capnpZigCommit
) {
  throw new Error("native Zig checkout differs from the runtime pin");
}
if (await capture("git", ["-C", source, "status", "--porcelain"])) {
  throw new Error("native verification requires a clean capnp-zig checkout");
}
const cppCommit = await capture("git", ["-C", cppSource, "rev-parse", "HEAD"]);
const cppGitlink = await capture("git", [
  "-C",
  source,
  "rev-parse",
  "HEAD:vendor/ext/capnproto",
]);
if (cppCommit !== cppGitlink) {
  throw new Error("native C++ source differs from its pinned gitlink");
}
if (await capture("git", ["-C", cppSource, "status", "--porcelain"])) {
  throw new Error("native verification requires clean C++ reference sources");
}
const cxxVersion = await capture(cxx, ["--version"]);
const key = await sha256(new TextEncoder().encode(
  `${cppCommit}\n${Deno.build.os}\n${Deno.build.arch}\n${cxxVersion}`,
));
const cppCache = join(cache, `cpp-${key.slice(0, 16)}`);
const cppInstall = join(cppCache, "install");
const cppBuild = join(cppCache, "build");
console.log(
  `Building C++ oracle ${cppCommit} with ${cxxVersion.split("\n")[0]}`,
);
await run("cmake", [
  "-S",
  cppSource,
  "-B",
  cppBuild,
  "-DCMAKE_BUILD_TYPE=Release",
  "-DBUILD_TESTING=OFF",
  "-DWITH_OPENSSL=OFF",
  "-DWITH_ZLIB=OFF",
  `-DCMAKE_CXX_COMPILER=${cxx}`,
  `-DCMAKE_INSTALL_PREFIX=${cppInstall}`,
]);
await run("cmake", [
  "--build",
  cppBuild,
  "--parallel",
  "4",
  "--target",
  "install",
]);
const nativeCompiler = join(cppInstall, "bin/capnp");
if (
  await capture(nativeCompiler, ["--version"]) !== "Cap'n Proto version 2.0-dev"
) {
  throw new Error("unexpected native reference compiler version");
}

const stage = await Deno.makeTempDir({ dir: cache, prefix: "matrix-" });
try {
  const request = await compileSchemasToRequest(
    [join(fixture, "interop.capnp")],
    [fixture],
    { cwd: root, sourcePrefix: fixture, timeoutMs: 60_000 },
  );
  const requestPath = join(stage, "request.bin");
  await Deno.writeFile(requestPath, request);
  const tsOut = join(stage, "ts");
  await run(Deno.execPath(), [
    "run",
    "--allow-read",
    "--allow-write",
    join(root, "tools/capnpc-deno/main.ts"),
    "generate",
    "--no-config",
    "--request-bin",
    requestPath,
    "--out",
    tsOut,
    "--layout",
    "flat",
    "--quiet",
  ]);
  await run(Deno.execPath(), ["fmt", "--no-config", tsOut]);
  for (const name of ["interop_types.ts", "interop_meta.ts", "mod.ts"]) {
    if (updateFixtures) {
      await Deno.copyFile(join(tsOut, name), join(fixture, "gen", name));
      continue;
    }
    if (
      await Deno.readTextFile(join(tsOut, name)) !==
        await Deno.readTextFile(join(fixture, "gen", name))
    ) {
      throw new Error(
        `native TypeScript fixture drift: regenerate tests/interop/native/gen/${name}`,
      );
    }
  }
  const zigTool = join(stage, "zig-tool");
  await run("zig", ["build", "--prefix", zigTool], { cwd: source });
  await run(join(zigTool, "bin/capnpc-zig"), [], {
    cwd: stage,
    input: request,
  });
  const zigEndpoint = join(stage, "zig-endpoint");
  await run("zig", [
    "build-exe",
    "-lc",
    "-ODebug",
    "--dep",
    "capnpc-zig",
    "--dep",
    "generated",
    `-Mroot=${join(fixture, "endpoint.zig")}`,
    "--dep",
    "capnpc-zig",
    `-Mcapnpc-zig=${join(source, "src/lib.zig")}`,
    "--dep",
    "capnpc-zig",
    `-Mgenerated=${join(stage, "interop.zig")}`,
    `-femit-bin=${zigEndpoint}`,
  ]);
  // C++ generation uses its own built compiler + plugin + schemas + libraries.
  await run(nativeCompiler, [
    "compile",
    "--no-standard-import",
    `-I${join(cppInstall, "include")}`,
    `-o${join(cppInstall, "bin/capnpc-c++")}:${stage}`,
    `--src-prefix=${fixture}`,
    join(fixture, "interop.capnp"),
  ]);
  const cppEndpoint = join(stage, "cpp-endpoint");
  await run(cxx, [
    "-std=c++23",
    `-I${join(cppInstall, "include")}`,
    `-I${stage}`,
    join(fixture, "endpoint.cpp"),
    join(stage, "interop.capnp.c++"),
    `-L${join(cppInstall, "lib")}`,
    "-lcapnp-rpc",
    "-lcapnp",
    "-lkj-async",
    "-lkj",
    "-pthread",
    "-o",
    cppEndpoint,
  ]);
  await run(Deno.execPath(), ["check", join(fixture, "matrix.ts")]);
  const output = await run(Deno.execPath(), [
    "run",
    "--allow-read",
    "--allow-run",
    "--allow-net=127.0.0.1",
    join(fixture, "matrix.ts"),
    zigEndpoint,
    cppEndpoint,
  ], { timeoutMs: 100_000 });
  console.log(new TextDecoder().decode(output).trim());
  await Deno.writeTextFile(
    join(cache, "last-success.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        capnpZigCommit: pin.capnpZigCommit,
        capnpCppCommit: cppCommit,
        compiler: await readCompilerPin(),
        zigVersion: pin.zigVersion,
        cxxVersion,
        requestSha256: await sha256(request),
        schemaSha256: await sha256(
          await Deno.readFile(join(fixture, "interop.capnp")),
        ),
        rows: ["deno-zig", "zig-deno", "deno-cpp", "cpp-deno"],
        pendingCancellation: {
          wireChecks: [
            "pending Call",
            "one Finish before Return",
            "one terminal Return",
            "one callback Release",
          ],
          recovery: "successful compute on the same child capability",
          denoServer: "AbortSignal with the modern Finish workaround bit false",
          cppServer: "allowCancellation promise destruction",
          zigServer:
            "Finish retirement followed by explicit late completion; no handler abort hook",
        },
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await Deno.remove(stage, { recursive: true });
}
