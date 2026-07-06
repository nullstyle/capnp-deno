@0xb4bbd4e34c6f77f1;

struct InteropPerson {
  id @0 :UInt64;
  name @1 :Text;
  age @2 :UInt32;
  active @3 :Bool;
  score @4 :Float64;
  favorite @5 :InteropColor;
  tags @6 :List(Text);
  data @7 :Data;
}

enum InteropColor {
  red @0;
  green @1;
  blue @2;
}

struct InteropInner {
  value @0 :UInt32;
  label @1 :Text;
}

struct InteropCoords {
  x @0 :UInt16;
  y @1 :UInt16;
}

struct InteropContainer {
  inner @0 :InteropInner;
  items @1 :List(InteropInner);
  coords @2 :InteropCoords;
}

struct InteropLists {
  nums @0 :List(UInt32);
  flags @1 :List(Bool);
  names @2 :List(Text);
}

struct InteropGrouped {
  coords :group {
    x @0 :UInt16;
    y @1 :UInt16;
  }
  label @2 :Text;
}

struct InteropUnion {
  union {
    text @0 :Text;
    number @1 :UInt32;
    flag @2 :Bool;
  }
}

interface InteropCallback {
  ping @0 () -> ();
}

struct InteropHolder {
  cap @0 :InteropCallback;
  dyn @1 :AnyPointer;
}
