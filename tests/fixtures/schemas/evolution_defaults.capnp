@0xbfe2d610efd60b48;

enum Choice { zero @0; one @1; two @2; }

struct Old {
  id @0 :UInt32;
  name @1 :Text;
}

struct Current {
  id @0 :UInt32;
  name @1 :Text;
  source @2 :Text = "new-client-default";
  token @3 :Data = 0x"0011ff";
  enabled @4 :Bool = true;
  i8 @5 :Int8 = -12;
  i16 @6 :Int16 = -1200;
  i32 @7 :Int32 = -170000;
  i64 @8 :Int64 = -9000000000000000000;
  u8 @9 :UInt8 = 250;
  u16 @10 :UInt16 = 60000;
  u32 @11 :UInt32 = 4000000000;
  u64 @12 :UInt64 = 18000000000000000000;
  f32 @13 :Float32 = 1.25;
  f64 @14 :Float64 = -9.5;
  choice @15 :Choice = two;
}

struct OldChild { label @0 :Text; }
struct Child { label @0 :Text; extra @1 :Text = "nested-default"; }
struct OldEnvelope { records @0 :List(OldChild); child @1 :OldChild; }
struct Envelope {
  records @0 :List(Child);
  child @1 :Child;
  unseen @2 :Child;
  texts @3 :List(Text);
  bytes @4 :Data;
  anything @5 :AnyPointer;
}

struct OldResponse { entry @0 :Old; }
interface Evolution { fetch @0 () -> (entry :Current); }

struct FloatDefaults {
  positive @0 :Float32 = inf;
  negative @1 :Float64 = -inf;
  notANumber @2 :Float64 = nan;
  negativeZero @3 :Float32 = -0.0;
}

struct Recursive { next @0 :Recursive; }
