@0xd48d8c08a149f531;

interface CounterSink {
  add @0 (value :UInt32) -> stream;
  total @1 () -> (sum :UInt64, count :UInt32);
}
