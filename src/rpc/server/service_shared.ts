import type { RpcServerRuntime } from "./runtime.ts";
import type {
  RpcPeer,
  RpcServiceConstructor,
  RpcServiceImplementation,
} from "./service_types.ts";

export interface ActiveRuntime {
  runtime: RpcServerRuntime;
  disposeInstance: (() => Promise<void>) | null;
}

export function resolveImplementationForConnection<TServer extends object>(
  implementation: RpcServiceImplementation<TServer>,
  peer: RpcPeer,
): { server: TServer; disposeInstance: (() => Promise<void>) | null } {
  if (typeof implementation === "function") {
    const Ctor = implementation as RpcServiceConstructor<TServer>;
    const server = new Ctor(peer);
    return { server, disposeInstance: toDisposer(server) };
  }
  return { server: implementation, disposeInstance: null };
}

export async function closeActiveRuntime(
  active: Set<ActiveRuntime>,
  entry: ActiveRuntime,
): Promise<void> {
  if (!active.has(entry)) return;
  active.delete(entry);
  try {
    await entry.runtime.close();
  } finally {
    await entry.disposeInstance?.();
  }
}

export async function reportConnectionError(
  report: ((error: unknown) => void | Promise<void>) | undefined,
  error: unknown,
): Promise<void> {
  if (!report) return;
  try {
    await report(error);
  } catch {
    // Error callbacks must not destabilize accept/request loops.
  }
}

function toDisposer(instance: unknown): (() => Promise<void>) | null {
  if (instance && typeof instance === "object") {
    if (Symbol.asyncDispose in instance) {
      const asyncDispose = (instance as AsyncDisposable)[Symbol.asyncDispose];
      if (typeof asyncDispose === "function") {
        return async () => {
          await asyncDispose.call(instance as AsyncDisposable);
        };
      }
    }
    if (Symbol.dispose in instance) {
      const dispose = (instance as Disposable)[Symbol.dispose];
      if (typeof dispose === "function") {
        return () =>
          new Promise<void>((resolve, reject) => {
            try {
              dispose.call(instance as Disposable);
              resolve();
            } catch (error) {
              reject(error);
            }
          });
      }
    }
  }
  return null;
}
