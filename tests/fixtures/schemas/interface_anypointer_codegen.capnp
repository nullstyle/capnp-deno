@0xb7f0873fa4d9f515;

interface Pinger {
  ping @0 ();
}

struct Holder {
  cap @0 :Pinger;
  dyn @1 :AnyPointer;
}
