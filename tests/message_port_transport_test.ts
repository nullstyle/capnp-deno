import {
  MessagePortTransport,
  type RpcObservabilityEvent,
  TransportError,
} from "../mod.ts";
import {
  assert,
  assertBytes,
  assertEquals,
  assertThrows,
  deferred,
  withTimeout,
} from "./test_utils.ts";

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

Deno.test("MessagePortTransport can ignore non-binary payloads when configured", async () => {
  const channel = new MessageChannel();
  const seenErrors: unknown[] = [];
  let inboundFrames = 0;
  const transport = new MessagePortTransport(channel.port2, {
    closePortOnClose: true,
    rejectNonBinaryFrames: false,
    onError: (error) => {
      seenErrors.push(error);
    },
  });

  try {
    transport.start((_frame) => {
      inboundFrames += 1;
    });
    channel.port1.postMessage("text payload");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assertEquals(inboundFrames, 0);
    assertEquals(seenErrors.length, 0);
  } finally {
    await transport.close();
    channel.port1.close();
  }
});

Deno.test("MessagePortTransport normalizes messageerror events", async () => {
  const channel = new MessageChannel();
  const transportError = deferred<unknown>();
  const transport = new MessagePortTransport(channel.port2, {
    closePortOnClose: true,
    onError: (error) => transportError.resolve(error),
  });

  try {
    transport.start((_frame) => {});
    channel.port2.dispatchEvent(new Event("messageerror"));

    const err = await withTimeout(
      transportError.promise,
      1000,
      "message port messageerror callback",
    );
    assert(
      err instanceof TransportError &&
        /message port transport error/i.test(err.message),
      `expected messageerror normalization, got: ${String(err)}`,
    );
  } finally {
    await transport.close();
    channel.port1.close();
  }
});

Deno.test("MessagePortTransport enforces maxQueuedOutboundBytes", async () => {
  const channel = new MessageChannel();
  const transport = new MessagePortTransport(channel.port1, {
    closePortOnClose: true,
    maxQueuedOutboundBytes: 1,
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
      err instanceof TransportError &&
        /outbound queue byte limit exceeded/i.test(err.message),
      `expected queued byte limit error, got: ${String(err)}`,
    );

    await first;
  } finally {
    await transport.close();
    channel.port2.close();
  }
});

Deno.test("MessagePortTransport enforces sendTimeoutMs before queued postMessage", async () => {
  const channel = new MessageChannel();
  const transport = new MessagePortTransport(channel.port1, {
    closePortOnClose: true,
    sendTimeoutMs: 0,
  });

  try {
    transport.start((_frame) => {});
    let err: unknown;
    try {
      await transport.send(new Uint8Array([0xaa]));
    } catch (error) {
      err = error;
    }
    assert(
      err instanceof TransportError &&
        /send timed out/i.test(err.message),
      `expected send timeout error, got: ${String(err)}`,
    );
  } finally {
    await transport.close();
    channel.port2.close();
  }
});

Deno.test("MessagePortTransport normalizes postMessage failures", async () => {
  const channel = new MessageChannel();
  const port = channel.port1 as unknown as {
    postMessage: (value: unknown) => void;
  };
  const originalPostMessage = port.postMessage;
  port.postMessage = () => {
    throw new Error("post exploded");
  };

  const seenError = deferred<unknown>();
  const transport = new MessagePortTransport(channel.port1, {
    closePortOnClose: true,
    onError: (error) => seenError.resolve(error),
  });

  try {
    transport.start((_frame) => {});
    let sendErr: unknown;
    try {
      await transport.send(new Uint8Array([0x01]));
    } catch (error) {
      sendErr = error;
    }
    assert(
      sendErr instanceof TransportError &&
        /message port send failed/i.test(sendErr.message) &&
        /post exploded/i.test(sendErr.message),
      `expected postMessage send failure normalization, got: ${
        String(sendErr)
      }`,
    );

    const callbackErr = await withTimeout(
      seenError.promise,
      1000,
      "message port postMessage error callback",
    );
    assert(
      callbackErr instanceof TransportError &&
        /message port send failed/i.test(callbackErr.message),
      `expected callback normalization, got: ${String(callbackErr)}`,
    );
  } finally {
    await transport.close();
    channel.port2.close();
    port.postMessage = originalPostMessage;
  }
});

Deno.test("MessagePortTransport lifecycle guards reject duplicate start and send-after-close", async () => {
  const firstChannel = new MessageChannel();
  const closedBeforeStart = new MessagePortTransport(firstChannel.port1, {
    closePortOnClose: true,
  });
  closedBeforeStart.close();
  assertThrows(
    () => closedBeforeStart.start((_frame) => {}),
    /MessagePortTransport is closed/i,
  );
  firstChannel.port2.close();

  const secondChannel = new MessageChannel();
  const started = new MessagePortTransport(secondChannel.port1, {
    closePortOnClose: true,
  });
  try {
    started.start((_frame) => {});
    assertThrows(
      () => started.start((_frame) => {}),
      /MessagePortTransport already started/i,
    );
    started.close();

    let err: unknown;
    try {
      await started.send(new Uint8Array([0xaa]));
    } catch (error) {
      err = error;
    }
    assert(
      err instanceof TransportError &&
        /MessagePortTransport is closed/i.test(err.message),
      `expected closed send error, got: ${String(err)}`,
    );
  } finally {
    started.close();
    secondChannel.port2.close();
  }
});

Deno.test("MessagePortTransport ignores non-binary frames and still decodes Blob payloads", async () => {
  const channel = new MessageChannel();
  const seen = deferred<Uint8Array>();
  const seenErrors: unknown[] = [];
  const transport = new MessagePortTransport(channel.port2, {
    closePortOnClose: true,
    rejectNonBinaryFrames: false,
    onError: (error) => {
      seenErrors.push(error);
    },
  });

  try {
    transport.start((frame) => seen.resolve(new Uint8Array(frame)));
    channel.port2.dispatchEvent(
      new MessageEvent("message", {
        data: "ignore-me",
      }),
    );
    channel.port2.dispatchEvent(
      new MessageEvent("message", {
        data: new Blob([new Uint8Array([0xde, 0xad, 0xbe])]),
      }),
    );

    const inbound = await withTimeout(
      seen.promise,
      1000,
      "message port blob inbound frame",
    );
    assertBytes(inbound, [0xde, 0xad, 0xbe]);
    assertEquals(seenErrors.length, 0);
  } finally {
    transport.close();
    channel.port1.close();
  }
});

Deno.test("MessagePortTransport rejects queued sends when closed before drain", async () => {
  const channel = new MessageChannel();
  const transport = new MessagePortTransport(channel.port1, {
    closePortOnClose: true,
  });

  try {
    transport.start((_frame) => {});
    const first = transport.send(new Uint8Array([0x01]));
    const second = transport.send(new Uint8Array([0x02]));
    transport.close();

    const settled = await Promise.allSettled([first, second]);
    for (const result of settled) {
      assert(result.status === "rejected", "expected queued send rejection");
      assert(
        result.reason instanceof TransportError &&
          /MessagePortTransport is closed/i.test(result.reason.message),
        `expected closed queued send error, got: ${String(result.reason)}`,
      );
    }
  } finally {
    transport.close();
    channel.port2.close();
  }
});
