/**
 * WebSocket transport for Cap'n Proto RPC.
 *
 * @module
 */

import { normalizeTransportError, TransportError } from "../../errors.ts";
import {
  type CapnpFrameLimitsOptions,
  validateCapnpFrame,
} from "../wire/frame_limits.ts";
import {
  emitObservabilityEvent,
  type RpcObservability,
} from "../../observability/observability.ts";
import { SessionError } from "../../errors.ts";
import {
  type RpcAcceptedTransport,
  type RpcAcceptedTransportAddress,
  RpcAcceptedTransportQueue,
  type RpcTransportAcceptSource,
} from "./internal/accept.ts";
import type { RpcTransport } from "./internal/transport.ts";
import {
  notifyTransportClose,
  OutboundFrameQueue,
  type QueuedOutboundFrame,
} from "./internal/transport_internal.ts";

interface PendingOutboundFrame extends QueuedOutboundFrame {
  enqueuedAt: number;
}

/**
 * Configuration options for {@link WebSocketTransport}.
 */
export interface WebSocketTransportOptions {
  /**
   * Error handler invoked when the transport encounters an error.
   * If not provided, errors are thrown.
   */
  onError?: (error: unknown) => void | Promise<void>;
  /**
   * Lifecycle callback invoked once when the transport transitions to closed.
   *
   * This fires for both local close() and remote peer disconnects.
   */
  onClose?: () => void | Promise<void>;
  /**
   * Whether to reject WebSocket text frames. Cap'n Proto uses binary only.
   * Defaults to `true`.
   */
  rejectTextFrames?: boolean;
  /** Cap'n Proto frame validation limits applied to inbound frames. */
  frameLimits?: CapnpFrameLimitsOptions;
  /** Maximum allowed size in bytes for a single inbound frame. */
  maxInboundFrameBytes?: number;
  /** Maximum allowed size in bytes for a single outbound frame. */
  maxOutboundFrameBytes?: number;
  /** Maximum number of outbound frames that can be queued. */
  maxQueuedOutboundFrames?: number;
  /** Maximum total bytes across all queued outbound frames. */
  maxQueuedOutboundBytes?: number;
  /**
   * Maximum bytes the WebSocket is allowed to have buffered before the
   * transport applies backpressure (waits before sending more).
   */
  maxSocketBufferedAmountBytes?: number;
  /** Maximum time in milliseconds for a send operation before timing out. */
  sendTimeoutMs?: number;
  /** Maximum time in milliseconds to wait for the WebSocket connection to open. */
  connectTimeoutMs?: number;
  /** Maximum time in milliseconds to wait for the WebSocket to close gracefully. */
  closeTimeoutMs?: number;
  /**
   * Interval in milliseconds between backpressure checks when waiting for
   * the socket's buffered amount to drain. Defaults to 4.
   */
  outboundDrainIntervalMs?: number;
  /** Observability provider for emitting transport events. */
  observability?: RpcObservability;
}

export interface WebSocketTransportHandlerOptions {
  /** Restrict accepted requests to this URL path. */
  path?: string;
  /** Supported sub-protocol(s) for the WebSocket handshake. */
  protocols?: string | readonly string[];
  /** Transport options applied to accepted WebSocket connections. */
  transport?: WebSocketTransportOptions;
  /** Callback invoked when request upgrade or accept logic fails. */
  onConnectionError?: (error: unknown) => void | Promise<void>;
  /** Observability provider for emitting handler/listener events. */
  observability?: RpcObservability;
}

export interface WebSocketTransportListenOptions
  extends WebSocketTransportHandlerOptions {
  /** TCP port to bind the HTTP listener to. */
  port: number;
  /** Hostname/address to bind to. Defaults to `"0.0.0.0"`. */
  hostname?: string;
}

export interface WebSocketTransportHandler extends RpcTransportAcceptSource {
  accept(): AsyncIterable<AcceptedWebSocketTransport>;
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface WebSocketTransportListener extends WebSocketTransportHandler {
  readonly addr: Deno.Addr;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function requireDenoServe(): typeof Deno.serve {
  const maybeServe = (Deno as unknown as { serve?: typeof Deno.serve }).serve;
  if (typeof maybeServe !== "function") {
    throw new SessionError(
      "Deno.serve is unavailable; run with a runtime that supports HTTP/WebSocket serve",
    );
  }
  return maybeServe;
}

function isWebSocketUpgradeRequest(request: Request): boolean {
  const upgrade = request.headers.get("upgrade");
  return typeof upgrade === "string" && upgrade.toLowerCase() === "websocket";
}

function parseRequestedWebSocketProtocols(request: Request): string[] {
  const raw = request.headers.get("sec-websocket-protocol");
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function resolveWebSocketProtocol(
  request: Request,
  supported: string | readonly string[] | undefined,
): string | null | undefined {
  if (supported === undefined) return undefined;
  const supportedList = typeof supported === "string" ? [supported] : [
    ...supported,
  ];
  if (supportedList.length === 0) return undefined;

  const requested = parseRequestedWebSocketProtocols(request);
  if (requested.length === 0) return null;
  for (const candidate of requested) {
    if (supportedList.includes(candidate)) {
      return candidate;
    }
  }
  return null;
}

function toWebSocketLocalAddress(
  request: Request,
): RpcAcceptedTransportAddress {
  const url = new URL(request.url);
  const parsedPort = url.port.length > 0 ? Number(url.port) : undefined;
  return {
    transport: "websocket",
    hostname: url.hostname,
    port: Number.isInteger(parsedPort) ? parsedPort : undefined,
    path: url.pathname,
  };
}

async function reportConnectionError(
  callback: ((error: unknown) => void | Promise<void>) | undefined,
  error: unknown,
): Promise<void> {
  if (!callback) {
    return;
  }
  try {
    await callback(error);
  } catch {
    // Error callbacks must not destabilize the upgrade or listen loop.
  }
}

function toBinary(
  data: string | ArrayBuffer | Blob | ArrayBufferView,
  rejectText: boolean,
): Promise<Uint8Array | null> | Uint8Array | null {
  if (typeof data === "string") {
    if (rejectText) {
      throw new TransportError(
        "WebSocket text frame is not supported for Cap'n Proto RPC",
      );
    }
    return null;
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof Blob) {
    return data.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  throw new TransportError("unsupported websocket message payload");
}

/**
 * An {@link RpcTransport} implementation that communicates over a WebSocket connection.
 *
 * Binary frames are sent and received via the standard `WebSocket` API with
 * `binaryType` set to `"arraybuffer"`. Outbound frames are queued and drained
 * asynchronously with backpressure based on the socket's `bufferedAmount`.
 *
 * Use the static {@link connect} factory method to establish a new WebSocket
 * connection, or pass an already-open `WebSocket` directly to the constructor.
 *
 * @example
 * ```ts
 * const transport = await WebSocketTransport.connect("ws://localhost:8080/rpc", undefined, {
 *   connectTimeoutMs: 5000,
 *   maxSocketBufferedAmountBytes: 1_000_000,
 * });
 * transport.start((frame) => handleFrame(frame));
 * ```
 */
export class WebSocketTransport implements RpcTransport {
  /** The underlying WebSocket connection. */
  readonly socket: WebSocket;
  /** The options this transport was configured with. */
  readonly options: WebSocketTransportOptions;

  #started = false;
  #closed = false;
  #socketClosed = false;
  #onFrame: ((frame: Uint8Array) => void | Promise<void>) | null = null;
  #inboundChain: Promise<void> = Promise.resolve();
  #listenersAttached = false;

  #outbound: OutboundFrameQueue<PendingOutboundFrame>;
  #drainLoop: Promise<void> | null = null;
  #closeNotified = false;

  #onMessage = (event: MessageEvent) => {
    this.#inboundChain = this.#inboundChain
      .then(async () => {
        const rejectText = this.options.rejectTextFrames ?? true;
        const decoded = await toBinary(event.data, rejectText);
        if (!decoded) return;
        this.assertInboundFrameSize(decoded);
        if (this.options.frameLimits) {
          validateCapnpFrame(decoded, this.options.frameLimits);
        }
        const onFrame = this.#onFrame;
        if (!onFrame) return;
        await onFrame(decoded);
        emitObservabilityEvent(this.options.observability, {
          name: "rpc.transport.websocket.inbound_frame",
          attributes: {
            "rpc.outcome": "ok",
            "rpc.inbound.bytes": decoded.byteLength,
          },
        });
      })
      .catch((error) => this.#handleError(error));
  };

  #onError = (_event: Event) => {
    this.#handleError(new TransportError("websocket transport error"));
  };

  #onClose = (event: CloseEvent) => {
    this.#socketClosed = true;
    const error = new TransportError(
      `websocket closed (code=${event.code} reason=${event.reason || ""})`,
    );
    this.#outbound.rejectQueued(error);
    this.#notifyClose();
    if (this.options.onError) {
      void Promise.resolve(this.options.onError(error));
    }
  };

  constructor(socket: WebSocket, options: WebSocketTransportOptions = {}) {
    this.socket = socket;
    this.options = options;
    this.#outbound = new OutboundFrameQueue("websocket", options);
    this.socket.binaryType = "arraybuffer";
  }

  /**
   * Open a new WebSocket connection and wrap it in a {@link WebSocketTransport}.
   *
   * @param url - The WebSocket URL to connect to (e.g. `"ws://localhost:8080/rpc"`).
   * @param protocols - Optional sub-protocol(s) to request during the handshake.
   * @param options - Transport options including connect timeout.
   * @returns A new `WebSocketTransport` wrapping the opened connection.
   * @throws {TransportError} If the connection fails or times out.
   */
  static async connect(
    url: string | URL,
    protocols?: string | string[],
    options: WebSocketTransportOptions = {},
  ): Promise<WebSocketTransport> {
    let socket: WebSocket;
    try {
      socket = protocols === undefined
        ? new WebSocket(url)
        : new WebSocket(url, protocols);
    } catch (error) {
      throw normalizeTransportError(
        error,
        `failed to create websocket: ${String(url)}`,
      );
    }

    const timeoutMs = options.connectTimeoutMs;
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        if (timer !== null) clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onErr);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(
          new TransportError(`failed to connect websocket: ${String(url)}`),
        );
      };

      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onErr, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          cleanup();
          try {
            socket.close();
          } catch {
            // no-op
          }
          reject(
            new TransportError(
              `websocket connect timed out after ${timeoutMs}ms: ${
                String(url)
              }`,
            ),
          );
        }, timeoutMs);
      }
    });

    return new WebSocketTransport(socket, options);
  }

  static handler(
    options: WebSocketTransportHandlerOptions = {},
  ): WebSocketTransportHandler {
    return new WebSocketTransportHandlerImpl(options);
  }

  static listen(
    options: WebSocketTransportListenOptions,
  ): WebSocketTransportListener {
    return new WebSocketTransportListenerImpl(options);
  }

  start(
    onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): void {
    const startedAt = performance.now();
    if (this.#closed) throw new TransportError("WebSocketTransport is closed");
    if (this.#started) {
      throw new TransportError("WebSocketTransport already started");
    }

    this.#started = true;
    this.#onFrame = onFrame;
    if (!this.#listenersAttached) {
      this.socket.addEventListener("message", this.#onMessage);
      this.socket.addEventListener("error", this.#onError);
      this.socket.addEventListener("close", this.#onClose);
      this.#listenersAttached = true;
    }
    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.websocket.start",
      attributes: {
        "rpc.outcome": "ok",
      },
      durationMs: performance.now() - startedAt,
    });
  }

  async send(frame: Uint8Array): Promise<void> {
    const startedAt = performance.now();
    if (!this.#started) {
      throw new TransportError("WebSocketTransport not started");
    }
    if (this.#closed) throw new TransportError("WebSocketTransport is closed");
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new TransportError(
        `websocket not open: readyState=${this.socket.readyState}`,
      );
    }

    this.assertOutboundFrameSize(frame);
    const payload = new Uint8Array(frame);

    const completion = new Promise<void>((resolve, reject) => {
      this.#outbound.enqueue({
        frame: payload,
        enqueuedAt: Date.now(),
        resolve,
        reject,
      });
    });

    this.#ensureDrainLoop();
    await completion;

    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.websocket.send_frame",
      attributes: {
        "rpc.outcome": "ok",
        "rpc.outbound.bytes": frame.byteLength,
        "rpc.outbound.queue.frames": this.#outbound.length,
        "rpc.outbound.queue.bytes": this.#outbound.queuedBytes,
        "rpc.websocket.buffered_amount": this.socket.bufferedAmount,
      },
      durationMs: performance.now() - startedAt,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    const startedAt = performance.now();
    this.#closed = true;

    const closeError = new TransportError("WebSocketTransport is closed");
    this.#outbound.rejectQueued(closeError);

    const closeNeeded = this.socket.readyState === WebSocket.CONNECTING ||
      this.socket.readyState === WebSocket.OPEN;

    if (closeNeeded) {
      try {
        this.socket.close();
      } catch {
        // no-op
      }

      const closeTimeoutMs = this.options.closeTimeoutMs;
      if (closeTimeoutMs === undefined) {
        await this.#waitForClose();
      } else {
        await Promise.race([
          this.#waitForClose(),
          delay(closeTimeoutMs),
        ]);
      }
    }

    if (this.#listenersAttached) {
      this.socket.removeEventListener("message", this.#onMessage);
      this.socket.removeEventListener("error", this.#onError);
      this.socket.removeEventListener("close", this.#onClose);
      this.#listenersAttached = false;
    }
    this.#notifyClose();

    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.websocket.close",
      attributes: {
        "rpc.outcome": "ok",
      },
      durationMs: performance.now() - startedAt,
    });
  }

  #ensureDrainLoop(): void {
    if (this.#drainLoop) return;
    this.#drainLoop = this.#drainOutbound()
      .catch((_error) => {
        // queued send callers already receive the error.
      })
      .finally(() => {
        this.#drainLoop = null;
        if (this.#outbound.hasQueuedFrames && !this.#closed) {
          this.#ensureDrainLoop();
        }
      });
  }

  async #drainOutbound(): Promise<void> {
    while (!this.#closed && this.#outbound.hasQueuedFrames) {
      const next = this.#outbound.dequeue();
      if (!next) break;

      try {
        await this.#waitForBufferedCapacity(
          next.frame.byteLength,
          next.enqueuedAt,
        );
        this.socket.send(next.frame);
        next.resolve();
      } catch (error) {
        const normalized = normalizeTransportError(
          error,
          "websocket send failed",
        );
        next.reject(normalized);
        this.#outbound.rejectQueued(normalized);
        throw normalized;
      } finally {
        this.#outbound.settle(next.frame.byteLength);
      }
    }
  }

  async #waitForBufferedCapacity(
    frameBytes: number,
    startedAtMs: number,
  ): Promise<void> {
    const maxBuffered = this.options.maxSocketBufferedAmountBytes;
    if (maxBuffered === undefined) return;

    const timeoutMs = this.options.sendTimeoutMs;
    const intervalMs = this.options.outboundDrainIntervalMs ?? 4;

    while (!this.#closed) {
      if (this.socket.readyState !== WebSocket.OPEN) {
        throw new TransportError(
          `websocket not open: readyState=${this.socket.readyState}`,
        );
      }
      if (this.socket.bufferedAmount + frameBytes <= maxBuffered) {
        return;
      }
      if (timeoutMs !== undefined && (Date.now() - startedAtMs) >= timeoutMs) {
        throw new TransportError(
          `websocket send timed out after ${timeoutMs}ms`,
        );
      }
      await delay(intervalMs);
    }

    throw new TransportError("WebSocketTransport is closed");
  }

  #handleError(error: unknown): void {
    const normalized = normalizeTransportError(
      error,
      "websocket transport error",
    );
    emitObservabilityEvent(this.options.observability, {
      name: "rpc.transport.websocket.error",
      attributes: {
        "rpc.outcome": "error",
      },
      error: normalized,
    });
    if (this.options.onError) {
      void Promise.resolve(this.options.onError(normalized));
      return;
    }
    throw normalized;
  }

  async #waitForClose(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED || this.#socketClosed) {
      return;
    }
    await new Promise<void>((resolve) => {
      const onClose = (): void => {
        this.socket.removeEventListener("close", onClose);
        resolve();
      };
      this.socket.addEventListener("close", onClose, { once: true });
    });
  }

  #notifyClose(): void {
    if (this.#closeNotified) {
      return;
    }
    this.#closeNotified = true;
    notifyTransportClose(this.options, "websocket onClose callback failed");
  }

  private assertInboundFrameSize(frame: Uint8Array): void {
    const max = this.options.maxInboundFrameBytes;
    if (max !== undefined && frame.byteLength > max) {
      throw new TransportError(
        `websocket inbound frame size ${frame.byteLength} exceeds configured limit ${max}`,
      );
    }
  }

  private assertOutboundFrameSize(frame: Uint8Array): void {
    const max = this.options.maxOutboundFrameBytes;
    if (max !== undefined && frame.byteLength > max) {
      throw new TransportError(
        `websocket outbound frame size ${frame.byteLength} exceeds configured limit ${max}`,
      );
    }
  }
}

export class AcceptedWebSocketTransport extends WebSocketTransport
  implements RpcAcceptedTransport {
  readonly transport: RpcTransport = this;
  readonly localAddress: RpcAcceptedTransportAddress | null;
  readonly remoteAddress: RpcAcceptedTransportAddress | null;
  readonly id: string | undefined;

  constructor(
    socket: WebSocket,
    metadata: {
      localAddress?: RpcAcceptedTransportAddress | null;
      remoteAddress?: RpcAcceptedTransportAddress | null;
      id?: string;
    },
    options: WebSocketTransportOptions = {},
  ) {
    super(socket, options);
    this.localAddress = metadata.localAddress ?? null;
    this.remoteAddress = metadata.remoteAddress ?? null;
    this.id = metadata.id;
  }
}

class WebSocketTransportHandlerImpl implements WebSocketTransportHandler {
  readonly #options: WebSocketTransportHandlerOptions;
  readonly #accepted = new RpcAcceptedTransportQueue<
    AcceptedWebSocketTransport
  >();

  #closed = false;

  constructor(options: WebSocketTransportHandlerOptions) {
    this.#options = options;
  }

  get closed(): boolean {
    return this.#closed;
  }

  [Symbol.dispose](): void {
    void this.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  accept(): AsyncIterable<AcceptedWebSocketTransport> {
    return this.#accepted.accept();
  }

  async handle(request: Request): Promise<Response> {
    if (this.#closed) {
      return new Response("transport handler is closed", { status: 503 });
    }

    if (!isWebSocketUpgradeRequest(request)) {
      return new Response("websocket upgrade required", { status: 426 });
    }

    if (this.#options.path) {
      const url = new URL(request.url);
      if (url.pathname !== this.#options.path) {
        return new Response("not found", { status: 404 });
      }
    }

    const selectedProtocol = resolveWebSocketProtocol(
      request,
      this.#options.protocols,
    );
    if (selectedProtocol === null) {
      return new Response("websocket protocol mismatch", { status: 426 });
    }

    let socket: WebSocket;
    let response: Response;
    try {
      ({ socket, response } = selectedProtocol === undefined
        ? Deno.upgradeWebSocket(request)
        : Deno.upgradeWebSocket(request, { protocol: selectedProtocol }));
    } catch (error) {
      await reportConnectionError(this.#options.onConnectionError, error);
      return new Response("failed to upgrade websocket", { status: 400 });
    }

    const transport = new AcceptedWebSocketTransport(
      socket,
      {
        localAddress: toWebSocketLocalAddress(request),
        remoteAddress: { transport: "websocket" },
        id: request.headers.get("sec-websocket-key") ?? undefined,
      },
      this.#options.transport ? { ...this.#options.transport } : undefined,
    );
    if (!this.#accepted.push(transport)) {
      await transport.close().catch(() => {});
    }
    return response;
  }

  close(): Promise<void> {
    if (this.#closed) {
      return Promise.resolve();
    }
    this.#closed = true;
    return this.#accepted.close();
  }
}

class WebSocketTransportListenerImpl implements WebSocketTransportListener {
  readonly #handler: WebSocketTransportHandlerImpl;
  readonly #server: Deno.HttpServer<Deno.NetAddr>;

  #closed = false;

  constructor(options: WebSocketTransportListenOptions) {
    this.#handler = new WebSocketTransportHandlerImpl(options);
    this.#server = requireDenoServe()({
      hostname: options.hostname ?? "0.0.0.0",
      port: options.port,
      onListen: () => {},
    }, (request) => this.#handler.handle(request));
  }

  get addr(): Deno.Addr {
    return this.#server.addr;
  }

  get closed(): boolean {
    return this.#closed;
  }

  [Symbol.dispose](): void {
    void this.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  accept(): AsyncIterable<AcceptedWebSocketTransport> {
    return this.#handler.accept();
  }

  handle(request: Request): Promise<Response> {
    return this.#handler.handle(request);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#server.shutdown().catch(() => {});

    let closeError: unknown;
    try {
      await this.#handler.close();
    } catch (error) {
      closeError = error;
    }

    await this.#server.finished.catch(() => {});

    if (closeError !== undefined) {
      throw closeError;
    }
  }
}
