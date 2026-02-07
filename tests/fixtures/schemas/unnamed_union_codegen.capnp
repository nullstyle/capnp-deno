@0x96d896f95d5efec1;

struct Sample {
  id @0 :UInt64;

  union {
    none @1 :Void;
    name @2 :Text;
    count @3 :UInt32;
  }

  after @4 :Bool;
}
