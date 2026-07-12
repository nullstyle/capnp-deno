# Same-basename fixture A: lives at a/shape.capnp so its flat generated
# module name would collide with b/shape.capnp. Deliberately declares the
# SAME struct name (Shape) as its sibling so the importing module must also
# alias one of the two imported type names.
@0xb718f6a397319c0d;

struct Shape {
  width @0 :UInt32;
}
