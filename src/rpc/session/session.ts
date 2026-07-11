/**
 * Cap'n Proto RPC session management.
 *
 * Binds a WASM peer to a transport, managing the inbound/outbound frame
 * lifecycle and coordinating session start/close semantics.
 *
 * @module
 */

import { normalizeSessionError, SessionError } from "../../errors.ts";
import {
  emitObservabilityEvent,
  type RpcObservability,
} from "../../observability/observability.ts";
import {
  createRuntimePeer,
  type RpcRuntimeModuleOptions,
} from "../server/runtime_module.ts";
import type { RpcTransport } from "../transports/internal/transport.ts";
import type { WasmPeer } from "../../wasm/peer.ts";

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
 * Options for creating an {@link RpcSession} via {@link RpcSession.create}.
 */
export interface RpcSessionCreateOptions extends RpcSessionOptions {
  /** Whether to start the session before returning. Defaults to `false`. */
  autoStart?: boolean;
  /** Optional runtime-module loading overrides. */
  runtimeModule?: RpcRuntimeModuleOptions;
}

/**
 * Operational snapshot for {@link RpcSession}.
 */
export interface RpcSessionStats {
  /** Whether {@link RpcSession.start} has completed successfully. */
  readonly started: boolean;
  /** Whether {@link RpcSession.start} is currently in progress. */
  readonly starting: boolean;
  /** Whether {@link RpcSession.close} has been called. */
  readonly closed: boolean;
  /** Number of transport start attempts made by this session. */
  readonly startAttempts: number;
  /** Number of failed transport start attempts. */
  readonly startFailures: number;
  /** Number of inbound frames whose processing has started. */
  readonly inboundFramesStarted: number;
  /** Number of inbound frames processed successfully. */
  readonly inboundFramesSucceeded: number;
  /** Number of inbound frames that failed during processing or outbound send. */
  readonly inboundFramesFailed: number;
  /** Number of inbound frame handlers currently running. */
  readonly inboundFramesInFlight: number;
  /** Total inbound frame bytes accepted for processing. */
  readonly inboundBytesReceived: number;
  /** Number of outbound frames successfully sent through the transport. */
  readonly outboundFramesSent: number;
  /** Total outbound frame bytes successfully sent through the transport. */
  readonly outboundBytesSent: number;
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
  #starting = false;
  #closed = false;
  #inboundChain: Promise<void> = Promise.resolve();
  #onError: RpcSessionOptions["onError"];
  #observability: RpcSessionOptions["observability"];
  #startAttempts = 0;
  #startFailures = 0;
  #inboundFramesStarted = 0;
  #inboundFramesSucceeded = 0;
  #inboundFramesFailed = 0;
  #inboundFramesInFlight = 0;
  #inboundBytesReceived = 0;
  #outboundFramesSent = 0;
  #outboundBytesSent = 0;

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

  /**
   * Create a session without requiring direct WASM peer wiring.
   *
   * This factory loads the default runtime module, creates a peer, and
   * constructs an {@link RpcSession}. Use the constructor directly only when
   * supplying your own peer implementation.
   */
  static async create(
    transport: RpcTransport,
    options: RpcSessionCreateOptions = {},
  ): Promise<RpcSession> {
    const peer = await createRuntimePeer(options.runtimeModule);
    const session = new RpcSession(peer, transport, {
      onError: options.onError,
      observability: options.observability,
    });
    if (options.autoStart ?? false) {
      try {
        await session.start();
      } catch (error) {
        try {
          peer.close();
        } catch {
          // no-op while unwinding startup errors.
        }
        throw error;
      }
    }
    return session;
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
   * Current session lifecycle and frame-processing counters.
   *
   * @returns A point-in-time stats snapshot suitable for logs and health checks.
   *
   * @example
   * ```ts
   * const stats = session.stats;
   * console.log(stats.inboundFramesFailed, stats.outboundFramesSent);
   * ```
   */
  get stats(): RpcSessionStats {
    return {
      started: this.#started,
      starting: this.#starting,
      closed: this.#closed,
      startAttempts: this.#startAttempts,
      startFailures: this.#startFailures,
      inboundFramesStarted: this.#inboundFramesStarted,
      inboundFramesSucceeded: this.#inboundFramesSucceeded,
      inboundFramesFailed: this.#inboundFramesFailed,
      inboundFramesInFlight: this.#inboundFramesInFlight,
      inboundBytesReceived: this.#inboundBytesReceived,
      outboundFramesSent: this.#outboundFramesSent,
      outboundBytesSent: this.#outboundBytesSent,
    };
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
    if (this.#starting) {
      throw new SessionError("RpcSession start is already in progress");
    }
    this.#starting = true;
    this.#startAttempts += 1;
    try {
      await this.transport.start((frame) => {
        this.#inboundChain = this.#inboundChain
          .then(() => this.pumpInboundFrame(frame))
          .catch((error) => this.handleError(error));
        return this.#inboundChain;
      });
      if (this.#closed) {
        throw new SessionError(
          "RpcSession was closed while start was in progress",
        );
      }
      this.#started = true;
      emitObservabilityEvent(this.#observability, {
        name: "rpc.session.start",
        attributes: {
          "rpc.outcome": "ok",
        },
        durationMs: performance.now() - startedAt,
      });
    } catch (error) {
      this.#startFailures += 1;
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
    } finally {
      this.#starting = false;
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
    this.#inboundFramesStarted += 1;
    this.#inboundFramesInFlight += 1;
    this.#inboundBytesReceived += frame.byteLength;
    try {
      const { frames: outbound } = this.peer.pushFrame(frame);
      let outboundBytes = 0;
      for (const out of outbound) {
        await this.transport.send(out);
        outboundBytes += out.byteLength;
        this.#outboundFramesSent += 1;
        this.#outboundBytesSent += out.byteLength;
      }
      this.#inboundFramesSucceeded += 1;
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
      this.#inboundFramesFailed += 1;
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
    } finally {
      this.#inboundFramesInFlight -= 1;
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
