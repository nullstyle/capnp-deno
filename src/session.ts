import { normalizeSessionError, SessionError } from "./errors.ts";
import {
  emitObservabilityEvent,
  type RpcObservability,
} from "./observability.ts";
import type { RpcTransport } from "./transport.ts";
import type { WasmPeer } from "./wasm_peer.ts";

export interface RpcSessionOptions {
  onError?: (error: unknown) => void | Promise<void>;
  observability?: RpcObservability;
}

export class RpcSession {
  readonly peer: WasmPeer;
  readonly transport: RpcTransport;

  #started = false;
  #closed = false;
  #inboundChain: Promise<void> = Promise.resolve();
  #onError: RpcSessionOptions["onError"];
  #observability: RpcSessionOptions["observability"];

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

  get started(): boolean {
    return this.#started;
  }

  get closed(): boolean {
    return this.#closed;
  }

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

  async flush(): Promise<void> {
    await this.#inboundChain;
  }

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
