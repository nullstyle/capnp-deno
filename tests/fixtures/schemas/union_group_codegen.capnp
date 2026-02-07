@0xdbca7fc6b19b98a3;

struct Example {
  id @0 :UInt64;

  mode :union {
    none @1 :Void;
    name @2 :Text;
    count @3 :UInt32;
    cfg :group {
      enabled @4 :Bool;
      label @5 :Text;
    }
  }
}
