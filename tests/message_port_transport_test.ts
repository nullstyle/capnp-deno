import { MessagePortTransport, type RpcObservabilityEvent } from "../mod.ts";
import { assert, assertBytes, deferred, withTimeout } from "./test_utils.ts";

function buildFrame(words: number): Uint8Array {
  const frame = new Uint8Array(8 + words * 8);
  const view = new DataView(frame.buffer);
  view.setUint32(0, 0, true);
  view.setUint32(4, words, true);
  return frame;
}

Deno.test("MessagePortTransport sends and receives binary payloads", async () => {
  const channel = new MessageChannel();
  const left = new MessagePortTransport(channel.port1, {
    closePortOnClose: true,
  });
  const right = new MessagePortTransport(channel.port2, {
    closePortOnClose: true,
  });

  const leftSeen = deferred<Uint8Array>();
  const rightSeen = deferred<Uint8Array>();

  try {
    left.start((frame) => leftSeen.resolve(new Uint8Array(frame)));
    right.start((frame) => rightSeen.resolve(new Uint8Array(frame)));

    await left.send(new Uint8Array([0x11, 0x22]));
    await right.send(new Uint8Array([0xaa, 0xbb, 0xcc]));

    const fromLeft = await withTimeout(
      rightSeen.promise,
      1000,
      "right inbound frame",
    );
    const fromRight = await withTimeout(
      leftSeen.promise,
      1000,
      "left inbound frame",
    );

    assertBytes(fromLeft, [0x11, 0x22]);
    assertBytes(fromRight, [0xaa, 0xbb, 0xcc]);
  } finally {
    await left.close();
    await right.close();
  }
});

Deno.test("MessagePortTransport rejects non-binary payloads by default", async () => {
  const channel = new MessageChannel();
  const transportError = deferred<unknown>();
  const transport = new MessagePortTransport(channel.port2, {
    closePortOnClose: true,
    onError: (error) => transportError.resolve(error),
  });

  try {
    transport.start((_frame) => {});
    channel.port1.postMessage("text payload");

    const err = await withTimeout(
      transportError.promise,
      1000,
      "message port error callback",
    );
    assert(
      err instanceof Error &&
        err.message.includes("non-binary payload"),
      "expected non-binary payload error",
    );
  } finally {
    await transport.close();
    channel.port1.close();
  }
});

Deno.test("MessagePortTransport enforces maxInboundFrameBytes", async () => {
  const channel = new MessageChannel();
  const transportError = deferred<unknown>();
  const transport = new MessagePortTransport(channel.port2, {
    closePortOnClose: true,
    maxInboundFrameBytes: 2,
    onError: (error) => transportError.resolve(error),
  });

  try {
    transport.start((_frame) => {});
    channel.port1.postMessage(new Uint8Array([0x01, 0x02, 0x03]).buffer);

    const err = await withTimeout(
      transportError.promise,
      1000,
      "message port inbound frame limit error callback",
    );
    assert(
      err instanceof Error &&
        err.message.includes("inbound frame size 3 exceeds configured limit 2"),
      "expected inbound frame size limit error",
    );
  } finally {
    await transport.close();
    channel.port1.close();
  }
});

Deno.test("MessagePortTransport enforces maxOutboundFrameBytes", async () => {
  const channel = new MessageChannel();
  const transport = new MessagePortTransport(channel.port1, {
    closePortOnClose: true,
    maxOutboundFrameBytes: 2,
  });

  try {
    transport.start((_frame) => {});
    let err: unknown;
    try {
      await transport.send(new Uint8Array([0x01, 0x02, 0x03]));
    } catch (error) {
      err = error;
    }
    assert(
      err instanceof Error &&
        /outbound frame size 3 exceeds configured limit 2/i.test(err.message),
      `expected outbound frame limit error, got: ${String(err)}`,
    );
  } finally {
    await transport.close();
    channel.port2.close();
  }
});

Deno.test("MessagePortTransport emits observability events", async () => {
  const channel = new MessageChannel();
  const events: RpcObservabilityEvent[] = [];
  const left = new MessagePortTransport(channel.port1, {
    closePortOnClose: true,
    observability: {
      onEvent: (event) => events.push(event),
    },
  });
  const right = new MessagePortTransport(channel.port2, {
    closePortOnClose: true,
  });
  const rightSeen = deferred<Uint8Array>();

  try {
    left.start((_frame) => {});
    right.start((frame) => rightSeen.resolve(new Uint8Array(frame)));
    await left.send(new Uint8Array([0xaa, 0xbb]));
    await withTimeout(
      rightSeen.promise,
      1000,
      "message port observability frame",
    );
  } finally {
    await left.close();
    await right.close();
  }

  const names = events.map((event) => event.name);
  assert(
    names.includes("rpc.transport.message_port.start"),
    "expected start event",
  );
  assert(
    names.includes("rpc.transport.message_port.send_frame"),
    "expected send_frame event",
  );
  assert(
    names.includes("rpc.transport.message_port.close"),
    "expected close event",
  );
});

Deno.test("MessagePortTransport enforces queued outbound frame limits", async () => {
  const channel = new MessageChannel();
  const transport = new MessagePortTransport(channel.port1, {
    closePortOnClose: true,
    maxQueuedOutboundFrames: 1,
  });

  try {
    transport.start((_frame) => {});
    const first = transport.send(new Uint8Array([0x01]));

    let err: unknown;
    try {
      await transport.send(new Uint8Array([0x02]));
    } catch (error) {
      err = error;
    }

    assert(
      err instanceof Error &&
        /outbound queue frame limit exceeded/i.test(err.message),
      `expected queued frame limit error, got: ${String(err)}`,
    );

    await first;
  } finally {
    await transport.close();
    channel.port2.close();
  }
});

Deno.test("MessagePortTransport validates inbound frameLimits", async () => {
  const channel = new MessageChannel();
  const transportError = deferred<unknown>();
  const transport = new MessagePortTransport(channel.port2, {
    closePortOnClose: true,
    frameLimits: {
      maxTraversalWords: 1,
    },
    onError: (error) => transportError.resolve(error),
  });

  try {
    transport.start((_frame) => {});
    channel.port1.postMessage(buildFrame(2).buffer);

    const err = await withTimeout(
      transportError.promise,
      1000,
      "message port frame limits error callback",
    );
    assert(
      err instanceof Error &&
        /traversal words .* exceeds configured limit/i.test(err.message),
      `expected frame limits error, got: ${String(err)}`,
    );
  } finally {
    await transport.close();
    channel.port1.close();
  }
});
