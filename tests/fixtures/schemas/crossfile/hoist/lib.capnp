# Nested-type fixture: the owning side. Outer is a top-level (exported)
# struct; Outer.Inner and Outer.Kind are NESTED declarations. A nested
# declaration another schema file references (Inner, via hoist/consumer.capnp)
# becomes part of this module's exports under its flattened name; one nobody
# references cross-file (Kind, used only inside this file) stays
# module-private.
@0xc476e67669d847b4;

struct Outer {
  enum Kind {
    circle @0;
    square @1;
  }

  struct Inner {
    value @0 :UInt32;
  }

  inner @0 :Inner;
  kind @1 :Kind;
}
