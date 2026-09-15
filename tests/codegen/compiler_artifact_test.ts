import { unpackCompilerTar } from "../../tools/compiler_artifact.ts";
import { assertEquals, assertThrows } from "../test_utils.ts";

function archive(path = "package/one.txt", type = "0"): Uint8Array {
  const tar = new Uint8Array(2048);
  const header = tar.subarray(0, 512);
  const encoder = new TextEncoder();
  header.set(encoder.encode(path));
  header.set(encoder.encode("00000000003\0"), 124);
  header[156] = type.charCodeAt(0);
  header.set(encoder.encode("ustar\0"), 257);
  header.fill(32, 148, 156);
  const sum = header.reduce((sum, byte) => sum + byte, 0);
  header.set(encoder.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  tar.set(encoder.encode("abc"), 512);
  return tar;
}

Deno.test("compiler tar preserves bytes from the producer's regular-file format", () => {
  const files = unpackCompilerTar(archive());
  assertEquals(files.size, 1);
  assertEquals(new TextDecoder().decode(files.get("one.txt")), "abc");
});

for (
  const path of [
    "package/../escape",
    "package//absolute",
    "other/file",
    "package/C:/escape",
    "package/dir\\file",
  ]
) {
  Deno.test(`compiler tar rejects unsafe path ${path}`, () => {
    assertThrows(
      () => unpackCompilerTar(archive(path)),
      /invalid compiler tar entry/,
    );
  });
}

for (const type of ["1", "2", "5", "x", "L"]) {
  Deno.test(`compiler tar rejects unsupported entry type ${type}`, () => {
    assertThrows(
      () => unpackCompilerTar(archive("package/one.txt", type)),
      /invalid compiler tar entry/,
    );
  });
}

Deno.test("compiler tar rejects damaged headers, truncation, and trailing data", () => {
  const badChecksum = archive();
  badChecksum[0] ^= 1;
  assertThrows(
    () => unpackCompilerTar(badChecksum),
    /invalid compiler tar entry/,
  );
  assertThrows(
    () => unpackCompilerTar(archive().subarray(0, 1024)),
    /missing compiler tar trailer/,
  );
  assertThrows(
    () => unpackCompilerTar(archive().subarray(0, 513)),
    /invalid compiler tar length/,
  );
  const garbage = archive();
  garbage[1536] = 1;
  assertThrows(
    () => unpackCompilerTar(garbage),
    /invalid compiler tar trailer/,
  );
});

Deno.test("compiler tar rejects duplicate file names", () => {
  const duplicate = new Uint8Array(3072);
  duplicate.set(archive().subarray(0, 1024));
  duplicate.set(archive().subarray(0, 1024), 1024);
  assertThrows(
    () => unpackCompilerTar(duplicate),
    /invalid compiler tar entry/,
  );
});
