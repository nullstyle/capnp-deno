# Cross-file codegen fixture: the importing side of the bundle.
#
# Exercises every P1 cross-file struct/enum position:
#   - struct field typed by an imported struct (Envelope.meta)
#   - struct field typed by an imported enum (Envelope.level)
#   - List(imported struct) (Envelope.points)
#   - named union with an imported payload arm (Envelope.body.point)
#   - group containing an imported field (Envelope.extra.fallback)
#   - method params/results using imported structs (Feed.publish)
#   - `-> stream` method whose chunk struct is imported (Feed.stream)
@0xe0c8854185d08f6a;

using Base = import "base.capnp";

struct Envelope {
  meta @0 :Base.Meta;
  level @1 :Base.Level;
  points @2 :List(Base.Point);
  body :union {
    none @3 :Void;
    point @4 :Base.Point;
    note @5 :Text;
  }
  extra :group {
    tag @6 :Text;
    fallback @7 :Base.Point;
  }
}

interface Feed {
  publish @0 (envelope :Envelope, origin :Base.Point) -> (accepted :Bool, echo :Base.Meta);
  stream @1 (chunk :Base.Chunk) -> stream;
}
