import { SessionError } from "./errors.ts";
import type { RpcServerBridge, RpcServerWasmHost } from "./rpc_server.ts";
import { RpcSession, type RpcSessionOptions } from "./session.ts";
import type { RpcTransport } from "./transport.ts";
import type { WasmPeer } from "./wasm_peer.ts";

const DEFAULT_MAX_HOST_CALLS_PER_INBOUND_FRAME = 64;
const DEFAULT_MAX_HOST_CALLS_TOTAL = Number.MAX_SAFE_INTEGER;

class PostInboundHookTransport implements RpcTransport {
  readonly #inner: RpcTransport;
  readonly #afterInbound: (frame: Uint8Array) => Promise<void>;

  constructor(
    inner: RpcTransport,
    afterInbound: (frame: Uint8Array) => Promise<void>,
  ) {
    this.#inner = inner;
    this.#afterInbound = afterInbound;
  }

  async start(
    onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): Promise<void> {
    await this.#inner.start(async (frame) => {
      await onFrame(frame);
      await this.#afterInbound(frame);
    });
  }

  async send(frame: Uint8Array): Promise<void> {
    await this.#inner.send(frame);
  }

  async close(): Promise<void> {
    await this.#inner.close();
  }
}

export type RpcServerRuntimeWarningCode =
  | "host_call_pump_unavailable"
  | "host_call_pump_limit_reached";

export interface RpcServerRuntimeWarning {
  code: RpcServerRuntimeWarningCode;
  message: string;
  totalHostCallsPumped: number;
  maxHostCallsTotal: number;
}

export interface RpcServerRuntimeHostCallPumpOptions {
  enabled?: boolean;
  maxCallsPerInboundFrame?: number;
  maxCallsTotal?: number;
  failOnLimit?: boolean;
  onWarning?: (
    warning: RpcServerRuntimeWarning,
  ) => void | Promise<void>;
}

export interface RpcServerRuntimeOptions {
  session?: RpcSessionOptions;
  wasmHost?: RpcServerWasmHost;
  hostCallPump?: RpcServerRuntimeHostCallPumpOptions;
}

export interface RpcServerRuntimePumpOptions {
  maxCalls?: number;
}

export class RpcServerRuntime {
  readonly session: RpcSession;
  readonly bridge: RpcServerBridge;
  readonly peer: WasmPeer;

  #wasmHost: RpcServerWasmHost | null;
  #hostCallPumpEnabled: boolean;
  #hostCallPumpDisabled = false;
  #maxHostCallsPerInboundFrame: number;
  #maxHostCallsTotal: number;
  #failOnHostCallLimit: boolean;
  #onWarning?: RpcServerRuntimeHostCallPumpOptions["onWarning"];
  #totalHostCallsPumped = 0;

  constructor(
    peer: WasmPeer,
    transport: RpcTransport,
    bridge: RpcServerBridge,
    options: RpcServerRuntimeOptions = {},
  ) {
    this.peer = peer;
    this.bridge = bridge;
    this.#wasmHost = options.wasmHost ??
      (peer.abi.capabilities.hasHostCallBridge
        ? {
          handle: peer.handle,
          abi: {
            supportsHostCallReturnFrame:
              peer.abi.capabilities.hasHostCallReturnFrame,
            popHostCall: (handle) => peer.abi.popHostCall(handle),
            respondHostCallReturnFrame: (handle, frame) =>
              peer.abi.respondHostCallReturnFrame(handle, frame),
            respondHostCallResults: (handle, questionId, payloadFrame) =>
              peer.abi.respondHostCallResults(handle, questionId, payloadFrame),
            respondHostCallException: (handle, questionId, reason) =>
              peer.abi.respondHostCallException(handle, questionId, reason),
          },
        }
        : null);

    const hostCallPump = options.hostCallPump ?? {};
    this.#hostCallPumpEnabled = hostCallPump.enabled ?? true;
    this.#maxHostCallsPerInboundFrame = hostCallPump.maxCallsPerInboundFrame ??
      DEFAULT_MAX_HOST_CALLS_PER_INBOUND_FRAME;
    this.#maxHostCallsTotal = hostCallPump.maxCallsTotal ??
      DEFAULT_MAX_HOST_CALLS_TOTAL;
    this.#failOnHostCallLimit = hostCallPump.failOnLimit ?? true;
    this.#onWarning = hostCallPump.onWarning;

    if (
      this.#hostCallPumpEnabled && (this.#maxHostCallsPerInboundFrame <= 0 ||
        !Number.isInteger(this.#maxHostCallsPerInboundFrame))
    ) {
      throw new SessionError(
        `maxCallsPerInboundFrame must be a positive integer, got ${
          String(this.#maxHostCallsPerInboundFrame)
        }`,
      );
    }
    if (
      this.#hostCallPumpEnabled &&
      (this.#maxHostCallsTotal <= 0 ||
        !Number.isInteger(this.#maxHostCallsTotal))
    ) {
      throw new SessionError(
        `maxCallsTotal must be a positive integer, got ${
          String(this.#maxHostCallsTotal)
        }`,
      );
    }

    if (this.#hostCallPumpEnabled && this.#wasmHost === null) {
      if (hostCallPump.enabled === true) {
        throw new SessionError(
          "host-call pump was explicitly enabled, but wasm host-call bridge exports are unavailable",
        );
      }
      this.#hostCallPumpEnabled = false;
      void this.#emitWarning({
        code: "host_call_pump_unavailable",
        message:
          "host-call pump is disabled because wasm host-call bridge exports are unavailable",
        totalHostCallsPumped: 0,
        maxHostCallsTotal: this.#maxHostCallsTotal,
      });
    }

    const hooked = new PostInboundHookTransport(
      transport,
      (_frame) => this.#afterInboundFrame(),
    );
    this.session = new RpcSession(peer, hooked, options.session ?? {});
  }

  get started(): boolean {
    return this.session.started;
  }

  get closed(): boolean {
    return this.session.closed;
  }

  get totalHostCallsPumped(): number {
    return this.#totalHostCallsPumped;
  }

  get hostCallPumpDisabled(): boolean {
    return this.#hostCallPumpDisabled;
  }

  async start(): Promise<void> {
    await this.session.start();
  }

  async flush(): Promise<void> {
    await this.session.flush();
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  async pumpHostCallsNow(
    options: RpcServerRuntimePumpOptions = {},
  ): Promise<number> {
    if (
      !this.#hostCallPumpEnabled || this.#hostCallPumpDisabled ||
      this.#wasmHost === null
    ) {
      return 0;
    }

    const maxCalls = options.maxCalls ?? this.#maxHostCallsPerInboundFrame;
    if (!Number.isInteger(maxCalls) || maxCalls <= 0) {
      throw new SessionError(
        `maxCalls must be a positive integer when provided, got ${
          String(maxCalls)
        }`,
      );
    }

    const remaining = this.#maxHostCallsTotal - this.#totalHostCallsPumped;
    if (remaining <= 0) {
      await this.#onHostCallLimitReached();
      return 0;
    }

    const budget = Math.min(maxCalls, remaining);
    const handled = await this.bridge.pumpWasmHostCalls(
      this.#wasmHost,
      { maxCalls: budget },
    );
    if (handled > 0) {
      this.#totalHostCallsPumped += handled;
      await this.#flushPeerOutboundFrames();
    }
    if (this.#totalHostCallsPumped >= this.#maxHostCallsTotal) {
      await this.#onHostCallLimitReached();
    }
    return handled;
  }

  async #afterInboundFrame(): Promise<void> {
    await this.pumpHostCallsNow();
  }

  async #flushPeerOutboundFrames(): Promise<void> {
    const outbound = this.peer.drainOutgoingFrames();
    for (const frame of outbound) {
      await this.session.transport.send(frame);
    }
  }

  async #onHostCallLimitReached(): Promise<void> {
    const warning: RpcServerRuntimeWarning = {
      code: "host_call_pump_limit_reached",
      message:
        `host-call pump limit reached (${this.#maxHostCallsTotal}); host-call pumping has been bounded by runtime policy`,
      totalHostCallsPumped: this.#totalHostCallsPumped,
      maxHostCallsTotal: this.#maxHostCallsTotal,
    };

    if (this.#failOnHostCallLimit) {
      throw new SessionError(warning.message);
    }
    if (this.#hostCallPumpDisabled) return;
    this.#hostCallPumpDisabled = true;
    await this.#emitWarning(warning);
  }

  async #emitWarning(warning: RpcServerRuntimeWarning): Promise<void> {
    if (!this.#onWarning) return;
    try {
      await this.#onWarning(warning);
    } catch {
      // Warnings must never impact runtime behavior.
    }
  }
}
