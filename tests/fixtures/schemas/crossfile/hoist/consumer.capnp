# Nested-type fixture: the importing side. Lib.Outer.Inner is nested inside
# a foreign struct; the request-wide pre-pass marks it exported in the owning
# module, so this resolves through ordinary cross-file imports. (Before the
# export-on-reference fix this failed loudly with a hoist suggestion, and
# before that it silently produced a bare unimported type name and an
# `undefined as unknown as` default.)
@0xef2171832a7d7f60;

using Lib = import "lib.capnp";

struct Uses {
  direct @0 :Lib.Outer.Inner;
}
