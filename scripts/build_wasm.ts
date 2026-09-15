import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeRuntime,
  type RuntimeToolchain,
  verifyRuntime,
} from "../tools/runtime_artifact.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const pin: RuntimeToolchain = JSON.parse(
  await Deno.readTextFile(join(root, "tools/runtime-toolchain.json")),
);
const source = resolve(
  Deno.env.get("CAPNPC_ZIG_ROOT") ?? join(root, "vendor/capnp-zig"),
);
const artifacts = resolve(
  Deno.env.get("CAPNP_DENO_ARTIFACTS_DIR") ?? join(root, "generated"),
);
const check = Deno.args.length === 1 && Deno.args[0] === "--check";
if (Deno.args.length && !check) {
  throw new Error("usage: build_wasm.ts [--check]");
}

async function capture(command: string, args: string[]): Promise<string> {
  const result = await new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `${command} failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

if (
  await capture("git", ["-C", source, "rev-parse", "HEAD"]) !==
    pin.capnpZigCommit
) {
  throw new Error(
    "capnp-zig checkout does not match tools/runtime-toolchain.json",
  );
}
if (await capture("git", ["-C", source, "status", "--porcelain"])) {
  throw new Error(
    "capnp-zig source must be clean for a reproducible runtime build",
  );
}
if (await capture("zig", ["version"]) !== pin.zigVersion) {
  throw new Error(`runtime build requires Zig ${pin.zigVersion}`);
}
const binaryen = await capture("wasm-opt", ["--version"]);
if (!binaryen.startsWith(`wasm-opt version ${pin.binaryenVersion} (`)) {
  throw new Error(
    `runtime build requires Binaryen ${pin.binaryenVersion}, got ${binaryen}`,
  );
}

const timeoutSeconds = Number(
  Deno.env.get("CAPNPC_ZIG_BUILD_TIMEOUT_SECONDS") ?? "600",
);
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
  throw new Error(
    "CAPNPC_ZIG_BUILD_TIMEOUT_SECONDS must be a positive integer",
  );
}
async function run(
  command: string,
  args: string[],
  cwd?: string,
): Promise<void> {
  const child = new Deno.Command(command, {
    args,
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
  }, timeoutSeconds * 1000);
  const heartbeat = setInterval(
    () => console.log(`${command} runtime build still running`),
    30_000,
  );
  try {
    const result = await child.status;
    if (!result.success || timedOut) {
      throw new Error(
        `${command} ${timedOut ? "timed out" : `exited ${result.code}`}`,
      );
    }
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
  }
}

await Deno.mkdir(join(root, ".zig-cache"), { recursive: true });
const stage = await Deno.makeTempDir({
  dir: join(root, ".zig-cache"),
  prefix: "runtime-build-",
});
try {
  await run("zig", [
    "build",
    pin.buildStep,
    `-Dwasm-optimize=${pin.optimization}`,
    "--cache-dir",
    join(stage, "cache"),
    "--prefix",
    join(stage, "out"),
    "--summary",
    "all",
  ], source);
  const binary = join(stage, "capnp_deno.wasm");
  await run("wasm-opt", [
    ...pin.binaryenArgs,
    join(stage, "out/bin/capnp_wasm_host.wasm"),
    "-o",
    binary,
  ]);
  const bytes = await Deno.readFile(binary);
  const receipt = await describeRuntime(bytes, pin);
  if (
    receipt.abi.version !== 1 || receipt.abi.minimum !== 1 ||
    receipt.abi.maximum !== 1 ||
    receipt.abi.features[0] !== 1023 || receipt.abi.features[1] !== 0
  ) {
    throw new Error(
      "runtime ABI changed; review compatibility before updating its artifact",
    );
  }
  const json = JSON.stringify(receipt, null, 2) + "\n";
  if (check) {
    const existing = await Deno.readFile(join(artifacts, "capnp_deno.wasm"));
    const existingText = await Deno.readTextFile(
      join(artifacts, "capnp_deno.provenance.json"),
    );
    const existingReceipt = JSON.parse(existingText);
    await verifyRuntime(existing, existingReceipt, pin);
    if (
      receipt.artifact.sha256 !== existingReceipt.artifact.sha256 ||
      json !== existingText
    ) {
      throw new Error(
        "checked-in runtime differs from a clean rebuild; run deno task build:wasm",
      );
    }
    console.log("Clean rebuild matches the checked-in runtime and provenance");
  } else {
    await Deno.mkdir(artifacts, { recursive: true });
    for (
      const [name, contents] of [["capnp_deno.wasm", bytes], [
        "capnp_deno.provenance.json",
        new TextEncoder().encode(json),
      ]] as const
    ) {
      const temporary = await Deno.makeTempFile({
        dir: artifacts,
        prefix: ".runtime-",
      });
      try {
        await Deno.writeFile(temporary, contents);
        await Deno.rename(temporary, join(artifacts, name));
      } finally {
        await Deno.remove(temporary).catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        });
      }
    }
    console.log(
      `Wrote verified runtime ${receipt.artifact.sha256} (${bytes.length} bytes)`,
    );
  }
} finally {
  await Deno.remove(stage, { recursive: true });
}
