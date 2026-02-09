/**
 * Reconnecting RPC client transport with capability remapping.
 *
 * Wraps a {@link SessionRpcClientTransport}-compatible factory with automatic
 * reconnection, re-bootstrap, and capability ID remapping so that callers
 * can hold stable capability references across connection cycles.
 *
 * @module
 */

import {
  normalizeSessionError,
  SessionError,
  TransportError,
} from "./errors.ts";
import {
  connectWithReconnect,
  type ConnectWithReconnectOptions,
} from "./reconnect.ts";
import type { RpcClientCallOptions, RpcFinishOptions } from "./rpc_client.ts";
import type { CapabilityPointer } from "./rpc_server.ts";

/**
 * Alias for {@link CapabilityPointer}, used throughout the reconnecting client
 * transport API. Structurally identical to `CapabilityPointer`.
 */
export type RpcCapabilityPointer = CapabilityPointer;

/**
 * Minimal interface for an RPC client transport, used by
 * {@link ReconnectingRpcClientTransport} to communicate with the underlying
 * session. This allows wrapping different transport implementations
 * (e.g. {@link SessionRpcClientTransport}) without coupling to a specific class.
 */
export interface RpcClientTransportLike {
  /** Obtain the server's bootstrap capability. */
  bootstrap?(options?: RpcClientCallOptions): Promise<RpcCapabilityPointer>;
  /** Send an RPC call and return the response content bytes. */
  call(
    capability: RpcCapabilityPointer,
    methodId: number,
    params: Uint8Array,
    options?: RpcClientCallOptions,
  ): Promise<Uint8Array>;
  /** Send a finish message for a question. */
  finish?(
    questionId: number,
    options?: RpcFinishOptions,
  ): Promise<void> | void;
  /** Release a capability reference. */
  release?(
    capability: RpcCapabilityPointer,
    referenceCount?: number,
  ): Promise<void> | void;
  /** Close the underlying connection. */
  close?(): Promise<void> | void;
}

/**
 * Configuration for the {@link ReconnectingRpcClientTransport}.
 */
export interface ReconnectingRpcClientTransportOptions {
  /** Factory function that creates a new underlying client transport. */
  connect: () => Promise<RpcClientTransportLike>;
  /** Reconnection policy and options used when the connection drops. */
  reconnect: ConnectWithReconnectOptions;
  /**
   * Whether to automatically retry in-flight calls after a successful reconnect.
   * Defaults to `true`.
   */
  retryInFlightCalls?: boolean;
  /**
   * Whether to automatically re-bootstrap when the reconnected session needs
   * to remap the bootstrap capability. Defaults to `true`.
   */
  rebootstrapOnReconnect?: boolean;
  /** Options passed to the bootstrap call during reconnection. */
  bootstrapOptions?: RpcClientCallOptions;
  /**
   * Custom callback to remap a non-bootstrap capability after reconnection.
   * Called when a call was targeting a capability other than the bootstrap
   * capability and the connection was lost. Return a new capability pointer
   * or `null`/`undefined` to signal that remapping is not possible.
   */
  remapCapabilityOnReconnect?: (
    context: ReconnectCapabilityRemapContext,
  ) =>
    | Promise<RpcCapabilityPointer | null | undefined>
    | RpcCapabilityPointer
    | null
    | undefined;
  /**
   * Custom predicate to decide whether an error should trigger a reconnect.
   * Defaults to checking if the error is a {@link TransportError} or {@link SessionError}.
   */
  shouldReconnectError?: (error: unknown) => boolean;
}

/**
 * Context provided to the `remapCapabilityOnReconnect` callback when a
 * non-bootstrap capability needs to be remapped after reconnection.
 */
export interface ReconnectCapabilityRemapContext {
  /** The original capability that the failed call was targeting. */
  capability: RpcCapabilityPointer;
  /** The bootstrap capability from the previous (now-dead) connection, or `null`. */
  previousBootstrapCapability: RpcCapabilityPointer | null;
  /** The bootstrap capability from the new connection, or `null` if not yet bootstrapped. */
  currentBootstrapCapability: RpcCapabilityPointer | null;
  /** The method ordinal of the call that triggered the reconnect. */
  methodId: number;
  /** The error that caused the reconnect. */
  error: unknown;
}

function cloneCapability(
  capability: RpcCapabilityPointer,
): RpcCapabilityPointer {
  return { capabilityIndex: capability.capabilityIndex };
}

function normalizeCapability(
  capability: RpcCapabilityPointer,
): RpcCapabilityPointer {
  const index = capability.capabilityIndex;
  if (!Number.isInteger(index) || index < 0 || index > 0xffff_ffff) {
    throw new SessionError(
      `capabilityIndex must be a non-negative 32-bit integer, got ${
        String(index)
      }`,
    );
  }
  return { capabilityIndex: index };
}

/**
 * An RPC client transport wrapper that automatically reconnects when the
 * underlying connection is lost.
 *
 * On the first operation, it lazily establishes a connection using the
 * configured `connect` factory. If a call fails with a reconnectable error
 * (as determined by `shouldReconnectError`), the transport closes the old
 * connection, reconnects using the configured policy, and optionally retries
 * the failed call.
 *
 * For bootstrap capabilities, reconnection automatically re-bootstraps to
 * obtain a fresh capability index. For non-bootstrap capabilities, the
 * `remapCapabilityOnReconnect` callback is invoked to translate the old
 * capability reference into one valid on the new connection.
 *
 * All operations are serialized through an internal queue to prevent
 * concurrent reconnection races.
 *
 * @example
 * ```ts
 * const client = new ReconnectingRpcClientTransport({
 *   connect: () => createMyTransport(),
 *   reconnect: {
 *     policy: createExponentialBackoffReconnectPolicy(),
 *   },
 * });
 * const cap = await client.bootstrap();
 * const result = await client.call(cap, 0, new Uint8Array());
 * await client.close();
 * ```
 */
export class ReconnectingRpcClientTransport {
  /** The options this transport was configured with. */
  readonly options: ReconnectingRpcClientTransportOptions;

  #client: RpcClientTransportLike | null = null;
  #closed = false;
  #bootstrapCapability: RpcCapabilityPointer | null = null;
  #opChain: Promise<void> = Promise.resolve();

  constructor(options: ReconnectingRpcClientTransportOptions) {
    this.options = options;
  }

  /**
   * The most recently obtained bootstrap capability, or `null` if bootstrap
   * has not been called or the connection has not been established.
   */
  get bootstrapCapability(): RpcCapabilityPointer | null {
    return this.#bootstrapCapability
      ? cloneCapability(this.#bootstrapCapability)
      : null;
  }

  /**
   * Obtain the server's bootstrap capability, connecting first if needed.
   *
   * @param options - Call options including timeout and abort signal.
   * @returns The bootstrap capability pointer.
   * @throws {SessionError} If connection or bootstrap fails.
   */
  async bootstrap(
    options: RpcClientCallOptions = {},
  ): Promise<RpcCapabilityPointer> {
    return await this.#enqueue(async () => {
      this.#assertOpen();
      const client = await this.#ensureConnected();
      return await this.#runBootstrap(client, options);
    });
  }

  /**
   * Send an RPC call, automatically reconnecting and retrying if the
   * connection drops (when `retryInFlightCalls` is enabled).
   *
   * @param capability - The target capability.
   * @param methodId - The zero-based method index.
   * @param params - The raw Cap'n Proto params struct bytes.
   * @param options - Call options including timeout and abort signal.
   * @returns The raw content bytes of the response.
   * @throws {SessionError} If the call fails after all retry attempts.
   */
  async call(
    capability: RpcCapabilityPointer,
    methodId: number,
    params: Uint8Array,
    options: RpcClientCallOptions = {},
  ): Promise<Uint8Array> {
    return await this.#enqueue(async () => {
      this.#assertOpen();
      const callCap = normalizeCapability(capability);
      const client = await this.#ensureConnected();

      try {
        return await client.call(callCap, methodId, params, options);
      } catch (error) {
        const normalized = normalizeSessionError(error, "rpc call failed");
        const retryEnabled = this.options.retryInFlightCalls ?? true;
        if (!retryEnabled || !this.#shouldReconnect(normalized)) {
          throw normalized;
        }

        const previousBootstrap = this.#bootstrapCapability;
        await this.#reconnect();
        const reconnected = await this.#ensureConnected();

        const remappedCap = await this.#mapCapabilityAfterReconnect(
          callCap,
          previousBootstrap,
          methodId,
          normalized,
        );
        try {
          return await reconnected.call(
            remappedCap,
            methodId,
            params,
            options,
          );
        } catch (retryError) {
          throw normalizeSessionError(retryError, "rpc call retry failed");
        }
      }
    });
  }

  /**
   * Send a `finish` message. Note that finish is NOT retried on reconnect
   * because question IDs are scoped to a single connection.
   *
   * @param questionId - The question ID to finish.
   * @param options - Finish options.
   * @throws {SessionError} If the finish fails and the error triggers reconnection.
   */
  async finish(
    questionId: number,
    options: RpcFinishOptions = {},
  ): Promise<void> {
    await this.#enqueue(async () => {
      this.#assertOpen();
      const client = await this.#ensureConnected();
      if (!client.finish) {
        throw new SessionError(
          "underlying client transport does not support finish() calls",
        );
      }

      try {
        await client.finish(questionId, options);
      } catch (error) {
        const normalized = normalizeSessionError(error, "rpc finish failed");
        if (!this.#shouldReconnect(normalized)) {
          throw normalized;
        }
        await this.#reconnect();
        throw new SessionError(
          `finish(${questionId}) failed during reconnect; question IDs are connection-scoped and are not retried`,
          { cause: normalized },
        );
      }
    });
  }

  /**
   * Release a capability reference. Like `finish`, this is NOT retried on
   * reconnect because capability references are scoped to a single connection.
   *
   * @param capability - The capability to release.
   * @param referenceCount - Number of references to release. Defaults to 1.
   * @throws {SessionError} If the release fails and the error triggers reconnection.
   */
  async release(
    capability: RpcCapabilityPointer,
    referenceCount = 1,
  ): Promise<void> {
    await this.#enqueue(async () => {
      this.#assertOpen();
      const releaseCap = normalizeCapability(capability);
      const client = await this.#ensureConnected();
      if (!client.release) {
        throw new SessionError(
          "underlying client transport does not support release() calls",
        );
      }

      try {
        await client.release(releaseCap, referenceCount);
      } catch (error) {
        const normalized = normalizeSessionError(error, "rpc release failed");
        if (!this.#shouldReconnect(normalized)) {
          throw normalized;
        }
        await this.#reconnect();
        throw new SessionError(
          `release(${releaseCap.capabilityIndex}) failed during reconnect; capability references are connection-scoped and are not retried`,
          { cause: normalized },
        );
      }
    });
  }

  /** Close the underlying client transport and prevent further operations. */
  async close(): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#closed) return;
      this.#closed = true;
      await this.#closeClient(this.#client);
      this.#client = null;
      this.#bootstrapCapability = null;
    });
  }

  async #mapCapabilityAfterReconnect(
    capability: RpcCapabilityPointer,
    previousBootstrap: RpcCapabilityPointer | null,
    methodId: number,
    error: unknown,
  ): Promise<RpcCapabilityPointer> {
    if (!previousBootstrap) {
      return capability;
    }

    const rebootstrap = this.options.rebootstrapOnReconnect ?? true;
    if (capability.capabilityIndex === previousBootstrap.capabilityIndex) {
      if (rebootstrap) {
        const client = await this.#ensureConnected();
        const refreshed = await this.#runBootstrap(
          client,
          this.options.bootstrapOptions ?? {},
        );
        return refreshed;
      }

      throw new SessionError(
        "call retry requires bootstrap remap, but rebootstrapOnReconnect is disabled",
      );
    }

    let currentBootstrapCapability: RpcCapabilityPointer | null = null;
    if (rebootstrap) {
      const client = await this.#ensureConnected();
      if (client.bootstrap) {
        currentBootstrapCapability = await this.#runBootstrap(
          client,
          this.options.bootstrapOptions ?? {},
        );
      }
    }

    const remap = this.options.remapCapabilityOnReconnect;
    if (!remap) {
      throw new SessionError(
        `cannot automatically retry non-bootstrap capability ${capability.capabilityIndex} after reconnect`,
      );
    }

    const remapped = await remap({
      capability: cloneCapability(capability),
      previousBootstrapCapability: previousBootstrap
        ? cloneCapability(previousBootstrap)
        : null,
      currentBootstrapCapability: currentBootstrapCapability
        ? cloneCapability(currentBootstrapCapability)
        : null,
      methodId,
      error,
    });
    if (!remapped) {
      throw new SessionError(
        `remapCapabilityOnReconnect did not provide a replacement for capability ${capability.capabilityIndex}`,
      );
    }

    return normalizeCapability(remapped);
  }

  async #runBootstrap(
    client: RpcClientTransportLike,
    options: RpcClientCallOptions,
  ): Promise<RpcCapabilityPointer> {
    if (!client.bootstrap) {
      throw new SessionError(
        "underlying client transport does not support bootstrap()",
      );
    }

    let bootstrapCap: RpcCapabilityPointer;
    try {
      bootstrapCap = await client.bootstrap(options);
    } catch (error) {
      throw normalizeSessionError(error, "rpc bootstrap failed");
    }
    const bootstrap = normalizeCapability(bootstrapCap);
    this.#bootstrapCapability = bootstrap;
    return cloneCapability(bootstrap);
  }

  async #ensureConnected(): Promise<RpcClientTransportLike> {
    this.#assertOpen();
    if (this.#client) return this.#client;
    try {
      this.#client = await connectWithReconnect(
        this.options.connect,
        this.options.reconnect,
      );
    } catch (error) {
      throw normalizeSessionError(error, "rpc client connect failed");
    }
    return this.#client;
  }

  async #reconnect(): Promise<void> {
    await this.#closeClient(this.#client);
    this.#client = null;
    this.#bootstrapCapability = null;
    await this.#ensureConnected();
  }

  #shouldReconnect(error: unknown): boolean {
    if (this.options.shouldReconnectError) {
      return this.options.shouldReconnectError(error);
    }
    return error instanceof TransportError || error instanceof SessionError;
  }

  async #closeClient(client: RpcClientTransportLike | null): Promise<void> {
    if (!client?.close) return;
    try {
      await client.close();
    } catch (error) {
      throw normalizeSessionError(error, "rpc client close failed");
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new SessionError("reconnecting client transport is closed");
    }
  }

  async #enqueue<T>(op: () => Promise<T>): Promise<T> {
    const gate = this.#opChain;
    let release!: () => void;
    this.#opChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await gate;
    try {
      return await op();
    } finally {
      release();
    }
  }
}
