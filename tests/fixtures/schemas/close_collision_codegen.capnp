@0x8d3390ee535faec5;

# Fixture for the RpcStub lifecycle collision: an interface that defines a
# method literally named `close` must keep that method callable through
# hydrated stubs. Capability release for such stubs moves to
# Symbol.dispose/Symbol.asyncDispose only.
#
#   - CloseableSession: collides (schema `close` method)
#   - PlainSession:     control case (lifecycle close stays available)
#   - SessionHub:       hands out both stubs via interface-typed results

interface CloseableSession {
  close @0 () -> (ok :Bool);
  ping @1 () -> (echo :Text);
}

interface PlainSession {
  poke @0 () -> (echo :Text);
}

interface SessionHub {
  open @0 () -> (session :CloseableSession);
  openPlain @1 () -> (aux :PlainSession);
}
