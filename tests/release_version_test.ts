import { assertReleaseTagMatchesVersion } from "../scripts/check_release_version.ts";
import { assertThrows } from "./test_utils.ts";

Deno.test("release refuses a tag that would mislabel the package version", () => {
  for (const tag of ["v9.9.9", "0.5.0", "v0.5.0-rc.1", "refs/tags/v0.5.0"]) {
    assertThrows(
      () => assertReleaseTagMatchesVersion(tag, "0.5.0"),
      /must match.*v0\.5\.0/,
    );
  }
});

Deno.test("release accepts exact stable and prerelease package tags", () => {
  assertReleaseTagMatchesVersion("v0.5.0", "0.5.0");
  assertReleaseTagMatchesVersion("v0.6.0-rc.1", "0.6.0-rc.1");
});

Deno.test("release refuses a missing package version", () => {
  for (const version of [undefined, null, "", 5]) {
    assertThrows(
      () => assertReleaseTagMatchesVersion("v0.5.0", version),
      /must declare a package version/,
    );
  }
});
