import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyRuntime } from "../tools/runtime_artifact.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(await Deno.readTextFile(join(root, "deno.json")));
const expectedIncludes = [
  "src/**/*.ts",
  "generated/*.wasm",
  "generated/*.provenance.json",
  "README.md",
  "LICENSE",
];
if (
  JSON.stringify(config.publish.include) !== JSON.stringify(expectedIncludes)
) {
  throw new Error(
    "update package preflight for the changed publish inventory",
  );
}
await verifyRuntime(
  await Deno.readFile(join(root, "generated/capnp_deno.wasm")),
  JSON.parse(
    await Deno.readTextFile(join(root, "generated/capnp_deno.provenance.json")),
  ),
  JSON.parse(
    await Deno.readTextFile(join(root, "tools/runtime-toolchain.json")),
  ),
);
const temporary = await Deno.makeTempDir({ prefix: "capnp isolated package " });
const pkg = join(temporary, "package");
async function copyTree(relative: string): Promise<void> {
  for await (const entry of Deno.readDir(join(root, relative))) {
    const name = `${relative}/${entry.name}`;
    if (entry.isSymlink) throw new Error(`package source symlink: ${name}`);
    if (entry.isDirectory) await copyTree(name);
    else if (entry.isFile && name.endsWith(".ts")) {
      await Deno.mkdir(
        fileURLToPath(new URL(".", pathToFileURL(join(pkg, name)))),
        { recursive: true },
      );
      await Deno.copyFile(join(root, name), join(pkg, name));
    }
  }
}
try {
  await copyTree("src");
  await Deno.mkdir(join(pkg, "generated"), { recursive: true });
  for (
    const name of [
      "generated/capnp_deno.wasm",
      "generated/capnp_deno.provenance.json",
      "README.md",
      "LICENSE",
    ]
  ) await Deno.copyFile(join(root, name), join(pkg, name));
  const packageConfig = {
    name: config.name,
    version: config.version,
    license: config.license,
    exports: config.exports,
  };
  await Deno.writeTextFile(
    join(pkg, "deno.json"),
    JSON.stringify(packageConfig),
  );
  const imports = Object.fromEntries(
    Object.entries(config.exports as Record<string, string>).map((
      [key, value],
    ) => [
      key === "." ? config.name : config.name + key.slice(1),
      pathToFileURL(join(pkg, value)).href,
    ]),
  );
  await Deno.writeTextFile(
    join(temporary, "deno.json"),
    JSON.stringify({ imports }),
  );
  await Deno.copyFile(
    join(root, "examples/ping/gen/schema_types.ts"),
    join(temporary, "schema_types.ts"),
  );
  const consumer =
    (await Deno.readTextFile(join(root, "tests/package/consumer.ts"))).replace(
      "../../examples/ping/gen/schema_types.ts",
      "./schema_types.ts",
    );
  await Deno.writeTextFile(join(temporary, "consumer.ts"), consumer);
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--cached-only",
      "--no-remote",
      `--allow-read=${temporary}`,
      "--config",
      join(temporary, "deno.json"),
      join(temporary, "consumer.ts"),
    ],
    cwd: temporary,
    env: {
      DENO_DIR: join(temporary, "empty-cache"),
      DENO_NO_UPDATE_CHECK: "1",
    },
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* exited */ }
  }, 20_000);
  try {
    const result = await child.status;
    if (!result.success || timedOut) {
      throw new Error(
        `isolated package consumer failed (${
          timedOut ? "timeout" : result.code
        })`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
} finally {
  await Deno.remove(temporary, { recursive: true });
}
