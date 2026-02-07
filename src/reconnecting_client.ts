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

export interface RpcCapabilityPointer {
  capabilityIndex: number;
}

export interface RpcClientTransportLike {
  bootstrap?(options?: RpcClientCallOptions): Promise<RpcCapabilityPointer>;
  call(
    capability: RpcCapabilityPointer,
    methodOrdinal: number,
    params: Uint8Array,
    options?: RpcClientCallOptions,
  ): Promise<Uint8Array>;
  finish?(
    questionId: number,
    options?: RpcFinishOptions,
  ): Promise<void> | void;
  release?(
    capability: RpcCapabilityPointer,
    referenceCount?: number,
  ): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface ReconnectingRpcClientTransportOptions {
  connect: () => Promise<RpcClientTransportLike>;
  reconnect: ConnectWithReconnectOptions;
  retryInFlightCalls?: boolean;
  rebootstrapOnReconnect?: boolean;
  bootstrapOptions?: RpcClientCallOptions;
  remapCapabilityOnReconnect?: (
    context: ReconnectCapabilityRemapContext,
  ) =>
    | Promise<RpcCapabilityPointer | null | undefined>
    | RpcCapabilityPointer
    | null
    | undefined;
  shouldReconnectError?: (error: unknown) => boolean;
}

export interface ReconnectCapabilityRemapContext {
  capability: RpcCapabilityPointer;
  previousBootstrapCapability: RpcCapabilityPointer | null;
  currentBootstrapCapability: RpcCapabilityPointer | null;
  methodOrdinal: number;
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

export class ReconnectingRpcClientTransport {
  readonly options: ReconnectingRpcClientTransportOptions;

  #client: RpcClientTransportLike | null = null;
  #closed = false;
  #bootstrapCapability: RpcCapabilityPointer | null = null;
  #opChain: Promise<void> = Promise.resolve();

  constructor(options: ReconnectingRpcClientTransportOptions) {
    this.options = options;
  }

  get bootstrapCapability(): RpcCapabilityPointer | null {
    return this.#bootstrapCapability
      ? cloneCapability(this.#bootstrapCapability)
      : null;
  }

  async bootstrap(
    options: RpcClientCallOptions = {},
  ): Promise<RpcCapabilityPointer> {
    return await this.#enqueue(async () => {
      this.#assertOpen();
      const client = await this.#ensureConnected();
      return await this.#runBootstrap(client, options);
    });
  }

  async call(
    capability: RpcCapabilityPointer,
    methodOrdinal: number,
    params: Uint8Array,
    options: RpcClientCallOptions = {},
  ): Promise<Uint8Array> {
    return await this.#enqueue(async () => {
      this.#assertOpen();
      const callCap = normalizeCapability(capability);
      const client = await this.#ensureConnected();

      try {
        return await client.call(callCap, methodOrdinal, params, options);
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
          methodOrdinal,
          normalized,
        );
        try {
          return await reconnected.call(
            remappedCap,
            methodOrdinal,
            params,
            options,
          );
        } catch (retryError) {
          throw normalizeSessionError(retryError, "rpc call retry failed");
        }
      }
    });
  }

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
    methodOrdinal: number,
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
      methodOrdinal,
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
