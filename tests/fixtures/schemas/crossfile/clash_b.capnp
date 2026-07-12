# Barrel-clash fixture B: no imports. Mirrors clash_a.capnp's names — the
# same domain struct (UsageResult) and the same interface method name (ping)
# on a different interface — so both schemas generated side by side collide
# in a flat barrel and must be reachable through distinct namespaces in the
# namespaced barrel.
@0xc53e1d078360652e;

struct UsageResult {
  used @0 :UInt64;
  quota @1 :UInt64;
}

interface Heartbeat {
  ping @0 (probe :Text) -> (result :UsageResult);
}
