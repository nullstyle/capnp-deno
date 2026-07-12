# Same-basename fixture consumer: imports two schema files that share a
# basename (a/shape.capnp, b/shape.capnp) and uses one type from each. The
# generated module must carry two DISTINCT imports — one per owning module —
# with `left` bound to a/Shape (width) and `right` bound to b/Shape (height).
@0xe4c215f35d65c7d7;

using A = import "a/shape.capnp";
using B = import "b/shape.capnp";

struct Pair {
  left @0 :A.Shape;
  right @1 :B.Shape;
}
