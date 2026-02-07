import {
  type CapnpWasmExports,
  getCapnpWasmExports,
  WasmAbi,
  type WasmAbiOptions,
} from "./abi.ts";
import { ProtocolError } from "./errors.ts";

export class WasmPeer {
  readonly abi: WasmAbi;
  readonly handle: number;
  #closed = false;

  private constructor(abi: WasmAbi, handle: number) {
    this.abi = abi;
    this.handle = handle;
  }

  static create(abi: WasmAbi): WasmPeer {
    const handle = abi.createPeer();
    return new WasmPeer(abi, handle);
  }

  static fromExports(
    exports: CapnpWasmExports,
    options: WasmAbiOptions = {},
  ): WasmPeer {
    return WasmPeer.create(new WasmAbi(exports, options));
  }

  static fromInstance(
    instance: WebAssembly.Instance,
    options: WasmAbiOptions = {},
  ): WasmPeer {
    return WasmPeer.fromExports(getCapnpWasmExports(instance), options);
  }

  get closed(): boolean {
    return this.#closed;
  }

  pushFrame(frame: Uint8Array): Uint8Array[] {
    this.assertOpen();
    this.abi.pushFrame(this.handle, frame);
    return this.abi.drainOutFrames(this.handle);
  }

  popOutgoingFrame(): Uint8Array | null {
    this.assertOpen();
    return this.abi.popOutFrame(this.handle);
  }

  drainOutgoingFrames(): Uint8Array[] {
    this.assertOpen();
    return this.abi.drainOutFrames(this.handle);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.abi.freePeer(this.handle);
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private assertOpen(): void {
    if (this.#closed) {
      throw new ProtocolError("WasmPeer is closed");
    }
  }
}
