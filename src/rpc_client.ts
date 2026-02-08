import {
  normalizeSessionError,
  ProtocolError,
  SessionError,
} from "./errors.ts";
import type { RpcSession } from "./session.ts";
import type { RpcTransport } from "./transport.ts";
import {
  decodeReturnFrame,
  encodeBootstrapRequestFrame,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReleaseFrame,
  extractBootstrapCapabilityIndex,
  RPC_CALL_TARGET_TAG_IMPORTED_CAP,
  type RpcCallTarget,
  type RpcCapDescriptor,
} from "./rpc_wire.ts";

export interface RpcFinishOptions {
  releaseResultCaps?: boolean;
  requireEarlyCancellation?: boolean;
}

export interface RpcClientCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onQuestionId?: (questionId: number) => void;
  autoFinish?: boolean;
  finish?: RpcFinishOptions;
  paramsCapTable?: RpcCapDescriptor[];
  target?: RpcCallTarget;
}

export interface RpcClientCallResult {
  answerId: number;
  contentBytes: Uint8Array;
  capTable: RpcCapDescriptor[];
  releaseParamCaps: boolean;
  noFinishNeeded: boolean;
}

export interface RpcSessionHarnessTransport extends RpcTransport {
  emitInbound(frame: Uint8Array): Promise<void>;
  nextOutboundFrame(options?: RpcClientCallOptions): Promise<Uint8Array>;
}

export interface SessionRpcClientTransportOptions {
  interfaceId: bigint | number;
  nextQuestionId?: number;
  autoStart?: boolean;
}

export class InMemoryRpcHarnessTransport implements RpcSessionHarnessTransport {
  #onFrame: ((frame: Uint8Array) => void | Promise<void>) | null = null;
  #closed = false;
  #outboundQueue: Uint8Array[] = [];
  #waiters: Array<{
    resolve: (frame: Uint8Array) => void;
    reject: (error: unknown) => void;
  }> = [];

  start(
    onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): void {
    if (this.#closed) throw new SessionError("transport is closed");
    this.#onFrame = onFrame;
  }

  send(frame: Uint8Array): void {
    if (this.#closed) throw new SessionError("transport is closed");
    const copy = new Uint8Array(frame);
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve(copy);
      return;
    }
    this.#outboundQueue.push(copy);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onFrame = null;
    const error = new SessionError("transport is closed");
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  async emitInbound(frame: Uint8Array): Promise<void> {
    if (this.#closed) throw new SessionError("transport is closed");
    if (!this.#onFrame) throw new SessionError("transport is not started");
    await this.#onFrame(new Uint8Array(frame));
  }

  async nextOutboundFrame(
    options: RpcClientCallOptions = {},
  ): Promise<Uint8Array> {
    if (this.#outboundQueue.length > 0) {
      return new Uint8Array(this.#outboundQueue.shift()!);
    }
    if (this.#closed) {
      throw new SessionError("transport is closed");
    }

    return await new Promise<Uint8Array>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        cleanup();
        reject(new SessionError("rpc wait aborted"));
      };
      const cleanup = (): void => {
        if (timeout !== undefined) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const wrappedResolve = (frame: Uint8Array): void => {
        cleanup();
        resolve(frame);
      };
      const wrappedReject = (error: unknown): void => {
        cleanup();
        reject(error);
      };

      if (options.signal?.aborted) {
        wrappedReject(new SessionError("rpc wait aborted"));
        return;
      }
      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          wrappedReject(
            new SessionError(`rpc wait timed out after ${options.timeoutMs}ms`),
          );
        }, options.timeoutMs);
      }
      if (options.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.#waiters.push({
        resolve: wrappedResolve,
        reject: wrappedReject,
      });
    });
  }
}

export class SessionRpcClientTransport {
  readonly session: RpcSession;
  readonly transport: RpcSessionHarnessTransport;

  #interfaceId: bigint;
  #nextQuestionId: number;
  #autoStart: boolean;
  #opChain: Promise<void> = Promise.resolve();

  constructor(
    session: RpcSession,
    transport: RpcSessionHarnessTransport,
    options: SessionRpcClientTransportOptions,
  ) {
    this.session = session;
    this.transport = transport;
    this.#interfaceId = typeof options.interfaceId === "bigint"
      ? options.interfaceId
      : BigInt(options.interfaceId);
    this.#nextQuestionId = options.nextQuestionId ?? 1;
    this.#autoStart = options.autoStart ?? true;
  }

  async bootstrap(
    options: RpcClientCallOptions = {},
  ): Promise<{ capabilityIndex: number }> {
    return await this.#enqueue(async () => {
      const questionId = this.#allocQuestionId();
      options.onQuestionId?.(questionId);
      const frame = encodeBootstrapRequestFrame({ questionId });
      const message = await this.#request(questionId, frame, options);
      if (message.kind === "exception") {
        throw new ProtocolError(`rpc bootstrap failed: ${message.reason}`);
      }

      if ((options.autoFinish ?? true) && !message.noFinishNeeded) {
        await this.#sendFinish(questionId, options.finish);
      }

      return {
        capabilityIndex: extractBootstrapCapabilityIndex(message),
      };
    });
  }

  async call(
    capability: { capabilityIndex: number },
    methodOrdinal: number,
    params: Uint8Array,
    options: RpcClientCallOptions = {},
  ): Promise<Uint8Array> {
    const response = await this.callRaw(
      capability,
      methodOrdinal,
      params,
      options,
    );
    return response.contentBytes;
  }

  async callRaw(
    capability: { capabilityIndex: number },
    methodOrdinal: number,
    params: Uint8Array,
    options: RpcClientCallOptions = {},
  ): Promise<RpcClientCallResult> {
    return await this.#enqueue(async () => {
      const questionId = this.#allocQuestionId();
      options.onQuestionId?.(questionId);
      const target = options.target ?? {
        tag: RPC_CALL_TARGET_TAG_IMPORTED_CAP,
        importedCap: capability.capabilityIndex,
      };
      const frame = encodeCallRequestFrame({
        questionId,
        interfaceId: this.#interfaceId,
        methodId: methodOrdinal,
        target,
        paramsContent: params,
        paramsCapTable: options.paramsCapTable,
      });
      const message = await this.#request(questionId, frame, options);
      if (message.kind === "exception") {
        throw new ProtocolError(`rpc call failed: ${message.reason}`);
      }

      if ((options.autoFinish ?? true) && !message.noFinishNeeded) {
        await this.#sendFinish(questionId, options.finish);
      }

      return {
        answerId: message.answerId,
        contentBytes: new Uint8Array(message.contentBytes),
        capTable: message.capTable.map((entry) => ({
          tag: entry.tag,
          id: entry.id,
        })),
        releaseParamCaps: message.releaseParamCaps,
        noFinishNeeded: message.noFinishNeeded,
      };
    });
  }

  async finish(
    questionId: number,
    options: RpcFinishOptions = {},
  ): Promise<void> {
    await this.#enqueue(async () => {
      await this.#sendFinish(questionId, options);
    });
  }

  async release(
    capability: { capabilityIndex: number },
    referenceCount = 1,
  ): Promise<void> {
    await this.#enqueue(async () => {
      await this.#sendRelease(capability.capabilityIndex, referenceCount);
    });
  }

  #allocQuestionId(): number {
    const next = this.#nextQuestionId;
    this.#nextQuestionId += 1;
    return next;
  }

  async #ensureStarted(): Promise<void> {
    if (!this.#autoStart) return;
    if (this.session.started) return;
    await this.session.start();
  }

  async #request(
    questionId: number,
    frame: Uint8Array,
    options: RpcClientCallOptions,
  ) {
    await this.#ensureStarted();
    await this.transport.emitInbound(frame);
    await this.session.flush();

    const started = Date.now();
    while (true) {
      const remaining = options.timeoutMs === undefined
        ? undefined
        : Math.max(0, options.timeoutMs - (Date.now() - started));
      const outbound = await this.transport.nextOutboundFrame({
        signal: options.signal,
        timeoutMs: remaining,
      });
      let decoded;
      try {
        decoded = decodeReturnFrame(outbound);
      } catch {
        continue;
      }
      if (decoded.answerId !== questionId) {
        continue;
      }
      return decoded;
    }
  }

  async #sendFinish(
    questionId: number,
    options: RpcFinishOptions = {},
  ): Promise<void> {
    await this.#ensureStarted();
    const frame = encodeFinishFrame({
      questionId,
      releaseResultCaps: options.releaseResultCaps ?? true,
      requireEarlyCancellation: options.requireEarlyCancellation ?? false,
    });
    await this.transport.emitInbound(frame);
    await this.session.flush();
  }

  async #sendRelease(
    capabilityId: number,
    referenceCount: number,
  ): Promise<void> {
    await this.#ensureStarted();
    const frame = encodeReleaseFrame({
      id: capabilityId,
      referenceCount,
    });
    await this.transport.emitInbound(frame);
    await this.session.flush();
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
    } catch (error) {
      throw normalizeSessionError(
        error,
        "rpc client transport operation failed",
      );
    } finally {
      release();
    }
  }
}
