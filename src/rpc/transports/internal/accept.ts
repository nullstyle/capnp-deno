import type { RpcTransport } from "./transport.ts";

export interface RpcAcceptedTransportAddress {
  transport?: string;
  hostname?: string;
  port?: number;
  path?: string;
}

export interface RpcAcceptedTransport {
  readonly transport: RpcTransport;
  readonly localAddress?: RpcAcceptedTransportAddress | null;
  readonly remoteAddress?: RpcAcceptedTransportAddress | null;
  readonly id?: string;
}

export interface RpcTransportAcceptSource {
  readonly closed: boolean;
  accept(): AsyncIterable<RpcAcceptedTransport>;
  close(): void | Promise<void>;
}

interface IteratorResolvers<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
}

export class RpcAcceptedTransportQueue<T extends RpcAcceptedTransport> {
  readonly #values: T[] = [];
  readonly #pending: IteratorResolvers<T>[] = [];
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  push(value: T): boolean {
    if (this.#closed) {
      return false;
    }
    const pending = this.#pending.shift();
    if (pending) {
      pending.resolve({ done: false, value });
      return true;
    }
    this.#values.push(value);
    return true;
  }

  async fail(error: unknown): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    while (this.#pending.length > 0) {
      this.#pending.shift()!.reject(error);
    }
    await closeAcceptedTransports(this.#takeValues());
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    while (this.#pending.length > 0) {
      this.#pending.shift()!.resolve({ done: true, value: undefined });
    }
    await closeAcceptedTransports(this.#takeValues());
  }

  async *accept(): AsyncIterable<T> {
    while (true) {
      const next = await this.#next();
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }

  #next(): Promise<IteratorResult<T>> {
    if (this.#values.length > 0) {
      return Promise.resolve({
        done: false,
        value: this.#values.shift()!,
      });
    }
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.#pending.push({ resolve, reject });
    });
  }

  #takeValues(): T[] {
    return this.#values.splice(0, this.#values.length);
  }
}

async function closeAcceptedTransports<T extends RpcAcceptedTransport>(
  values: readonly T[],
): Promise<void> {
  await Promise.allSettled(
    values.map((value) => Promise.resolve(value.transport.close())),
  );
}
