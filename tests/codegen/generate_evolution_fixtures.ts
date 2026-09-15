// Generate current-toolchain evidence with: deno task fixtures:codegen [output.json]
// The default output is ignored; the checked-in 1.5.0 fixture stays historical.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
if (Deno.args.length > 1) {
  throw new Error("usage: generate_evolution_fixtures.ts [output.json]");
}
const output = resolve(
  Deno.args[0] ?? ".capnp-cache/fixtures/evolution_defaults.json",
);

async function capnp(args: string[], input?: string): Promise<Uint8Array> {
  const child = new Deno.Command("python3", {
    args: [
      fileURLToPath(
        new URL("../../vendor/capnp-zig/tools/capnp_tool.py", import.meta.url),
      ),
      "compiler",
      "--",
      ...args,
    ],
    cwd: root,
    stdin: input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const timeout = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* exited */ }
  }, 30000);
  try {
    if (input !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(input));
      await writer.close();
    }
    const result = await child.output();
    if (!result.success) {
      throw new Error(new TextDecoder().decode(result.stderr));
    }
    return result.stdout;
  } finally {
    clearTimeout(timeout);
  }
}

function base64(value: Uint8Array): string {
  return btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(""));
}

const schemas = [
  "evolution_defaults",
  "unsupported_list_default",
  "unsupported_struct_default",
];
const requests: Record<string, string> = {};
for (const name of schemas) {
  requests[name] = base64(
    await capnp(["compile", "-o-", `tests/fixtures/schemas/${name}.capnp`]),
  );
}

const cases = {
  current_defaults: ["Current", '(id = 42, name = "old-server")'],
  current_values: [
    "Current",
    '(id = 19, name = "present", source = "", token = "", enabled = false, i8 = 12, i16 = 1200, i32 = 170000, i64 = 9000000000000000000, u8 = 1, u16 = 2, u32 = 3, u64 = 4, f32 = -2.5, f64 = 123.25, choice = one)',
  ],
  old: ["Old", '(id = 42, name = "old-server")'],
  old_envelope: [
    "OldEnvelope",
    '(records = [(label = "first"), (label = "second")], child = (label = "third"))',
  ],
  old_response: ["OldResponse", '(entry = (id = 42, name = "old-server"))'],
  float_defaults: ["FloatDefaults", "()"],
};
const messages: Record<string, string> = {};
for (const [name, [type, value]] of Object.entries(cases)) {
  messages[name] = base64(
    await capnp([
      "encode",
      "tests/fixtures/schemas/evolution_defaults.capnp",
      type,
    ], value),
  );
}
const compiler = new TextDecoder().decode(await capnp(["--version"])).trim();
await Deno.mkdir(dirname(output), { recursive: true });
await Deno.writeTextFile(
  output,
  JSON.stringify({ compiler, requests, messages }, null, 2) + "\n",
);
console.log(`Wrote ${compiler} fixture evidence to ${output}`);
