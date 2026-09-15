@0xa9af9c36d03c2f41;

interface Doubler {
  compute @0 (value :UInt32) -> (value :UInt32);
  fail @1 () -> ();
}

interface Interop {
  echo @0 (value :UInt32) -> (value :UInt32);
  invoke @1 (cap :Doubler) -> (value :UInt32);
  child @2 () -> (cap :Doubler);
  fail @3 () -> ();
  push @4 (value :UInt32) -> stream;
  barrier @5 () -> (sum :UInt64, count :UInt32);
}
