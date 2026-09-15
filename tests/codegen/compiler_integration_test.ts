import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileSchemasToRequest,
  createSchemaCompiler,
} from "../../tools/capnpc-deno/compiler.ts";
import { parseCodeGeneratorRequest } from "../../tools/capnpc-deno/request_parser.ts";
import { generateTypescriptFiles } from "../../tools/capnpc-deno/emitter.ts";
import {
  snapshotSchemaWorkspace,
  virtualPath,
} from "../../tools/capnpc-deno/workspace.ts";
import { publishGeneratedFiles } from "../../tools/capnpc-deno/workspace_output.ts";
import {
  computeIncludePaths,
  discoverSchemaFiles,
  finalizeGeneratedFiles,
} from "../../tools/capnpc-deno/cli.ts";
import { assert, assertEquals } from "../test_utils.ts";

async function rejects(
  fn: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert(pattern.test(String(error)), `unexpected failure: ${error}`);
    return;
  }
  throw new Error(`expected failure matching ${pattern}`);
}

async function fixture(): Promise<string> {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "capnp-wasm-codegen-" }),
  );
  for (const path of ["app/space é", "first", "second"]) {
    await Deno.mkdir(join(root, path), { recursive: true });
  }
  await Deno.writeTextFile(
    join(root, "app/space é/main.capnp"),
    '@0xbe6b4dc71f1ead83; using C = import "/common.capnp"; using P = import "../parent.capnp"; struct Main { selected @0 :C.Value; parent @1 :P.Value; binary @2 :Data = embed "../bytes.bin"; }',
  );
  await Deno.writeTextFile(
    join(root, "app/parent.capnp"),
    "@0xe014caa814e1c4f1; struct Value { text @0 :Text; }",
  );
  await Deno.writeTextFile(
    join(root, "first/common.capnp"),
    "@0xc73bde8a4a11a15e; struct Value { first @0 :UInt32; }",
  );
  await Deno.writeTextFile(
    join(root, "second/common.capnp"),
    "@0xac06eb18b2d1b375; struct Value { second @0 :UInt64; }",
  );
  await Deno.writeFile(
    join(root, "app/bytes.bin"),
    new Uint8Array([0, 255, 128, 42]),
  );
  return root;
}

Deno.test("compiler snapshots only reachable files with ordered imports and raw embeds", async () => {
  const root = await fixture();
  try {
    await Deno.writeTextFile(
      join(root, "first/unrelated.capnp"),
      "invalid unrelated schema",
    );
    const workspace = await snapshotSchemaWorkspace(
      ["app/space é/main.capnp"],
      ["first", "second"],
      {},
      { cwd: root },
    );
    assertEquals(Object.keys(workspace.files).length, 4);
    assert(
      !Object.keys(workspace.files).some((path) =>
        path.includes("second") || path.includes("unrelated")
      ),
    );
    assertEquals(
      [...workspace.files[virtualPath(join(root, "app/bytes.bin"))]].join(","),
      "0,255,128,42",
    );
    await rejects(
      () =>
        snapshotSchemaWorkspace(["app/space é/main.capnp"], ["first"], {}, {
          cwd: root,
          limits: { workspaceBytes: 8 },
        }),
      /workspaceBytes/,
    );
    await rejects(
      () =>
        snapshotSchemaWorkspace(["app/space é/main.capnp"], ["first"], {}, {
          cwd: root,
          limits: { workspaceEntries: 1 },
        }),
      /workspaceEntries/,
    );
    await rejects(
      () =>
        snapshotSchemaWorkspace(["app/space é/main.capnp"], ["first"], {}, {
          cwd: root,
          limits: { pathBytes: 8 },
        }),
      /pathBytes/,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("compiler preserves import order, prefixes, request bytes and binary defaults", async () => {
  const root = await fixture();
  const compiler = await createSchemaCompiler();
  try {
    const schemas = [
      "app/space é/main.capnp",
      "app/parent.capnp",
      "first/common.capnp",
    ];
    const bytes = await compiler.compile(schemas, ["first", "second"], {
      cwd: root,
      sourcePrefix: "app",
    });
    const request = parseCodeGeneratorRequest(bytes);
    const binary = request.nodes.flatMap((node) =>
      node.structNode?.fields ?? []
    ).find((field) => field.name === "binary")?.slot?.defaultValue;
    assert(binary?.kind === "data");
    assertEquals(binary.value.join(","), "0,255,128,42");
    assertEquals(
      request.requestedFiles.map((file) => file.filename).join(","),
      "space é/main.capnp,parent.capnp,common.capnp",
    );
    const generated = generateTypescriptFiles(request);
    assert(generated.some((file) => file.contents.includes("first")));
    const first = parseCodeGeneratorRequest(
      await compiler.compile(["app/space é/main.capnp"], ["first", "second"], {
        cwd: root,
      }),
    );
    const other = await compiler.compile(["app/space é/main.capnp"], [
      "second",
      "first",
    ], { cwd: root });
    const second = parseCodeGeneratorRequest(other);
    assert(
      first.nodes.some((node) =>
        node.structNode?.fields.some((field) => field.name === "first")
      ),
    );
    assert(
      !first.nodes.some((node) =>
        node.structNode?.fields.some((field) => field.name === "second")
      ),
    );
    assert(
      second.nodes.some((node) =>
        node.structNode?.fields.some((field) => field.name === "second")
      ),
    );
    assert(
      !second.nodes.some((node) =>
        node.structNode?.fields.some((field) => field.name === "first")
      ),
    );
  } finally {
    compiler.dispose();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("compiler handles standard streaming includes and diagnoses missing imports", async () => {
  const root = await fixture();
  try {
    await Deno.writeTextFile(
      join(root, "stream.capnp"),
      "@0xd00ba36c99a5b893; interface Sink { send @0 (data :Data) -> stream; }",
    );
    const request = parseCodeGeneratorRequest(
      await compileSchemasToRequest(["stream.capnp"], [], { cwd: root }),
    );
    assert(
      request.nodes.some((node) =>
        node.displayName.includes("stream.capnp:StreamResult")
      ),
    );
    await rejects(
      () =>
        compileSchemasToRequest(["app/space é/main.capnp"], [], { cwd: root }),
      /common.capnp/,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("compiler cancellation, deadlines and invalid schema recover on the same worker", async () => {
  const root = await fixture();
  const compiler = await createSchemaCompiler();
  try {
    const options = { cwd: root };
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await rejects(
      () =>
        compiler.compile(["app/parent.capnp"], [], {
          ...options,
          signal: controller.signal,
        }),
      /AbortError/,
    );
    await rejects(
      () =>
        compiler.compile(["app/parent.capnp"], [], {
          ...options,
          timeoutMs: 1,
        }),
      /TimeoutError/,
    );
    await Deno.writeTextFile(join(root, "bad.capnp"), "not a schema");
    await rejects(
      () => compiler.compile(["bad.capnp"], [], options),
      /compile failed/,
    );
    assert(
      (await compiler.compile(["app/parent.capnp"], [], options)).length > 0,
    );
  } finally {
    compiler.dispose();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("compiler output validates all destinations before replacing existing files", async () => {
  const root = await fixture();
  try {
    await Deno.writeTextFile(join(root, "keep.ts"), "original");
    await Deno.mkdir(join(root, "blocked.ts"));
    await rejects(
      () =>
        publishGeneratedFiles(root, [{ path: "keep.ts", contents: "changed" }, {
          path: "blocked.ts",
          contents: "invalid",
        }]),
      /regular file/,
    );
    assertEquals(await Deno.readTextFile(join(root, "keep.ts")), "original");
    await rejects(
      () =>
        publishGeneratedFiles(root, [{
          path: "../escape.ts",
          contents: "invalid",
        }]),
      /invalid/,
    );
    await publishGeneratedFiles(root, [
      { path: "keep.ts", contents: "changed" },
      { path: "new/nested.ts", contents: "new" },
    ]);
    assertEquals(await Deno.readTextFile(join(root, "keep.ts")), "changed");
    assertEquals(await Deno.readTextFile(join(root, "new/nested.ts")), "new");
    assert(
      (await Array.fromAsync(Deno.readDir(root))).every((entry) =>
        !entry.name.startsWith(".capnpc-stage-")
      ),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("compiler explicit source discovery bounds traversal before collecting a tree", async () => {
  const root = await fixture();
  try {
    await rejects(
      () => discoverSchemaFiles([root], 2),
      /discovery entry limit/,
    );
    assertEquals((await discoverSchemaFiles([root])).length, 4);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("compiler engine terminates CPU execution within its documented grace", async () => {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-config",
      "--no-prompt",
      new URL("./worker_termination_probe.ts", import.meta.url).href,
    ],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
  }, 8000);
  try {
    const result = await child.output();
    assert(
      !timedOut && result.success,
      `worker CPU termination failed: ${
        new TextDecoder().decode(result.stderr)
      }`,
    );
    const counter = JSON.parse(new TextDecoder().decode(result.stdout));
    assert(BigInt(counter.before) > 0n);
    assert(BigInt(counter.afterThree) >= BigInt(counter.before));
    assertEquals(counter.afterThree, counter.afterFour);
  } finally {
    clearTimeout(timeout);
  }
});

async function inventory(
  directory: string,
  prefix = "",
): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const relative = prefix + entry.name;
    if (entry.isDirectory) {
      paths.push(
        ...await inventory(join(directory, entry.name), `${relative}/`),
      );
    } else if (
      entry.isFile &&
      (await Deno.readTextFile(join(directory, entry.name))).startsWith(
        "// Generated by capnpc-deno",
      )
    ) paths.push(relative);
  }
  return paths.sort();
}

Deno.test("compiler reproduces committed examples and positive codegen fixtures", async () => {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const temporary = await Deno.makeTempDir({
    prefix: "capnp generated parity ",
  });
  const compiler = await createSchemaCompiler();
  const cases: Array<
    {
      schemas: string[];
      expected: string;
      layout: "schema" | "flat";
      srcDirs: string[];
      emitBarrel: boolean;
    }
  > = [
    ...["ping", "streaming", "webtransport_p2p", "kvstore_stress_2"].map((
      name,
    ) => ({
      schemas: [
        `examples/${name}/${
          name === "kvstore_stress_2" ? "kvstore" : "schema"
        }.capnp`,
      ],
      expected: `examples/${name}/gen`,
      layout: "flat" as const,
      srcDirs: [] as string[],
      emitBarrel: true,
    })),
    {
      schemas: ["tests/fixtures/schemas/interop_matrix.capnp"],
      expected: "tests/fixtures/generated/interop_matrix",
      layout: "schema" as const,
      srcDirs: [],
      emitBarrel: true,
    },
  ];
  try {
    const expectedInventory = new Map<string, Set<string>>();
    for (const name of ["crossfile_request", "crossfile_nested_request"]) {
      const raw = Uint8Array.from(
        atob(
          (await Deno.readTextFile(
            join(repository, `tests/fixtures/codegen_requests/${name}.b64`),
          )).trim(),
        ),
        (character) => character.charCodeAt(0),
      );
      cases.push({
        schemas: parseCodeGeneratorRequest(raw).requestedFiles.map((file) =>
          file.filename
        ),
        expected: "tests/fixtures/generated/crossfile",
        layout: "schema",
        srcDirs: ["tests/fixtures/schemas/crossfile"],
        emitBarrel: false,
      });
    }
    for (let index = 0; index < cases.length; index++) {
      const item = cases[index];
      const raw = await compiler.compile(
        item.schemas,
        computeIncludePaths([], item.srcDirs, item.schemas),
        { cwd: repository },
      );
      const files = finalizeGeneratedFiles(
        generateTypescriptFiles(parseCodeGeneratorRequest(raw)),
        { ...item, schemas: item.schemas },
      );
      const inventory = expectedInventory.get(item.expected) ??
        new Set<string>();
      for (const file of files) inventory.add(file.path);
      expectedInventory.set(item.expected, inventory);
      const output = join(temporary, String(index));
      await publishGeneratedFiles(output, files);
      const formatted = await new Deno.Command(Deno.execPath(), {
        args: ["fmt", output],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(formatted.success, new TextDecoder().decode(formatted.stderr));
      for (const file of files) {
        assert(
          await Deno.readTextFile(join(output, file.path)) ===
            await Deno.readTextFile(join(repository, item.expected, file.path)),
          `fresh compiler drift: ${item.expected}/${file.path}`,
        );
      }
    }
    for (const [expected, names] of expectedInventory) {
      assertEquals(
        JSON.stringify(await inventory(join(repository, expected))),
        JSON.stringify([...names].sort()),
        `generated inventory drift: ${expected}`,
      );
    }
  } finally {
    compiler.dispose();
    await Deno.remove(temporary, { recursive: true });
  }
});
