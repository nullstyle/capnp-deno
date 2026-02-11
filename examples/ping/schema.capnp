@0xab0a74159f909745;

interface Pinger {
    ping @0 (p :Ponger) -> ();
}

interface Ponger {
    pong @0 (n :UInt32) -> ();
}
