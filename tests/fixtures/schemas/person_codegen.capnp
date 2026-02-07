@0x9c9e5ec72c9f6a21;

struct Person {
  id @0 :UInt64;
  name @1 :Text;
  age @2 :UInt32;
  favorite @3 :Color;
  tags @4 :List(Text);
}

enum Color {
  red @0;
  green @1;
  blue @2;
}
