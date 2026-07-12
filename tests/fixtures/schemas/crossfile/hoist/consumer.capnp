# Nested-type fixture: the importing side that must FAIL loudly. Lib.Outer
# itself is fine (top level, exported), but Lib.Outer.Inner is nested inside
# a foreign struct, so the owning generated module does not export it and
# capnpc-deno cannot emit a correct reference. Before the loud-error fix this
# silently produced a bare unimported type name and an
# `undefined as unknown as` default.
@0xef2171832a7d7f60;

using Lib = import "lib.capnp";

struct Uses {
  direct @0 :Lib.Outer.Inner;
}
