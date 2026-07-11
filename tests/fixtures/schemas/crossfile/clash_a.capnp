# Barrel-clash fixture A: no imports. Deliberately declares the SAME
# domain-type name (UsageResult) and the SAME interface method name (ping)
# as clash_b.capnp, so generating both into one output directory exercises
# the namespaced barrel: a flat `export * from` barrel would collide on
# every shared name (codecs, tokens, runtime re-exports).
@0xe4580509a303b0bf;

struct UsageResult {
  used @0 :UInt64;
  limit @1 :UInt64;
}

interface Metering {
  ping @0 (probe :Text) -> (result :UsageResult);
}
