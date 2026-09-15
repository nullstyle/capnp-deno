import { join } from "node:path";
import { CodegenIoError } from "./errors.ts";

/** Stage the complete result, then atomically replace each file; stale files remain. */
export async function publishGeneratedFiles(
  outDir: string,
  files: readonly { path: string; contents: string }[],
): Promise<void> {
  const names = new Set<string>();
  for (const file of files) {
    if (
      /[\\\0:]/.test(file.path) || file.path.split("/").some((part) =>
        !part || part === "." || part === ".."
      ) || names.has(file.path)
    ) {
      throw new CodegenIoError(
        `invalid or duplicate generated path: ${file.path}`,
      );
    }
    names.add(file.path);
  }
  let staging: string | undefined;
  try {
    await Deno.mkdir(outDir, { recursive: true });
    const root = await Deno.realPath(outDir);
    staging = await Deno.makeTempDir({ dir: root, prefix: ".capnpc-stage-" });
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      let directory = root;
      const components = file.path.split("/");
      for (const component of components.slice(0, -1)) {
        directory = join(directory, component);
        try {
          await Deno.mkdir(directory);
        } catch (error) {
          if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
        }
        const info = await Deno.lstat(directory);
        if (!info.isDirectory || info.isSymlink) {
          throw new CodegenIoError(
            `generated parent is not a regular directory: ${directory}`,
          );
        }
      }
      const target = join(root, file.path);
      try {
        const info = await Deno.lstat(target);
        if (!info.isFile || info.isSymlink) {
          throw new CodegenIoError(
            `generated destination is not a regular file: ${target}`,
          );
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      await Deno.writeTextFile(join(staging, String(index)), file.contents);
    }
    for (let index = 0; index < files.length; index++) {
      await Deno.rename(
        join(staging, String(index)),
        join(root, files[index].path),
      );
    }
  } catch (cause) {
    throw new CodegenIoError(
      `failed to publish generated files in ${outDir}: ${
        cause instanceof Error ? cause.message : cause
      }`,
      { cause },
    );
  } finally {
    if (staging) await Deno.remove(staging, { recursive: true });
  }
}
