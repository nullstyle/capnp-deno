import { TransportError } from "./errors.ts";
import type { RpcTransport } from "./transport.ts";

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
