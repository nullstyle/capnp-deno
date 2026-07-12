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
#
# And the P2 cross-file interface positions:
#   - single-field method param typed by an imported interface (Hub.attach)
#   - single-field method result typed by an imported interface (Hub.acquire)
#
# And the P4 struct-field capability positions (typed `RpcStub<T> | null`):
#   - struct field typed by an imported interface (Registration.watcher)
#   - List(imported interface) struct field (Registration.backups)
#   - group member typed by an imported interface (Registration.route.primary)
#   - a struct-carried capability crossing the wire (Hub.register)
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

struct Registration {
  label @0 :Text;
  watcher @1 :Base.Watcher;
  backups @2 :List(Base.Watcher);
  route :group {
    primary @3 :Base.Watcher;
  }
}

interface Feed {
  publish @0 (envelope :Envelope, origin :Base.Point) -> (accepted :Bool, echo :Base.Meta);
  stream @1 (chunk :Base.Chunk) -> stream;
}

interface Hub {
  attach @0 (watcher :Base.Watcher) -> ();
  acquire @1 () -> (watcher :Base.Watcher);
  register @2 () -> (registration :Registration);
}
