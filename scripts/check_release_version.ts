/**
 * Validate a release tag against the package version before building assets.
 * @param tag - Tag name without the refs/tags prefix.
 * @param version - Package version read from deno.json.
 * @returns Nothing when the tag identifies exactly that version.
 * @example
 * ```ts
 * assertReleaseTagMatchesVersion("v0.5.0", "0.5.0");
 * ```
 */
export function assertReleaseTagMatchesVersion(
  tag: string,
  version: unknown,
): void {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("deno.json must declare a package version");
  }
  if (tag !== `v${version}`) {
    throw new Error(
      `release tag ${
        JSON.stringify(tag)
      } must match deno.json version v${version}`,
    );
  }
}

if (import.meta.main) {
  if (Deno.args.length !== 1) {
    throw new Error("usage: check_release_version.ts <tag>");
  }
  const config = JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  );
  assertReleaseTagMatchesVersion(Deno.args[0], config.version);
  console.log(`Verified release tag ${Deno.args[0]} matches deno.json`);
}
