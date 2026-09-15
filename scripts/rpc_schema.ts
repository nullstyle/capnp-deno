import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const check = Deno.args[0] === "--check";
if (Deno.args.length > 1 || (check && Deno.args.length !== 1)) {
  throw new Error("usage: rpc_schema.ts [--check | output-directory]");
}
const canonical = join(root, "src/rpc/gen/capnp");
const out = check
  ? await Deno.makeTempDir({ prefix: "capnp rpc schema check " })
  : resolve(Deno.args[0] ?? canonical);
async function run(args: string[]): Promise<void> {
  const child = new Deno.Command(Deno.execPath(), {
    args,
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const timeout = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* exited */ }
  }, 60_000);
  try {
    if (!(await child.status).success) {
      throw new Error(`schema command failed: ${args.join(" ")}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) {
      throw new Error(`unexpected generated entry: ${entry.name}`);
    }
    result.push(entry.name);
  }
  return result.sort();
}
try {
  await run([
    "run",
    "--allow-read",
    "--allow-write",
    join(root, "tools/capnpc-deno/main.ts"),
    "generate",
    "--no-config",
    "--layout",
    "flat",
    "--schema",
    "vendor/capnp-zig/src/rpc/capnp/rpc.capnp",
    "--schema",
    "vendor/capnp-zig/src/rpc/capnp/persistent.capnp",
    "--out",
    out,
    "-I",
    "vendor/capnp-zig/src/rpc/capnp",
    "-I",
    "vendor/capnp-zig/vendor/ext/capnproto/c++/src",
    "--quiet",
  ]);
  for (const name of await files(out)) {
    const path = join(out, name);
    const source = await Deno.readTextFile(path);
    await Deno.writeTextFile(
      path,
      source.replaceAll('"@nullstyle/capnp/encoding"', '"../../../encoding.ts"')
        .replaceAll('"@nullstyle/capnp/rpc"', '"../../../rpc.ts"'),
    );
  }
  await run(["fmt", out]);
  if (check) {
    const expected = await files(canonical);
    if (JSON.stringify(expected) !== JSON.stringify(await files(out))) {
      throw new Error(
        "RPC generated file inventory drift; run deno task codegen:rpc",
      );
    }
    for (const name of expected) {
      if (
        await Deno.readTextFile(join(out, name)) !==
          await Deno.readTextFile(join(canonical, name))
      ) {
        throw new Error(
          `RPC generated source drift: ${name}; run deno task codegen:rpc`,
        );
      }
    }
    console.log("RPC generated sources match a fresh compiler run");
  }
} finally {
  if (check) await Deno.remove(out, { recursive: true });
}
