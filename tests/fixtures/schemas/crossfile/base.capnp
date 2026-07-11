# Cross-file codegen fixture: the imported side of the bundle.
#
# Declares the shapes consumer.capnp (and nested/deep.capnp) reference across
# the file boundary:
#   - Level:   an enum used as an imported enum field
#   - Point:   a struct used as a union arm payload, a List element, and a
#              group member in consumer.capnp
#   - Meta:    a struct used as a plain imported struct field and a method
#              result field
#   - Chunk:   a struct used as the param of a `-> stream` method
#   - Watcher: an interface used across the file boundary as a single-field
#              method param/result and as a struct field in consumer.capnp
@0xc74fdeea2f398053;

enum Level {
  info @0;
  warn @1;
  error @2;
}

struct Point {
  x @0 :Int32;
  y @1 :Int32;
}

struct Meta {
  label @0 :Text;
  level @1 :Level;
}

struct Chunk {
  seq @0 :UInt32;
  payload @1 :Data;
}

interface Watcher {
  ping @0 (chunk :Chunk) -> (chunk :Chunk);
}
