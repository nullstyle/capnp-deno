import {
  schemaDependencies,
  virtualPath,
} from "../../tools/capnpc-deno/workspace.ts";
import { assertEquals, assertThrows } from "../test_utils.ts";

Deno.test("compiler dependency lexer skips text/comments and preserves native escapes", () => {
  const source = new TextEncoder().encode(String.raw`
    # import "ignored.capnp"
    const text :Text = "import \"also-ignored.capnp\"";
    using First = import "../space\x20dir/\303\251.capnp";
    const binary :Data = embed "bytes.bin";
    interface Sink { send @0 () -> # comment
      stream; }
  `);
  assertEquals(
    JSON.stringify(schemaDependencies(source)),
    JSON.stringify([
      { path: "../space dir/é.capnp", schema: true },
      { path: "bytes.bin", schema: false },
      { path: "/capnp/stream.capnp", schema: true },
    ]),
  );
});

Deno.test("compiler lexer bounds dependency names and skips large unrelated literals", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  assertEquals(
    schemaDependencies(encode(`const text :Text = "${"x".repeat(200_000)}";`))
      .length,
    0,
  );
  assertThrows(
    () =>
      schemaDependencies(encode(`using X = import "${"x".repeat(33)}";`), 32),
    /pathBytes/,
  );
  assertThrows(
    () =>
      schemaDependencies(
        encode('using A = import "a"; using B = import "b";'),
        32,
        1,
      ),
    /entry limit/,
  );
});

Deno.test("compiler virtual paths preserve POSIX, Windows volumes and UNC roots", () => {
  assertEquals(
    virtualPath("/space dir/é/../a.capnp", false),
    "space dir/a.capnp",
  );
  assertEquals(
    virtualPath("C:\\space dir\\é.capnp", true),
    "C:/space dir/é.capnp",
  );
  assertEquals(virtualPath("D:\\project\\a.capnp", true), "D:/project/a.capnp");
  assertEquals(
    virtualPath("\\\\server\\share\\a.capnp", true),
    "UNC/server/share/a.capnp",
  );
  assertEquals(virtualPath("/", false), "");
  assertThrows(() => virtualPath("../a.capnp", false), /absolute/);
});
