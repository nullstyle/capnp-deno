import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const uninstall = Deno.args.includes("--uninstall");
const args = Deno.args.filter((arg) => arg !== "--uninstall");
if (args.length && (args.length !== 2 || args[0] !== "--root")) {
  throw new Error(
    "usage: install_compiler.ts [--uninstall] [--root directory]",
  );
}
const base = args[1] ?? Deno.env.get("DENO_INSTALL_ROOT") ??
  join(Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".", ".deno");
const output = join(
  resolve(base),
  "bin",
  Deno.build.os === "windows" ? "capnpc-deno.exe" : "capnpc-deno",
);
if (uninstall) {
  for (const path of [output, `${output}.provenance.json`]) {
    await Deno.remove(path).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
  console.log(`Removed ${output}`);
} else {
  const script = fileURLToPath(
    new URL("./build_capnpc_deno_binary.ts", import.meta.url),
  );
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run=deno",
      script,
      Deno.build.target,
      output,
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) throw new Error("compiler installation failed");
  console.log(`Installed standalone compiler at ${output}`);
}
