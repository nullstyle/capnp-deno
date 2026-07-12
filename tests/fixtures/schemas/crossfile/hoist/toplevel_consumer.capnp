# Nested-type fixture: the importing side that must KEEP WORKING. It only
# references the top-level Lib.Outer; Outer's own nested Inner/Kind members
# stay an implementation detail of the owning module, so merely traversing
# them (capability-walker planning, imported defaults) must not trip the
# nested-type error.
@0xcca01b958e0fcab7;

using Lib = import "lib.capnp";

struct Holder {
  outer @0 :Lib.Outer;
}
