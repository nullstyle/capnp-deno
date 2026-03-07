@0xc3f5a6de215d6b19;

struct PeerSummary {
    name @0 :Text;
    endpoint @1 :Text;
    direction @2 :Text;
}

interface PeerEvents {
    system @0 (message :Text) -> ();
}

interface PeerNode {
    connect @0 (events :PeerEvents) -> (
        localName :Text,
        peers :List(PeerSummary)
    );
    say @1 (message :Text) -> ();
    rename @2 (name :Text) -> ();
    listPeers @3 () -> (peers :List(PeerSummary));
    disconnect @4 (reason :Text) -> ();
    advertise @5 (endpoint :Text) -> ();
}
