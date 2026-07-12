# Nested-type fixture: the owning side. Outer is a top-level (exported)
# struct; Outer.Inner and Outer.Kind are NESTED declarations that the
# generated module keeps module-private, so a cross-file reference to them
# cannot be lowered and must fail loudly (see hoist/consumer.capnp).
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
