import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPILER_BUNDLE_ROOT,
  COMPILER_PACKAGE_ROOT,
  compilerAssetURL,
  readCompilerPin,
  verifyCompilerPackage,
} from "../tools/compiler_artifact.ts";
import { sha256 } from "../tools/runtime_artifact.ts";

if (Deno.args.length > 2) {
  throw new Error("usage: build_capnpc_deno_binary.ts [target] [output]");
}
const root = fileURLToPath(new URL("../", import.meta.url));
const pin = await readCompilerPin();
if (Deno.version.deno !== pin.denoVersion) {
  throw new Error(`compile with verified Deno ${pin.denoVersion}`);
}
const manifest = await verifyCompilerPackage(COMPILER_PACKAGE_ROOT, pin);
// Deno compile interprets *.wasm as modules. Embed the unchanged bytes under an
// opaque suffix, then verify the original logical inventory at startup.
await Deno.remove(COMPILER_BUNDLE_ROOT, { recursive: true }).catch((error) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});
for (
  const name of [
    "manifest.json",
    ...manifest.files.map((file) => file.path),
  ]
) {
  const destination = compilerAssetURL(name, COMPILER_BUNDLE_ROOT);
  await Deno.mkdir(dirname(fileURLToPath(destination)), { recursive: true });
  await Deno.copyFile(new URL(name, COMPILER_PACKAGE_ROOT), destination);
}
await verifyCompilerPackage(COMPILER_BUNDLE_ROOT, pin);
const target = Deno.args[0] || Deno.build.target;
const output = resolve(
  Deno.args[1] ??
    join(
      root,
      "dist",
      target.includes("windows") ? "capnpc-deno.exe" : "capnpc-deno",
    ),
);
await Deno.mkdir(dirname(output), { recursive: true });
const staging = await Deno.makeTempDir({
  dir: dirname(output),
  prefix: ".compiler-build-",
});
try {
  const stagedBinary = join(staging, basename(output));
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "compile",
      "--allow-read",
      "--allow-write",
      "--no-prompt",
      "--output",
      stagedBinary,
      "--target",
      target,
      "--include",
      fileURLToPath(COMPILER_BUNDLE_ROOT),
      "--include",
      join(root, "tools/compiler_toolchain.json"),
      join(root, "tools/capnpc-deno/main.ts"),
    ],
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* exited */ }
  }, 180_000);
  try {
    const result = await child.status;
    if (!result.success || timedOut) {
      throw new Error(
        `compiler build failed (${timedOut ? "timeout" : result.code})`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
  const bytes = await Deno.readFile(stagedBinary);
  const receipt = {
    format: 1,
    target,
    denoVersion: Deno.version.deno,
    compilerToolchain: pin,
    artifact: {
      filename: basename(output),
      bytes: bytes.length,
      sha256: await sha256(bytes),
    },
  };
  await Deno.writeTextFile(
    join(staging, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  await Deno.rename(stagedBinary, output);
  await Deno.rename(join(staging, "receipt.json"), `${output}.provenance.json`);
  console.log(
    `Built ${output} with embedded verified compiler/worker/includes`,
  );
} finally {
  await Deno.remove(staging, { recursive: true });
}
