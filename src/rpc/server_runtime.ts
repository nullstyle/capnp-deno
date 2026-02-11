import { SessionError } from "../errors.ts";
import {
  RpcServerBridge,
  type RpcServerBridgeOptions,
  type RpcServerWasmHost,
} from "./server.ts";
import {
  createRuntimePeer,
  type RpcRuntimeModuleOptions,
} from "./runtime_module.ts";
import {
  RpcServerCallInterceptTransport,
  RpcServerOutboundClient,
} from "./server_outbound.ts";
import { RpcSession, type RpcSessionOptions } from "./session.ts";
import type { RpcTransport } from "./transport.ts";
import type { WasmPeer } from "../wasm_peer.ts";

const DEFAULT_MAX_HOST_CALLS_PER_INBOUND_FRAME = 64;
const DEFAULT_MAX_HOST_CALLS_TOTAL = Number.MAX_SAFE_INTEGER;

class PostInboundHookTransport implements RpcTransport {
  readonly #inner: RpcTransport;
  readonly #afterInbound: (frame: Uint8Array) => Promise<void>;
  #afterInboundChain: Promise<void> = Promise.resolve();
  #afterInboundError: unknown = null;
  #deferredOutboundFrames: Uint8Array[] | null = null;

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
    await this.#inner.start((frame) => {
      const deferred: Uint8Array[] = [];
      this.#deferredOutboundFrames = deferred;
      const onFramePromise = Promise.resolve(onFrame(frame))
        .finally(() => {
          this.#deferredOutboundFrames = null;
        });
      this.#afterInboundChain = this.#afterInboundChain
        .then(async () => {
          if (this.#afterInboundError !== null) return;
          await onFramePromise;
          await this.#afterInbound(frame);
          for (const deferredFrame of deferred) {
            await this.#inner.send(deferredFrame);
          }
        })
        .catch((error) => {
          this.#afterInboundError ??= error;
        });
      return onFramePromise;
    });
  }

  async send(frame: Uint8Array): Promise<void> {
    if (this.#deferredOutboundFrames !== null) {
      this.#deferredOutboundFrames.push(new Uint8Array(frame));
      return;
    }
    await this.#inner.send(frame);
  }

  async close(): Promise<void> {
    await this.#inner.close();
  }

  async flushAfterInbound(): Promise<void> {
    await this.#afterInboundChain;
    if (this.#afterInboundError !== null) {
      throw this.#afterInboundError;
    }
  }
}

/**
 * Identifies the kind of warning emitted by {@link RpcServerRuntime}.
 *
 * - `"host_call_pump_unavailable"` - The WASM module does not expose the
 *   host-call bridge exports, so host-call pumping has been automatically disabled.
 * - `"host_call_pump_limit_reached"` - The configured maximum total host calls
 *   has been reached and further pumping is stopped.
 */
export type RpcServerRuntimeWarningCode =
  | "host_call_pump_unavailable"
  | "host_call_pump_limit_reached";

/**
 * A structured warning emitted by the {@link RpcServerRuntime} when
 * host-call pumping encounters a non-fatal issue.
 */
export interface RpcServerRuntimeWarning {
  /** The warning category. */
  code: RpcServerRuntimeWarningCode;
  /** A human-readable description of the warning. */
  message: string;
  /** The number of host calls pumped so far. */
  totalHostCallsPumped: number;
  /** The configured maximum total host calls allowed. */
  maxHostCallsTotal: number;
}

/**
 * Options controlling automatic host-call pumping in the {@link RpcServerRuntime}.
 *
 * After each inbound frame is processed, the runtime can automatically pump
 * host calls from the WASM peer, dispatching them to the server bridge.
 */
export interface RpcServerRuntimeHostCallPumpOptions {
  /**
   * Whether host-call pumping is enabled. Defaults to `true` if the WASM
   * module supports the host-call bridge; otherwise automatically disabled.
   */
  enabled?: boolean;
  /**
   * Maximum number of host calls to pump after each inbound frame.
   * Defaults to 64.
   */
  maxCallsPerInboundFrame?: number;
  /**
   * Maximum total number of host calls to pump over the runtime's lifetime.
   * Defaults to `Number.MAX_SAFE_INTEGER`.
   */
  maxCallsTotal?: number;
  /**
   * Whether to throw a {@link SessionError} when the total host-call limit
   * is reached. Defaults to `true`. When `false`, pumping is silently disabled
   * and a warning is emitted instead.
   */
  failOnLimit?: boolean;
  /**
   * Callback invoked when the runtime emits a warning about host-call pumping.
   * Exceptions thrown by this callback are silently ignored.
   */
  onWarning?: (
    warning: RpcServerRuntimeWarning,
  ) => void | Promise<void>;
}

/**
 * Configuration options for creating an {@link RpcServerRuntime}.
 */
export interface RpcServerRuntimeOptions {
  /** Options forwarded to the underlying {@link RpcSession}. */
  session?: RpcSessionOptions;
  /**
   * An explicit WASM host handle. When omitted, the runtime will attempt
   * to derive one from the peer's ABI capabilities.
   */
  wasmHost?: RpcServerWasmHost;
  /** Options controlling automatic host-call pumping behavior. */
  hostCallPump?: RpcServerRuntimeHostCallPumpOptions;
}

/**
 * Options for creating an {@link RpcServerRuntime} via
 * {@link RpcServerRuntime.create}.
 */
export interface RpcServerRuntimeCreateOptions extends RpcServerRuntimeOptions {
  /**
   * Whether to start the runtime before returning. Defaults to `true`.
   */
  autoStart?: boolean;
  /** Optional runtime-module loading overrides. */
  runtimeModule?: RpcRuntimeModuleOptions;
}

/**
 * Options for registering a root capability with
 * {@link RpcServerRuntime.createWithRoot}.
 */
export interface RpcServerRuntimeRootRegistrationOptions {
  capabilityIndex?: number;
  referenceCount?: number;
}

/**
 * Signature for generated `register*Server()` helpers accepted by
 * {@link RpcServerRuntime.createWithRoot}.
 */
export type RpcServerRuntimeRootRegistrar<TServer> = (
  bridge: RpcServerBridge,
  server: TServer,
  options?: RpcServerRuntimeRootRegistrationOptions,
) => { capabilityIndex: number };

/**
 * Options for creating an {@link RpcServerRuntime} and registering a root
 * capability in one step via {@link RpcServerRuntime.createWithRoot}.
 */
export interface RpcServerRuntimeCreateWithRootOptions
  extends RpcServerRuntimeCreateOptions {
  /**
   * Capability index returned from bootstrap. Defaults to `0`.
   */
  rootCapabilityIndex?: number;
  /**
   * Initial reference count for the registered root capability.
   * Defaults to `1`.
   */
  rootReferenceCount?: number;
  /**
   * Additional bridge configuration. `onBootstrap` is controlled by
   * `createWithRoot()` and cannot be overridden here.
   */
  bridgeOptions?: Omit<RpcServerBridgeOptions, "onBootstrap">;
}

/**
 * Options for a single invocation of {@link RpcServerRuntime.pumpHostCallsNow}.
 */
export interface RpcServerRuntimePumpOptions {
  /**
   * Maximum number of host calls to pump in this invocation.
   * Defaults to `maxCallsPerInboundFrame` from the runtime options.
   */
  maxCalls?: number;
}

/**
 * High-level server-side runtime that combines an {@link RpcSession}, a
 * {@link RpcServerBridge}, and a {@link WasmPeer} into a single managed unit.
 *
 * The runtime automatically pumps host calls from the WASM peer after each
 * inbound frame, dispatching them through the bridge to your server-side
 * handler. This eliminates the need for manual host-call pumping in most
 * server scenarios.
 *
 * Lifecycle:
 * 1. Construct with a peer, transport, and bridge.
 * 2. Call {@link start} to begin processing inbound frames.
 * 3. The runtime automatically pumps host calls after each frame.
 * 4. Call {@link close} to shut down.
 *
 * @example
 * ```ts
 * const runtime = new RpcServerRuntime(peer, transport, bridge);
 * await runtime.start();
 * // ... runtime processes frames and pumps host calls automatically ...
 * await runtime.close();
 * ```
 */
export class RpcServerRuntime {
  /** The underlying RPC session. */
  readonly session: RpcSession;
  /** The server bridge that dispatches host calls. */
  readonly bridge: RpcServerBridge;
  /** The WASM peer used for frame processing. */
  readonly peer: WasmPeer;
  readonly #postInboundHookTransport: PostInboundHookTransport;
  /**
   * Client for making outbound RPC calls on imported capabilities.
   *
   * Use this to call methods on capabilities received as parameters
   * from the remote peer (e.g., calling `Collaborator.offer()` on a
   * capability passed in a `collaborate` call).
   *
   * The `call` and `callRaw` signatures are compatible with
   * `SessionRpcClientTransport`, so generated client stubs can use
   * either transport interchangeably.
   */
  readonly outboundClient: RpcServerOutboundClient;

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

    // Wrap the real transport with an interceptor that captures Return
    // frames for server-originated outbound calls before they reach
    // the WASM peer (which has no knowledge of these calls).
    const interceptor = new RpcServerCallInterceptTransport(transport);
    this.outboundClient = new RpcServerOutboundClient(interceptor);
    this.bridge.setOutboundClient(this.outboundClient);

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
      interceptor,
      (_frame) => this.#afterInboundFrame(),
    );
    this.#postInboundHookTransport = hooked;
    this.session = new RpcSession(peer, hooked, options.session ?? {});
  }

  /**
   * Create a server runtime without requiring direct WASM peer wiring.
   *
   * This factory loads the default runtime module, creates a peer, and
   * constructs an {@link RpcServerRuntime}.
   */
  static async create(
    transport: RpcTransport,
    bridge: RpcServerBridge,
    options: RpcServerRuntimeCreateOptions = {},
  ): Promise<RpcServerRuntime> {
    const { autoStart, runtimeModule, ...runtimeOptions } = options;
    const peer = await createRuntimePeer(runtimeModule);
    const runtime = new RpcServerRuntime(
      peer,
      transport,
      bridge,
      runtimeOptions,
    );
    if (autoStart ?? true) {
      try {
        await runtime.start();
      } catch (error) {
        try {
          await runtime.close();
        } catch {
          // no-op while unwinding startup errors.
        }
        throw error;
      }
    }
    return runtime;
  }

  /**
   * Create a server runtime and register a root capability in one step.
   *
   * This is the high-level path for generated server stubs:
   *
   * ```ts
   * const runtime = await RpcServerRuntime.createWithRoot(
   *   transport,
   *   registerEchoServer,
   *   { echo: ({ value }) => ({ value: value + 1 }) },
   * );
   * ```
   *
   * `createWithRoot()` creates an internal bridge with bootstrap configured
   * to return the chosen root capability index (default `0`), registers the
   * provided server implementation via `registerRoot`, and then delegates to
   * {@link create} for runtime construction.
   */
  static async createWithRoot<TServer>(
    transport: RpcTransport,
    registerRoot: RpcServerRuntimeRootRegistrar<TServer>,
    server: TServer,
    options: RpcServerRuntimeCreateWithRootOptions = {},
  ): Promise<RpcServerRuntime> {
    const {
      rootCapabilityIndex,
      rootReferenceCount,
      bridgeOptions,
      ...runtimeOptions
    } = options;

    const resolvedRootCapabilityIndex = rootCapabilityIndex ?? 0;
    const resolvedRootReferenceCount = rootReferenceCount ?? 1;

    if (
      !Number.isInteger(resolvedRootCapabilityIndex) ||
      resolvedRootCapabilityIndex < 0
    ) {
      throw new SessionError(
        `rootCapabilityIndex must be a non-negative integer, got ${
          String(resolvedRootCapabilityIndex)
        }`,
      );
    }
    if (
      !Number.isInteger(resolvedRootReferenceCount) ||
      resolvedRootReferenceCount <= 0
    ) {
      throw new SessionError(
        `rootReferenceCount must be a positive integer, got ${
          String(resolvedRootReferenceCount)
        }`,
      );
    }

    const bridge = new RpcServerBridge({
      ...bridgeOptions,
      nextCapabilityIndex: bridgeOptions?.nextCapabilityIndex ??
        (resolvedRootCapabilityIndex + 1),
      onBootstrap: () => ({
        capabilityIndex: resolvedRootCapabilityIndex,
      }),
    });

    const rootCapability = registerRoot(
      bridge,
      server,
      {
        capabilityIndex: resolvedRootCapabilityIndex,
        referenceCount: resolvedRootReferenceCount,
      },
    );
    if (rootCapability.capabilityIndex !== resolvedRootCapabilityIndex) {
      throw new SessionError(
        `registerRoot must register at capabilityIndex ${resolvedRootCapabilityIndex}, got ${rootCapability.capabilityIndex}`,
      );
    }

    return await RpcServerRuntime.create(
      transport,
      bridge,
      runtimeOptions,
    );
  }

  /** Whether the underlying session has been started. */
  get started(): boolean {
    return this.session.started;
  }

  /** Whether the underlying session has been closed. */
  get closed(): boolean {
    return this.session.closed;
  }

  /** The total number of host calls pumped since this runtime was created. */
  get totalHostCallsPumped(): number {
    return this.#totalHostCallsPumped;
  }

  /** Whether host-call pumping has been permanently disabled due to a limit being reached. */
  get hostCallPumpDisabled(): boolean {
    return this.#hostCallPumpDisabled;
  }

  /**
   * Start the underlying RPC session, beginning inbound frame processing
   * and automatic host-call pumping.
   */
  async start(): Promise<void> {
    await this.session.start();
  }

  /** Flush any pending outbound frames in the session. */
  async flush(): Promise<void> {
    await this.session.flush();
    await this.#postInboundHookTransport.flushAfterInbound();
  }

  /** Close the underlying RPC session and stop processing. */
  async close(): Promise<void> {
    await this.session.close();
    try {
      await this.#postInboundHookTransport.flushAfterInbound();
    } catch {
      // no-op during close; close mirrors RpcSession's best-effort flush.
    }
  }

  /**
   * Manually pump host calls from the WASM peer right now, outside of the
   * automatic post-inbound-frame pumping cycle.
   *
   * @param options - Options controlling the maximum number of calls to pump.
   * @returns The number of host calls actually handled in this invocation.
   * @throws {SessionError} If the host-call limit is reached and `failOnLimit` is `true`.
   */
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
    const { frames: outbound } = this.peer.drainOutgoingFrames();
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
