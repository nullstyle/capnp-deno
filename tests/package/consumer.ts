import {
  connect,
  MessagePortTransport,
  ProtocolError,
  serveConnection,
} from "@nullstyle/capnp";
import { createRuntimePeer } from "@nullstyle/capnp/advanced";
import { Pinger } from "../../examples/ping/gen/schema_types.ts";

// This file is copied into a fresh directory beside the staged public package.
// Its generated schema import is rewritten to the consumer's own copy.
const peer = createRuntimePeer();
peer.close();
const channel = new MessageChannel();
const serverTransport = new MessagePortTransport(channel.port1, {
  closePortOnClose: true,
});
const clientTransport = new MessagePortTransport(channel.port2, {
  closePortOnClose: true,
});
let calls = 0;
let disposed = 0;
let callbackValue = 0;
const server = await serveConnection(
  Pinger,
  { transport: serverTransport },
  () => ({
    async ping(ponger) {
      calls++;
      if (calls === 2) throw new ProtocolError("isolated consumer exception");
      await ponger.pong(42);
    },
    [Symbol.asyncDispose]() {
      disposed++;
      return Promise.resolve();
    },
  }),
);
try {
  const client = await connect(Pinger, clientTransport, {
    bootstrap: { timeoutMs: 2000 },
  });
  try {
    const callback = {
      pong(value: number) {
        callbackValue = value;
        return Promise.resolve();
      },
    };
    await client.ping(callback, { timeoutMs: 2000 });
    if (callbackValue !== 42) {
      throw new Error("generated callback did not cross the packaged runtime");
    }
    let failure: unknown;
    try {
      await client.ping(callback, { timeoutMs: 2000 });
    } catch (error) {
      failure = error;
    }
    if (
      !(failure instanceof ProtocolError) ||
      !failure.message.includes("host call failed") || calls !== 2
    ) throw new Error(`exception did not propagate: ${failure}`);
  } finally {
    await client[Symbol.asyncDispose]();
  }
} finally {
  await server.close();
  channel.port1.close();
  channel.port2.close();
}
if (disposed !== 1 || !server.closed || !server.runtime.closed) {
  throw new Error("packaged service did not dispose exactly once");
}
console.log(
  "Isolated runtime consumer: bundled WASM, generated call, callback, exception, and cleanup passed",
);
