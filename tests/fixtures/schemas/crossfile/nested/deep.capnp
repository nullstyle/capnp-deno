# Cross-file codegen fixture: nested-directory importer.
#
# Lives one directory below base.capnp so the schema layout must emit a
# parent-relative import specifier ("../base_types.ts") for the generated
# module, covering the path-rooting logic extended at c299914.
@0xef136cd6ae958212;

using Base = import "../base.capnp";

struct DeepRecord {
  origin @0 :Base.Point;
  level @1 :Base.Level;
}
