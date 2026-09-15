/** Exercise the public standalone compiler install and uninstall commands. */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (Deno.args.length) throw new Error("usage: check_compiler_install.ts");

const root = fileURLToPath(new URL("../", import.meta.url));
const installer = join(root, "scripts/install_compiler.ts");
const checker = join(root, "scripts/check_compiler_binary.ts");
const temporary = await Deno.makeTempDir({
  prefix: "capnp installed compiler ",
});
const installRoot = join(temporary, "install root with spaces");
const binary = join(
  installRoot,
  "bin",
  Deno.build.os === "windows" ? "capnpc-deno.exe" : "capnpc-deno",
);

async function run(
  label: string,
  args: string[],
  timeoutMs: number,
): Promise<void> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-prompt", ...args],
    cwd: root,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
  }, timeoutMs);
  const heartbeat = setInterval(
    () => console.log(`${label}: still running`),
    30_000,
  );
  try {
    const status = await child.status;
    if (!status.success || timedOut) {
      throw new Error(
        `${label} ${timedOut ? "timed out" : `exited ${status.code}`}`,
      );
    }
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
  }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  throw new Error(`compiler uninstall left an installed artifact: ${path}`);
}

try {
  try {
    await run("Compiler installation", [
      "--allow-read",
      "--allow-write",
      "--allow-env=DENO_INSTALL_ROOT,HOME,USERPROFILE",
      "--allow-run=deno",
      installer,
      "--root",
      installRoot,
    ], 240_000);
    // The shared acceptance check validates the installed receipt, then runs a
    // relocated copy with an empty PATH/cache and binary stdin. Its temporary
    // executable path is selected internally, so it needs subprocess access.
    await run("Installed compiler acceptance", [
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      checker,
      binary,
    ], 90_000);
  } finally {
    // Exercise the real uninstall path even if installation or acceptance fails.
    await run("Compiler uninstallation", [
      "--allow-read",
      "--allow-write",
      "--allow-env=DENO_INSTALL_ROOT,HOME,USERPROFILE",
      installer,
      "--uninstall",
      "--root",
      installRoot,
    ], 30_000);
    await assertAbsent(binary);
    await assertAbsent(`${binary}.provenance.json`);
  }
} finally {
  await Deno.remove(temporary, { recursive: true });
}

console.log(
  "Installed compiler: path with spaces, receipt, empty PATH/cache, imports, embed, binary stdin, and uninstall passed",
);
