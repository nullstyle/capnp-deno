import { instantiatePeer } from "../mod.ts";

const defaultWasm = new URL(
  "../.artifacts/capnp_deno.wasm",
  import.meta.url,
);
const source = Deno.args[0] ?? defaultWasm;

const { peer } = await instantiatePeer(source, {}, {
  expectedVersion: 1,
  requireVersionExport: true,
});

console.log(`Loaded capnp-deno wasm peer handle: ${peer.handle}`);
const outbound = peer.drainOutgoingFrames();
console.log(`Initial outbound frame count: ${outbound.length}`);
peer.close();
