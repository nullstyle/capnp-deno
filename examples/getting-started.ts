/**
 * Getting Started with capnp-deno
 *
 * This tutorial demonstrates the core concepts of the capnp-deno library:
 *
 * 1. Loading a WASM module and creating a peer
 * 2. Creating a transport
 * 3. Setting up an RPC session
 * 4. Making RPC calls using the client transport
 * 5. Using the server runtime for host-call dispatching
 * 6. Error handling
 * 7. Cleanup
 * 8. Middleware (logging, frame size limits, metrics)
 * 9. Connection pool for managing multiple connections
 *
 * Prerequisites:
 * - A compiled Cap'n Proto WASM module (`.wasm` file)
 * - Deno runtime
 *
 * Run: deno run --allow-read --allow-net examples/getting-started.ts
 */

import {
  // Core types
  type CapnpError,
  // Reconnection
  createExponentialBackoffReconnectPolicy,
  // Middleware
  createFrameSizeLimitMiddleware,
  createLoggingMiddleware,
  createRpcMetricsMiddleware,
  // Client-side RPC
  InMemoryRpcHarnessTransport,
  instantiatePeer,
  MiddlewareTransport,
  ReconnectingRpcClientTransport,
  // Connection pool
  RpcConnectionPool,
  // Server-side RPC
  RpcServerBridge,
  type RpcServerDispatch,
  RpcServerRuntime,
  RpcSession,
  SessionError,
  SessionRpcClientTransport,
  TransportError,
  // Serialization
  WasmSerde,
  withConnection,
  // Transports (for reference)
  // TcpTransport,          // TCP transport for Deno
  // WebSocketTransport,    // WebSocket transport for browsers and Deno
  // MessagePortTransport,  // MessagePort transport for workers
} from "../mod.ts";

// ---------------------------------------------------------------------------
// 1. Loading a WASM module
// ---------------------------------------------------------------------------
//
// The `instantiatePeer` function is the primary entry point for loading a
// Cap'n Proto WASM module. It handles URL resolution, compilation,
// instantiation, and peer creation in a single call.

async function _loadWasmPeer() {
  // Load from a URL relative to the current module
  const wasmUrl = new URL("../generated/capnp_deno.wasm", import.meta.url);

  const { peer, instance } = await instantiatePeer(wasmUrl, {}, {
    expectedVersion: 1,
    requireVersionExport: true,
  });

  console.log(`Peer created with handle: ${peer.handle}`);

  // The peer is now ready to process Cap'n Proto RPC frames.
  // Always close the peer when done to free WASM resources.
  peer.close();

  // You can also use `using` for automatic cleanup (Symbol.dispose):
  // using peer2 = WasmPeer.fromInstance(instance);

  return { instance };
}

// ---------------------------------------------------------------------------
// 2. Setting up a basic RPC session
// ---------------------------------------------------------------------------
//
// An RpcSession binds a WasmPeer to a transport, automatically routing
// inbound frames through the WASM module and sending responses back.

async function _basicSessionExample() {
  const wasmUrl = new URL("../generated/capnp_deno.wasm", import.meta.url);
  const { peer } = await instantiatePeer(wasmUrl, {}, {
    expectedVersion: 1,
  });

  // For this example, we use the InMemoryRpcHarnessTransport which is
  // useful for testing. In production, you would use TcpTransport,
  // WebSocketTransport, or MessagePortTransport.
  const transport = new InMemoryRpcHarnessTransport();

  const session = new RpcSession(peer, transport, {
    onError: (error) => {
      console.error("Session error:", error);
    },
  });

  // Start the session to begin processing frames
  await session.start();
  console.log(`Session started: ${session.started}`);

  // Flush ensures all pending inbound frames have been processed
  await session.flush();

  // Close the session when done - this also closes the transport and peer
  await session.close();
  console.log(`Session closed: ${session.closed}`);
}

// ---------------------------------------------------------------------------
// 3. Client-side RPC calls
// ---------------------------------------------------------------------------
//
// The SessionRpcClientTransport provides high-level methods for making
// Cap'n Proto RPC calls: bootstrap, call, callRaw, and callRawPipelined.

async function _clientRpcExample() {
  const wasmUrl = new URL("../generated/capnp_deno.wasm", import.meta.url);
  const { peer } = await instantiatePeer(wasmUrl, {}, {
    expectedVersion: 1,
  });

  const transport = new InMemoryRpcHarnessTransport();
  const session = new RpcSession(peer, transport);

  // Create a client transport for a specific Cap'n Proto interface
  const interfaceId = 0xabcd_1234_5678_9012n; // Your interface's ID
  const client = new SessionRpcClientTransport(session, transport, {
    interfaceId,
    autoStart: true, // Automatically starts the session on first call
  });

  try {
    // Bootstrap: obtain the server's root capability
    const cap = await client.bootstrap({
      timeoutMs: 5000, // 5 second timeout
    });
    console.log(`Bootstrap capability index: ${cap.capabilityIndex}`);

    // Make a call using the bootstrap capability
    const params = new Uint8Array(); // Empty params for this example
    const result = await client.call(cap, 0, params, {
      timeoutMs: 10000,
    });
    console.log(`Call result: ${result.byteLength} bytes`);

    // For more control, use callRaw to get the full result with metadata
    const rawResult = await client.callRaw(cap, 0, params);
    console.log(`Cap table entries: ${rawResult.capTable.length}`);
    console.log(`No finish needed: ${rawResult.noFinishNeeded}`);
  } catch (error) {
    if (error instanceof SessionError) {
      console.error("Session error:", error.message);
    } else if (error instanceof TransportError) {
      console.error("Transport error:", error.message);
    } else {
      throw error;
    }
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// 4. Server-side dispatch with RpcServerRuntime
// ---------------------------------------------------------------------------
//
// The RpcServerRuntime combines an RpcSession with an RpcServerBridge,
// automatically pumping host calls from the WASM peer after each inbound
// frame.

async function _serverRuntimeExample() {
  const wasmUrl = new URL("../generated/capnp_deno.wasm", import.meta.url);
  const { peer } = await instantiatePeer(wasmUrl, {}, {
    expectedVersion: 1,
  });

  // Define a server dispatch handler for a specific interface
  const interfaceId = 0xabcd_1234_5678_9012n;
  const dispatch: RpcServerDispatch = {
    interfaceId,
    dispatch(methodOrdinal, params, ctx) {
      console.log(
        `Received call: interface=${ctx.interfaceId} method=${methodOrdinal} params=${params.byteLength}b`,
      );

      // Return a response (can be a Uint8Array or an RpcCallResponse object)
      return {
        content: new Uint8Array(), // Your serialized response
      };
    },
  };

  // Create a bridge and register the dispatch handler as an exported capability
  const bridge = new RpcServerBridge();
  const cap = bridge.exportCapability(dispatch);
  console.log(`Exported capability at index: ${cap.capabilityIndex}`);

  const transport = new InMemoryRpcHarnessTransport();

  const runtime = new RpcServerRuntime(peer, transport, bridge, {
    hostCallPump: {
      enabled: true,
      maxCallsPerInboundFrame: 64,
      maxCallsTotal: 10000,
      failOnLimit: false,
      onWarning: (warning) => {
        console.warn(`Runtime warning [${warning.code}]: ${warning.message}`);
      },
    },
  });

  await runtime.start();
  console.log(`Server runtime started: ${runtime.started}`);
  console.log(`Host calls pumped: ${runtime.totalHostCallsPumped}`);

  await runtime.close();
}

// ---------------------------------------------------------------------------
// 5. JSON serialization with WasmSerde
// ---------------------------------------------------------------------------
//
// WasmSerde provides efficient JSON-based serialization of Cap'n Proto types
// through WASM serde exports.

async function _serdeExample() {
  const wasmUrl = new URL("../generated/capnp_deno.wasm", import.meta.url);
  const { instance } = await instantiatePeer(wasmUrl, {}, {
    expectedVersion: 1,
  });

  const serde = WasmSerde.fromInstance(instance);

  // Discover available codecs in the WASM module
  const codecs = serde.listJsonCodecs();
  console.log(`Available codecs: ${codecs.map((c) => c.key).join(", ")}`);

  // Create a typed codec for a specific Cap'n Proto type
  if (codecs.length > 0) {
    const codec = serde.createJsonCodecFor<Record<string, unknown>>({
      key: codecs[0].key,
    });

    // Encode a value to Cap'n Proto binary
    const encoded = codec.encode({ someField: "hello" });
    console.log(`Encoded: ${encoded.byteLength} bytes`);

    // Decode Cap'n Proto binary back to a value
    const decoded = codec.decode(encoded);
    console.log(`Decoded:`, decoded);
  }
}

// ---------------------------------------------------------------------------
// 6. Reconnecting client
// ---------------------------------------------------------------------------
//
// The ReconnectingRpcClientTransport wraps any RPC client transport with
// automatic reconnection using configurable backoff policies.

function reconnectingClientExample() {
  // Create a reconnect policy with exponential backoff
  const policy = createExponentialBackoffReconnectPolicy({
    maxAttempts: 5,
    initialDelayMs: 100,
    maxDelayMs: 5000,
    factor: 2,
    jitterRatio: 0.2,
  });

  // Create a reconnecting client
  const _client = new ReconnectingRpcClientTransport({
    connect: () => {
      // This factory is called each time a connection needs to be
      // established or re-established. Return any RpcClientTransportLike.
      throw new Error("Not implemented in this example");
    },
    reconnect: {
      policy,
      onRetry: (info) => {
        console.log(
          `Reconnect attempt ${info.attempt} after ${info.delayMs}ms delay`,
        );
      },
    },
    retryInFlightCalls: true,
    rebootstrapOnReconnect: true,
  });

  console.log("Reconnecting client configured (not connected in this example)");
}

// ---------------------------------------------------------------------------
// 7. Error handling patterns
// ---------------------------------------------------------------------------
//
// capnp-deno uses a structured error hierarchy. All errors extend CapnpError.

function errorHandlingExample() {
  try {
    throw new SessionError("example error", {
      cause: new TransportError("underlying transport failed"),
    });
  } catch (error) {
    // Check specific error types
    if (error instanceof SessionError) {
      console.log(`Session error: ${error.message}`);
      console.log(`Error kind: ${error.kind}`); // "session"

      // Access the cause chain
      if (error.cause instanceof TransportError) {
        console.log(`Caused by transport: ${error.cause.message}`);
      }
    }

    // All capnp-deno errors have a `kind` property
    const capnpError = error as CapnpError;
    console.log(`Error kind: ${capnpError.kind}`);
  }
}

// ---------------------------------------------------------------------------
// 8. Middleware: logging, frame size limits, and metrics
// ---------------------------------------------------------------------------
//
// The MiddlewareTransport wraps any RpcTransport with a stack of
// interceptors that can observe, transform, or reject frames flowing
// through the transport. capnp-deno ships with several built-in
// middleware factories.

function middlewareExample() {
  // Create the underlying transport (using in-memory for this example)
  const inner = new InMemoryRpcHarnessTransport();

  // Set up metrics collection with periodic snapshots every 50 frames
  const metrics = createRpcMetricsMiddleware({
    snapshotIntervalFrames: 50,
    onSnapshot: (snap) => {
      console.log(
        `[metrics snapshot] sent=${snap.totalFramesSent} recv=${snap.totalFramesReceived}`,
      );
    },
  });

  // Wrap the transport with logging, a 1 MB frame size limit, and metrics
  const transport = new MiddlewareTransport(inner, [
    createLoggingMiddleware({ prefix: "[my-service]" }),
    createFrameSizeLimitMiddleware(1024 * 1024), // 1 MB max
    metrics.middleware,
  ]);

  // The wrapped transport is a drop-in replacement for any RpcTransport:
  //   const session = new RpcSession(peer, transport);

  // Query metrics at any time
  const snap = metrics.snapshot();
  console.log(`Frames sent so far: ${snap.totalFramesSent}`);
  console.log(`Frames received so far: ${snap.totalFramesReceived}`);
  console.log(`Bytes sent: ${snap.totalBytesSent}`);
  console.log(`Bytes received: ${snap.totalBytesReceived}`);
  console.log(
    `Message breakdown: bootstrap=${snap.framesByType.bootstrap} ` +
      `call=${snap.framesByType.call} return=${snap.framesByType.return}`,
  );

  // Reset counters (e.g. after exporting to a monitoring system)
  metrics.reset();

  // The transport reference is needed so TypeScript does not complain
  // about unused variables in this illustrative example.
  console.log(`Middleware stack size: ${transport.middleware.length}`);
}

// ---------------------------------------------------------------------------
// 9. Connection pool for managing multiple RPC connections
// ---------------------------------------------------------------------------
//
// RpcConnectionPool manages a set of lazily-created connections, reusing
// idle ones and closing connections that sit idle too long. Use it when you
// need to multiplex many concurrent RPC calls across a bounded number of
// underlying transports.

async function connectionPoolExample() {
  // Factory that creates a new client transport on demand.
  // In production this would connect over TCP/WebSocket/etc.
  function createTransport(): Promise<
    import("../mod.ts").RpcClientTransportLike
  > {
    const transport = new InMemoryRpcHarnessTransport();
    // Return anything satisfying RpcClientTransportLike
    return Promise.resolve(
      transport as unknown as import("../mod.ts").RpcClientTransportLike,
    );
  }

  // Create a pool with up to 4 connections, 10 s idle timeout
  const pool = new RpcConnectionPool(createTransport, {
    maxConnections: 4,
    idleTimeoutMs: 10_000,
    acquireTimeoutMs: 3_000,
  });

  // Option A: manual acquire / release
  const conn = await pool.acquire();
  try {
    // ... use conn for RPC calls ...
    console.log(
      `Acquired connection, pool stats: ${JSON.stringify(pool.stats)}`,
    );
  } finally {
    pool.release(conn);
  }

  // Option B: use the withConnection helper for automatic release
  await withConnection(pool, async (c) => {
    // The connection is automatically released when this function returns
    // or throws, so you do not need a try/finally block.
    console.log(
      `Using connection via withConnection, active=${pool.stats.active}`,
    );
    // Simulate some work
    await Promise.resolve(c);
  });

  // Inspect pool health at any time
  const stats = pool.stats;
  console.log(
    `Pool: total=${stats.total} idle=${stats.idle} active=${stats.active} pending=${stats.pending}`,
  );

  // Clean up -- closes all idle and active connections
  await pool.close();
  console.log("Connection pool closed.");
}

// ---------------------------------------------------------------------------
// Run examples
// ---------------------------------------------------------------------------

console.log("=== capnp-deno Getting Started ===\n");

console.log("--- Error Handling ---");
errorHandlingExample();

console.log("\n--- Reconnecting Client Setup ---");
reconnectingClientExample();

console.log("\n--- Middleware ---");
middlewareExample();

console.log("\n--- Connection Pool ---");
await connectionPoolExample();

// The following examples require a WASM module to be present.
// Uncomment to run them with a real WASM module:
//
// console.log("\n--- Loading WASM Peer ---");
// await _loadWasmPeer();
//
// console.log("\n--- Basic Session ---");
// await _basicSessionExample();
//
// console.log("\n--- Client RPC ---");
// await _clientRpcExample();
//
// console.log("\n--- Server Runtime ---");
// await _serverRuntimeExample();
//
// console.log("\n--- JSON Serde ---");
// await _serdeExample();

console.log("\nDone.");
