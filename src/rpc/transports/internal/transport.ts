/**
 * Core transport interface for Cap'n Proto RPC.
 *
 * @module
 */

/**
 * Interface that all Cap'n Proto RPC transports must implement.
 *
 * A transport is responsible for delivering serialized Cap'n Proto frames
 * between two RPC peers. The library ships with implementations for TCP
 * ({@link TcpTransport}), WebSocket ({@link WebSocketTransport}), WebTransport
 * ({@link WebTransportTransport}), and MessagePort ({@link MessagePortTransport}).
 *
 * @example
 * ```ts
 * const transport: RpcTransport = await TcpTransport.connect("localhost", 4000);
 * ```
 */
export interface RpcTransport {
  /**
   * Starts the transport and begins receiving inbound frames.
   *
   * The `onFrame` callback is invoked for each complete Cap'n Proto frame
   * received from the remote peer. This method must be called exactly once
   * before {@link send} can be used.
   *
   * @param onFrame - Callback invoked with each inbound frame. May return a
   *   promise to apply backpressure.
   * @throws {TransportError} If the transport is already started or closed.
   */
  start(
    onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): void | Promise<void>;

  /**
   * Sends a serialized Cap'n Proto frame to the remote peer.
   *
   * @param frame - The raw bytes of the Cap'n Proto message to send.
   * @throws {TransportError} If the transport is not started or is closed.
   */
  send(frame: Uint8Array): void | Promise<void>;

  /**
   * Closes the transport and releases associated resources.
   *
   * After close() resolves, no further frames will be received or sent.
   * Calling close() on an already-closed transport is a no-op.
   */
  close(): void | Promise<void>;
}

/**
 * Operational snapshot exposed by built-in byte transports.
 *
 * The base {@link RpcTransport} contract intentionally does not require this
 * property, so custom transports remain source-compatible. TCP, WebSocket, and
 * WebTransport expose this shape as `transport.stats` for health checks,
 * saturation dashboards, and shutdown diagnostics.
 *
 * @example
 * ```ts
 * const transport = await TcpTransport.connect("127.0.0.1", 4000);
 * console.log(transport.stats.queuedOutboundFrames);
 * ```
 */
export interface RpcTransportStats {
  /** Whether `start()` has been called successfully. */
  readonly started: boolean;
  /** Whether the transport currently rejects new sends because it is closed. */
  readonly closed: boolean;
  /** Whether an outbound drain loop is active. */
  readonly draining: boolean;
  /** Number of outbound frames queued but not yet being written. */
  readonly queuedOutboundFrames: number;
  /** Total queued outbound payload bytes. */
  readonly queuedOutboundBytes: number;
  /** Number of outbound frames currently being written. */
  readonly inflightOutboundFrames: number;
  /** Total in-flight outbound payload bytes. */
  readonly inflightOutboundBytes: number;
  /** Configured maximum outbound frame size, or `null` when unlimited. */
  readonly maxOutboundFrameBytes: number | null;
  /** Configured maximum queued/in-flight outbound frames, or `null` when unlimited. */
  readonly maxQueuedOutboundFrames: number | null;
  /** Configured maximum queued/in-flight outbound bytes, or `null` when unlimited. */
  readonly maxQueuedOutboundBytes: number | null;
}
