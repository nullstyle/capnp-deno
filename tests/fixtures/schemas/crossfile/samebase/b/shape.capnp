# Same-basename fixture B: mirrors a/shape.capnp's basename AND struct name
# from a sibling directory. Before the schema-path keying fix the import
# collector keyed both files by the flat "./shape_types.ts" specifier, so a
# consumer importing both silently resolved every reference to whichever
# module was recorded first.
@0xe27307912aa65773;

struct Shape {
  height @0 :UInt64;
}
