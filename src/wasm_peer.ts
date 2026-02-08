import {
  type CapnpWasmExports,
  DEFAULT_MAX_DRAIN_FRAMES,
  type DrainOutFramesResult,
  getCapnpWasmExports,
  WasmAbi,
  type WasmAbiOptions,
} from "./abi.ts";
import { ProtocolError } from "./errors.ts";

/**
 * High-level wrapper around a single Cap'n Proto WASM peer.
 *
 * A `WasmPeer` pairs a {@link WasmAbi} instance with a peer handle and
 * provides a convenient interface for pushing inbound frames and draining
 * outbound frames. It manages the peer lifecycle automatically and supports
 * the `using` declaration via `Symbol.dispose`.
 *
 * @example
 * ```ts
 * const { peer } = await instantiatePeer("./capnp.wasm");
 * const responses = peer.pushFrame(inboundFrame);
 * for (const frame of responses) {
 *   await transport.send(frame);
 * }
 * peer.close();
 * ```
 */
export class WasmPeer {
  /** The underlying WASM ABI instance. */
  readonly abi: WasmAbi;
  /** The opaque WASM peer handle. */
  readonly handle: number;
  #closed = false;

  private constructor(abi: WasmAbi, handle: number) {
    this.abi = abi;
    this.handle = handle;
  }

  /**
   * Creates a new WasmPeer from an existing {@link WasmAbi} instance.
   *
   * @param abi - The WASM ABI wrapper to use.
   * @returns A new WasmPeer with a freshly allocated peer handle.
   * @throws {WasmAbiError} If peer creation fails in the WASM module.
   */
  static create(abi: WasmAbi): WasmPeer {
    const handle = abi.createPeer();
    return new WasmPeer(abi, handle);
  }

  /**
   * Creates a new WasmPeer from raw WASM exports.
   *
   * @param exports - The typed WASM export bindings.
   * @param options - ABI version negotiation options.
   * @returns A new WasmPeer.
   * @throws {WasmAbiError} If exports are invalid or version negotiation fails.
   */
  static fromExports(
    exports: CapnpWasmExports,
    options: WasmAbiOptions = {},
  ): WasmPeer {
    return WasmPeer.create(new WasmAbi(exports, options));
  }

  /**
   * Creates a new WasmPeer directly from a WebAssembly instance.
   *
   * @param instance - A fully instantiated WebAssembly instance.
   * @param options - ABI version negotiation options.
   * @returns A new WasmPeer.
   * @throws {WasmAbiError} If required exports are missing or version negotiation fails.
   */
  static fromInstance(
    instance: WebAssembly.Instance,
    options: WasmAbiOptions = {},
  ): WasmPeer {
    return WasmPeer.fromExports(getCapnpWasmExports(instance), options);
  }

  /** Whether this peer has been closed. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Pushes an inbound frame into the peer and returns all resulting outbound frames.
   *
   * This is the primary frame-processing method. The inbound frame is
   * delivered to the WASM peer, which may produce zero or more outbound
   * response frames.
   *
   * @param frame - The raw bytes of the inbound Cap'n Proto message.
   * @param maxFrames - Maximum outbound frames to drain. Defaults to
   *   {@link DEFAULT_MAX_DRAIN_FRAMES}.
   * @returns A {@link DrainOutFramesResult} with the drained frames and a
   *   truncation flag.
   * @throws {ProtocolError} If the peer is closed.
   * @throws {WasmAbiError} If the WASM module rejects the frame.
   */
  pushFrame(
    frame: Uint8Array,
    maxFrames: number = DEFAULT_MAX_DRAIN_FRAMES,
  ): DrainOutFramesResult {
    this.assertOpen();
    this.abi.pushFrame(this.handle, frame);
    return this.abi.drainOutFrames(this.handle, maxFrames);
  }

  /**
   * Pops a single outbound frame from the peer's output queue.
   *
   * @returns The next outbound frame, or null if the queue is empty.
   * @throws {ProtocolError} If the peer is closed.
   */
  popOutgoingFrame(): Uint8Array | null {
    this.assertOpen();
    return this.abi.popOutFrame(this.handle);
  }

  /**
   * Drains outbound frames from the peer's output queue, up to a limit.
   *
   * @param maxFrames - Maximum number of frames to drain. Defaults to
   *   {@link DEFAULT_MAX_DRAIN_FRAMES}.
   * @returns A {@link DrainOutFramesResult} with the drained frames and a
   *   truncation flag.
   * @throws {ProtocolError} If the peer is closed.
   */
  drainOutgoingFrames(
    maxFrames: number = DEFAULT_MAX_DRAIN_FRAMES,
  ): DrainOutFramesResult {
    this.assertOpen();
    return this.abi.drainOutFrames(this.handle, maxFrames);
  }

  /**
   * Closes the peer and frees the associated WASM memory.
   *
   * Calling close() on an already-closed peer is a no-op.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.abi.freePeer(this.handle);
  }

  /** Implements the `Disposable` protocol for use with the `using` declaration. */
  [Symbol.dispose](): void {
    this.close();
  }

  private assertOpen(): void {
    if (this.#closed) {
      throw new ProtocolError("WasmPeer is closed");
    }
  }
}
