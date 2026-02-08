import { normalizeSessionError, SessionError } from "./errors.ts";
import {
  emitObservabilityEvent,
  type RpcObservability,
} from "./observability.ts";
import type { RpcTransport } from "./transport.ts";
import type { WasmPeer } from "./wasm_peer.ts";

/**
 * Options for configuring an {@link RpcSession}.
 */
export interface RpcSessionOptions {
  /**
   * Error handler invoked when an inbound frame processing error occurs.
   * If not provided, the error is re-thrown (which may result in an
   * unhandled promise rejection).
   */
  onError?: (error: unknown) => void | Promise<void>;
  /** Observability hook for session lifecycle and frame processing events. */
  observability?: RpcObservability;
}

/**
 * Manages the lifecycle of a Cap'n Proto RPC session.
 *
 * An `RpcSession` binds a {@link WasmPeer} to an {@link RpcTransport},
 * receiving inbound frames from the transport, processing them through the
 * WASM peer, and sending outbound response frames back through the transport.
 *
 * Inbound frames are processed sequentially to preserve message ordering.
 *
 * @example
 * ```ts
 * const peer = WasmPeer.fromInstance(instance);
 * const transport = await TcpTransport.connect("localhost", 4000);
 * const session = new RpcSession(peer, transport, {
 *   onError: (err) => console.error("session error:", err),
 * });
 * await session.start();
 * // ... session is now active, processing frames automatically ...
 * await session.close();
 * ```
 */
export class RpcSession {
  /** The WASM peer processing RPC frames. */
  readonly peer: WasmPeer;
  /** The transport used for sending and receiving frames. */
  readonly transport: RpcTransport;

  #started = false;
  #closed = false;
  #inboundChain: Promise<void> = Promise.resolve();
  #onError: RpcSessionOptions["onError"];
  #observability: RpcSessionOptions["observability"];

  /**
   * @param peer - The WASM peer that will process inbound frames.
   * @param transport - The transport for sending/receiving frames.
   * @param options - Session configuration options.
   */
  constructor(
    peer: WasmPeer,
    transport: RpcTransport,
    options: RpcSessionOptions = {},
  ) {
    this.peer = peer;
    this.transport = transport;
    this.#onError = options.onError;
    this.#observability = options.observability;
  }

  /** Whether the session has been started. */
  get started(): boolean {
    return this.#started;
  }

  /** Whether the session has been closed. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Starts the session by activating the transport.
   *
   * Once started, inbound frames are automatically received and processed
   * through the WASM peer, with outbound response frames sent back via
   * the transport.
   *
   * @throws {SessionError} If the session is already started or closed.
   */
  async start(): Promise<void> {
    const startedAt = performance.now();
    if (this.#closed) throw new SessionError("RpcSession is closed");
    if (this.#started) throw new SessionError("RpcSession already started");
    try {
      this.#started = true;

      await this.transport.start((frame) => {
        this.#inboundChain = this.#inboundChain
          .then(() => this.pumpInboundFrame(frame))
          .catch((error) => this.handleError(error));
        return this.#inboundChain;
      });
      emitObservabilityEvent(this.#observability, {
        name: "rpc.session.start",
        attributes: {
          "rpc.outcome": "ok",
        },
        durationMs: performance.now() - startedAt,
      });
    } catch (error) {
      const normalized = normalizeSessionError(
        error,
        "rpc session start failed",
      );
      emitObservabilityEvent(this.#observability, {
        name: "rpc.session.start",
        attributes: {
          "rpc.outcome": "error",
          "rpc.error.type": "start_failed",
        },
        durationMs: performance.now() - startedAt,
        error: normalized,
      });
      throw normalized;
    }
  }

  /**
   * Processes a single inbound frame through the WASM peer and sends any
   * resulting outbound frames via the transport.
   *
   * This method is called automatically by the session's inbound frame
   * processing chain. It can also be called directly for testing purposes.
   *
   * @param frame - The raw bytes of the inbound Cap'n Proto message.
   * @throws {SessionError} If the session is closed or frame processing fails.
   */
  async pumpInboundFrame(frame: Uint8Array): Promise<void> {
    const startedAt = performance.now();
    this.assertOpen();
    try {
      const outbound = this.peer.pushFrame(frame);
      let outboundBytes = 0;
      for (const out of outbound) {
        outboundBytes += out.byteLength;
        await this.transport.send(out);
      }
      emitObservabilityEvent(this.#observability, {
        name: "rpc.session.inbound_frame",
        attributes: {
          "rpc.outcome": "ok",
          "rpc.inbound.bytes": frame.byteLength,
          "rpc.outbound.frames": outbound.length,
          "rpc.outbound.bytes": outboundBytes,
        },
        durationMs: performance.now() - startedAt,
      });
    } catch (error) {
      const normalized = normalizeSessionError(
        error,
        "rpc session inbound frame failed",
      );
      emitObservabilityEvent(this.#observability, {
        name: "rpc.session.inbound_frame",
        attributes: {
          "rpc.outcome": "error",
          "rpc.inbound.bytes": frame.byteLength,
        },
        durationMs: performance.now() - startedAt,
        error: normalized,
      });
      throw normalized;
    }
  }

  /**
   * Waits for all queued inbound frames to finish processing.
   *
   * Useful for ensuring all pending work is complete before inspecting
   * state or closing the session.
   */
  async flush(): Promise<void> {
    await this.#inboundChain;
  }

  /**
   * Closes the session, flushing pending frames and shutting down the
   * transport and peer.
   *
   * Calling close() on an already-closed session is a no-op.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    const startedAt = performance.now();
    this.#closed = true;

    try {
      await this.flush();
    } catch (_err) {
      // No-op on close; transport teardown should continue.
    }

    try {
      await this.transport.close();
    } finally {
      this.peer.close();
    }
    emitObservabilityEvent(this.#observability, {
      name: "rpc.session.close",
      attributes: {
        "rpc.outcome": "ok",
      },
      durationMs: performance.now() - startedAt,
    });
  }

  private async handleError(error: unknown): Promise<void> {
    const normalized = normalizeSessionError(error, "rpc session error");
    emitObservabilityEvent(this.#observability, {
      name: "rpc.session.error",
      attributes: {
        "rpc.outcome": "error",
      },
      error: normalized,
    });
    if (this.#onError) {
      await this.#onError(normalized);
      return;
    }
    throw normalized;
  }

  private assertOpen(): void {
    if (this.#closed) throw new SessionError("RpcSession is closed");
  }
}
