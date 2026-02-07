export interface RpcTransport {
  start(
    onFrame: (frame: Uint8Array) => void | Promise<void>,
  ): void | Promise<void>;
  send(frame: Uint8Array): void | Promise<void>;
  close(): void | Promise<void>;
}
