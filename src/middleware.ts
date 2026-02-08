import { TransportError } from "./errors.ts";
import type { RpcTransport } from "./transport.ts";
import {
  decodeRpcMessageTag,
  RPC_MESSAGE_TAG_BOOTSTRAP,
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_FINISH,
  RPC_MESSAGE_TAG_RELEASE,
  RPC_MESSAGE_TAG_RETURN,
} from "./rpc_wire.ts";

/**
 * Result of a middleware hook. Middleware can:
 * - Return a (possibly transformed) frame to continue processing.
 * - Return `null` to drop/reject the frame silently.
 *
 * Both sync and async returns are supported.
 */
export type MiddlewareResult = Uint8Array | null;

/**
 * Interceptor that can inspect and transform frames flowing through a
 * transport. Implement one or both hooks to add cross-cutting behavior
 * such as logging, compression, encryption, metrics, or rate limiting.
 *
 * Middleware hooks receive the raw frame bytes and return:
 * - A `Uint8Array` (original or transformed) to continue the pipeline.
 * - `null` to silently drop the frame.
 * - A thrown error to reject the frame with an error.
 *
 * @example
 * ```ts
 * const logger: RpcTransportMiddleware = {
 *   onSend(frame) {
 *     console.log("sending", frame.byteLength, "bytes");
 *     return frame;
 *   },
 *   onReceive(frame) {
 *     console.log("received", frame.byteLength, "bytes");
 *     return frame;
 *   },
 * };
 * ```
 */
export interface RpcTransportMiddleware {
  /**
   * Called before a frame is sent through the underlying transport.
   *
   * @param frame - The raw frame bytes about to be sent.
   * @returns The frame to actually send, or `null` to drop it.
   */
  onSend?: (
    frame: Uint8Array,
  ) => MiddlewareResult | Promise<MiddlewareResult>;

  /**
   * Called when a frame is received from the underlying transport, before
   * it is delivered to the session layer.
   *
   * @param frame - The raw frame bytes received from the remote peer.
   * @returns The frame to deliver upstream, or `null` to drop it.
   */
  onReceive?: (
    frame: Uint8Array,
  ) => MiddlewareResult | Promise<MiddlewareResult>;
}

/**
 * A transport wrapper that applies a stack of {@link RpcTransportMiddleware}
 * interceptors to every frame flowing through an underlying transport.
 *
 * Middleware is applied in order:
 * - **onSend**: first middleware in the array is called first (outermost).
 * - **onReceive**: first middleware in the array is called first (outermost).
 *
 * If any middleware returns `null`, the frame is dropped and subsequent
 * middleware in the chain is not invoked.
 *
 * @example
 * ```ts
 * const inner = await TcpTransport.connect("localhost", 4000);
 * const transport = new MiddlewareTransport(inner, [
 *   createLoggingMiddleware(),
 *   createFrameSizeLimitMiddleware(1024 * 1024),
 * ]);
 * const session = new RpcSession(peer, transport);
 * ```
 */
export class MiddlewareTransport implements RpcTransport {
  /** The underlying transport being wrapped. */
  readonly inner: RpcTransport;
  /** The middleware stack applied to this transport. */
  readonly middleware: readonly RpcTransportMiddleware[];

  constructor(
    inner: RpcTransport,
    middleware: RpcTransportMiddleware[],
  ) {
    this.inner = inner;
    this.middleware = [...middleware];
  }

  /**
   * Starts the underlying transport, wrapping the `onFrame` callback to
   * apply the receive-side middleware chain.
   */
  start(
    onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): void | Promise<void> {
    return this.inner.start(async (frame: Uint8Array) => {
      const result = await this.#applyReceiveChain(frame);
      if (result === null) return;
      await onFrame(result);
    });
  }

  /**
   * Sends a frame through the send-side middleware chain, then through
   * the underlying transport. If any middleware returns `null`, the
   * frame is dropped and the underlying transport's `send` is not called.
   */
  async send(frame: Uint8Array): Promise<void> {
    const result = await this.#applySendChain(frame);
    if (result === null) return;
    await this.inner.send(result);
  }

  /**
   * Closes the underlying transport.
   */
  close(): void | Promise<void> {
    return this.inner.close();
  }

  async #applySendChain(frame: Uint8Array): Promise<Uint8Array | null> {
    let current: Uint8Array | null = frame;
    for (const mw of this.middleware) {
      if (current === null) break;
      if (mw.onSend) {
        current = await mw.onSend(current);
      }
    }
    return current;
  }

  async #applyReceiveChain(frame: Uint8Array): Promise<Uint8Array | null> {
    let current: Uint8Array | null = frame;
    for (const mw of this.middleware) {
      if (current === null) break;
      if (mw.onReceive) {
        current = await mw.onReceive(current);
      }
    }
    return current;
  }
}

/**
 * Options for {@link createLoggingMiddleware}.
 */
export interface LoggingMiddlewareOptions {
  /**
   * Custom log function. Defaults to `console.log`.
   */
  log?: (message: string) => void;
  /**
   * Prefix prepended to all log messages. Defaults to `"[rpc]"`.
   */
  prefix?: string;
}

/**
 * Creates a middleware that logs frame sizes and directions.
 *
 * @param options - Optional configuration for the logger.
 * @returns A middleware that logs send and receive frame metadata.
 *
 * @example
 * ```ts
 * const transport = new MiddlewareTransport(inner, [
 *   createLoggingMiddleware({ prefix: "[my-service]" }),
 * ]);
 * ```
 */
export function createLoggingMiddleware(
  options: LoggingMiddlewareOptions = {},
): RpcTransportMiddleware {
  const log = options.log ?? console.log;
  const prefix = options.prefix ?? "[rpc]";

  return {
    onSend(frame: Uint8Array): Uint8Array {
      log(`${prefix} send ${frame.byteLength} bytes`);
      return frame;
    },
    onReceive(frame: Uint8Array): Uint8Array {
      log(`${prefix} recv ${frame.byteLength} bytes`);
      return frame;
    },
  };
}

/**
 * Options for {@link createFrameSizeLimitMiddleware}.
 */
export interface FrameSizeLimitMiddlewareOptions {
  /**
   * Direction(s) to enforce. Defaults to `"both"`.
   * - `"send"` - Only limit outbound frames.
   * - `"receive"` - Only limit inbound frames.
   * - `"both"` - Limit frames in both directions.
   */
  direction?: "send" | "receive" | "both";
}

/**
 * Creates a middleware that rejects frames exceeding a maximum byte size.
 *
 * Oversized frames cause a {@link TransportError} to be thrown, preventing
 * them from reaching the transport or session layer.
 *
 * @param maxBytes - The maximum allowed frame size in bytes.
 * @param options - Optional configuration.
 * @returns A middleware that enforces frame size limits.
 *
 * @example
 * ```ts
 * const transport = new MiddlewareTransport(inner, [
 *   createFrameSizeLimitMiddleware(1024 * 1024), // 1 MB
 * ]);
 * ```
 */
export function createFrameSizeLimitMiddleware(
  maxBytes: number,
  options: FrameSizeLimitMiddlewareOptions = {},
): RpcTransportMiddleware {
  const direction = options.direction ?? "both";
  const checkSend = direction === "send" || direction === "both";
  const checkReceive = direction === "receive" || direction === "both";

  function enforceLimit(frame: Uint8Array, dir: string): Uint8Array {
    if (frame.byteLength > maxBytes) {
      throw new TransportError(
        `frame size ${frame.byteLength} bytes exceeds limit of ${maxBytes} bytes (${dir})`,
      );
    }
    return frame;
  }

  return {
    onSend: checkSend
      ? (frame: Uint8Array) => enforceLimit(frame, "send")
      : undefined,
    onReceive: checkReceive
      ? (frame: Uint8Array) => enforceLimit(frame, "receive")
      : undefined,
  };
}

/**
 * Direction a frame is flowing through the transport.
 */
export type RpcFrameDirection = "send" | "receive";

/**
 * Callbacks for {@link createRpcIntrospectionMiddleware}.
 *
 * Each callback receives the raw frame and the direction it is flowing.
 * All callbacks are optional; unspecified message types are silently ignored.
 */
export interface RpcIntrospectionCallbacks {
  /** Called when a Bootstrap message is observed. */
  onBootstrap?: (frame: Uint8Array, direction: RpcFrameDirection) => void;
  /** Called when a Call message is observed. */
  onCall?: (frame: Uint8Array, direction: RpcFrameDirection) => void;
  /** Called when a Return message is observed. */
  onReturn?: (frame: Uint8Array, direction: RpcFrameDirection) => void;
  /** Called when a Finish message is observed. */
  onFinish?: (frame: Uint8Array, direction: RpcFrameDirection) => void;
  /** Called when a Release message is observed. */
  onRelease?: (frame: Uint8Array, direction: RpcFrameDirection) => void;
  /** Called when a message with an unrecognized tag is observed. */
  onUnknown?: (
    frame: Uint8Array,
    tag: number,
    direction: RpcFrameDirection,
  ) => void;
  /** Called when decoding the message tag fails. */
  onDecodeError?: (
    frame: Uint8Array,
    error: unknown,
    direction: RpcFrameDirection,
  ) => void;
}

/**
 * Creates a middleware that decodes the RPC message tag from each frame and
 * dispatches to user-provided callbacks based on the message type.
 *
 * This middleware is observation-only: frames are never modified or dropped.
 * Only the first word of the message (the tag) is decoded for efficiency.
 *
 * @param callbacks - Per-message-type observation callbacks.
 * @returns A middleware that inspects RPC message types.
 *
 * @example
 * ```ts
 * const transport = new MiddlewareTransport(inner, [
 *   createRpcIntrospectionMiddleware({
 *     onCall(frame, dir) { console.log(`Call ${dir}`, frame.byteLength); },
 *     onReturn(frame, dir) { console.log(`Return ${dir}`, frame.byteLength); },
 *   }),
 * ]);
 * ```
 */
export function createRpcIntrospectionMiddleware(
  callbacks: RpcIntrospectionCallbacks,
): RpcTransportMiddleware {
  function inspect(frame: Uint8Array, direction: RpcFrameDirection): void {
    let tag: number;
    try {
      tag = decodeRpcMessageTag(frame);
    } catch (err: unknown) {
      callbacks.onDecodeError?.(frame, err, direction);
      return;
    }

    switch (tag) {
      case RPC_MESSAGE_TAG_BOOTSTRAP:
        callbacks.onBootstrap?.(frame, direction);
        break;
      case RPC_MESSAGE_TAG_CALL:
        callbacks.onCall?.(frame, direction);
        break;
      case RPC_MESSAGE_TAG_RETURN:
        callbacks.onReturn?.(frame, direction);
        break;
      case RPC_MESSAGE_TAG_FINISH:
        callbacks.onFinish?.(frame, direction);
        break;
      case RPC_MESSAGE_TAG_RELEASE:
        callbacks.onRelease?.(frame, direction);
        break;
      default:
        callbacks.onUnknown?.(frame, tag, direction);
        break;
    }
  }

  return {
    onSend(frame: Uint8Array): Uint8Array {
      inspect(frame, "send");
      return frame;
    },
    onReceive(frame: Uint8Array): Uint8Array {
      inspect(frame, "receive");
      return frame;
    },
  };
}

/**
 * Per-message-type frame counters used by {@link RpcMetricsSnapshot}.
 */
export interface RpcMetricsFramesByType {
  /** Number of Bootstrap messages observed. */
  bootstrap: number;
  /** Number of Call messages observed. */
  call: number;
  /** Number of Return messages observed. */
  return: number;
  /** Number of Finish messages observed. */
  finish: number;
  /** Number of Release messages observed. */
  release: number;
  /** Number of messages with unrecognized or undecoded tags. */
  unknown: number;
}

/**
 * A point-in-time snapshot of RPC transport metrics.
 */
export interface RpcMetricsSnapshot {
  /** Total number of frames sent. */
  totalFramesSent: number;
  /** Total number of frames received. */
  totalFramesReceived: number;
  /** Total bytes sent across all frames. */
  totalBytesSent: number;
  /** Total bytes received across all frames. */
  totalBytesReceived: number;
  /** Frame counts broken down by RPC message type. */
  framesByType: RpcMetricsFramesByType;
}

/**
 * Options for {@link createRpcMetricsMiddleware}.
 */
export interface RpcMetricsMiddlewareOptions {
  /**
   * If set, the `onSnapshot` callback will be invoked every this many
   * frames (counting both sent and received).
   */
  snapshotIntervalFrames?: number;
  /**
   * Callback invoked at the cadence specified by `snapshotIntervalFrames`.
   */
  onSnapshot?: (metrics: RpcMetricsSnapshot) => void;
}

/**
 * The object returned by {@link createRpcMetricsMiddleware}, containing
 * both the middleware itself and control methods.
 */
export interface RpcMetricsMiddleware {
  /** The middleware to install in a {@link MiddlewareTransport}. */
  middleware: RpcTransportMiddleware;
  /** Returns a snapshot of the current metrics. */
  snapshot(): RpcMetricsSnapshot;
  /** Resets all counters to zero. */
  reset(): void;
}

/**
 * Creates a middleware that tracks RPC transport metrics including frame
 * counts, byte totals, and per-message-type breakdowns.
 *
 * The returned object exposes `snapshot()` and `reset()` methods alongside
 * the middleware itself.
 *
 * @param options - Optional configuration including periodic snapshot callbacks.
 * @returns An object containing the middleware and metric access methods.
 *
 * @example
 * ```ts
 * const metrics = createRpcMetricsMiddleware({ snapshotIntervalFrames: 100 });
 * const transport = new MiddlewareTransport(inner, [metrics.middleware]);
 * // Later:
 * console.log(metrics.snapshot());
 * metrics.reset();
 * ```
 */
export function createRpcMetricsMiddleware(
  options: RpcMetricsMiddlewareOptions = {},
): RpcMetricsMiddleware {
  let totalFramesSent = 0;
  let totalFramesReceived = 0;
  let totalBytesSent = 0;
  let totalBytesReceived = 0;
  let bootstrap = 0;
  let call = 0;
  let ret = 0;
  let finish = 0;
  let release = 0;
  let unknown = 0;
  let totalFrames = 0;

  const snapshotInterval = options.snapshotIntervalFrames;
  const onSnapshot = options.onSnapshot;

  function makeSnapshot(): RpcMetricsSnapshot {
    return {
      totalFramesSent,
      totalFramesReceived,
      totalBytesSent,
      totalBytesReceived,
      framesByType: {
        bootstrap,
        call,
        return: ret,
        finish,
        release,
        unknown,
      },
    };
  }

  function classifyTag(frame: Uint8Array): void {
    let tag: number;
    try {
      tag = decodeRpcMessageTag(frame);
    } catch {
      unknown += 1;
      return;
    }

    switch (tag) {
      case RPC_MESSAGE_TAG_BOOTSTRAP:
        bootstrap += 1;
        break;
      case RPC_MESSAGE_TAG_CALL:
        call += 1;
        break;
      case RPC_MESSAGE_TAG_RETURN:
        ret += 1;
        break;
      case RPC_MESSAGE_TAG_FINISH:
        finish += 1;
        break;
      case RPC_MESSAGE_TAG_RELEASE:
        release += 1;
        break;
      default:
        unknown += 1;
        break;
    }
  }

  function maybeFireSnapshot(): void {
    if (
      snapshotInterval !== undefined && snapshotInterval > 0 &&
      onSnapshot && totalFrames % snapshotInterval === 0
    ) {
      onSnapshot(makeSnapshot());
    }
  }

  const middleware: RpcTransportMiddleware = {
    onSend(frame: Uint8Array): Uint8Array {
      totalFramesSent += 1;
      totalBytesSent += frame.byteLength;
      classifyTag(frame);
      totalFrames += 1;
      maybeFireSnapshot();
      return frame;
    },
    onReceive(frame: Uint8Array): Uint8Array {
      totalFramesReceived += 1;
      totalBytesReceived += frame.byteLength;
      classifyTag(frame);
      totalFrames += 1;
      maybeFireSnapshot();
      return frame;
    },
  };

  return {
    middleware,
    snapshot: makeSnapshot,
    reset(): void {
      totalFramesSent = 0;
      totalFramesReceived = 0;
      totalBytesSent = 0;
      totalBytesReceived = 0;
      bootstrap = 0;
      call = 0;
      ret = 0;
      finish = 0;
      release = 0;
      unknown = 0;
      totalFrames = 0;
    },
  };
}
