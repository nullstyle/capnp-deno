import type { CapnpWasmExports } from "../src/wasm/abi.ts";

type PeerState = {
  queue: Uint8Array[];
};

export class FakeCapnpWasm {
  readonly memory: WebAssembly.Memory;
  readonly exports: CapnpWasmExports;
  readonly commitCalls: number[] = [];

  private readonly peers = new Map<number, PeerState>();
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  private heapPtr = 1024;
  private nextPeer = 1;
  private abiVersion: number;

  private lastErrorCode = 0;
  private lastErrorPtr = 0;
  private lastErrorLen = 0;

  private onPushFrame: (frame: Uint8Array) => Uint8Array[];

  constructor(options: {
    abiVersion?: number;
    onPushFrame?: (frame: Uint8Array) => Uint8Array[];
    extraExports?: Record<string, unknown>;
  } = {}) {
    this.memory = new WebAssembly.Memory({ initial: 1 });
    this.abiVersion = options.abiVersion ?? 1;
    this.onPushFrame = options.onPushFrame ?? ((frame) => [frame]);

    const baseExports: CapnpWasmExports = {
      memory: this.memory,
      capnp_alloc: (len) => this.alloc(len),
      capnp_free: (_ptr, _len) => {},

      capnp_last_error_code: () => this.lastErrorCode,
      capnp_last_error_ptr: () => this.lastErrorPtr,
      capnp_last_error_len: () => this.lastErrorLen,
      capnp_clear_error: () => this.clearError(),

      capnp_peer_new: () => this.peerNew(),
      capnp_peer_free: (peer) => this.peerFree(peer),
      capnp_peer_push_frame: (peer, ptr, len) =>
        this.peerPushFrame(peer, ptr, len),
      capnp_peer_pop_out_frame: (peer, outPtrPtr, outLenPtr) =>
        this.peerPopOutFrame(peer, outPtrPtr, outLenPtr),
      capnp_peer_pop_commit: (peer) => this.peerPopCommit(peer),

      capnp_wasm_abi_version: () => this.abiVersion,
    };

    this.exports = {
      ...baseExports,
      ...(options.extraExports ?? {}),
    } as CapnpWasmExports;
  }

  setPushFrameBehavior(callback: (frame: Uint8Array) => Uint8Array[]): void {
    this.onPushFrame = callback;
  }

  private peerNew(): number {
    this.clearError();
    const id = this.nextPeer;
    this.nextPeer += 1;
    this.peers.set(id, { queue: [] });
    return id;
  }

  private peerFree(peer: number): void {
    this.peers.delete(peer);
  }

  private peerPushFrame(peer: number, ptr: number, len: number): number {
    this.clearError();
    const state = this.peers.get(peer);
    if (!state) {
      this.setError(101, `unknown peer id ${peer}`);
      return 0;
    }
    const frame = this.copyFromMemory(ptr, len);
    const generated = this.onPushFrame(frame);
    for (const out of generated) {
      state.queue.push(new Uint8Array(out));
    }
    return 1;
  }

  private peerPopOutFrame(
    peer: number,
    outPtrPtr: number,
    outLenPtr: number,
  ): number {
    this.clearError();
    const state = this.peers.get(peer);
    if (!state) {
      this.setError(102, `unknown peer id ${peer}`);
      return 0;
    }
    const frame = state.queue.shift();
    if (!frame) {
      return 0;
    }

    const ptr = this.alloc(frame.byteLength);
    this.bytes().set(frame, ptr);
    this.view().setUint32(outPtrPtr, ptr, true);
    this.view().setUint32(outLenPtr, frame.byteLength, true);
    return 1;
  }

  private peerPopCommit(peer: number): void {
    this.clearError();
    if (!this.peers.has(peer)) {
      this.setError(103, `unknown peer id ${peer}`);
      return;
    }
    this.commitCalls.push(peer);
  }

  private setError(code: number, message: string): void {
    const bytes = this.encoder.encode(message);
    const ptr = this.alloc(bytes.byteLength);
    this.bytes().set(bytes, ptr);
    this.lastErrorCode = code;
    this.lastErrorPtr = ptr;
    this.lastErrorLen = bytes.byteLength;
  }

  private clearError(): void {
    this.lastErrorCode = 0;
    this.lastErrorPtr = 0;
    this.lastErrorLen = 0;
  }

  private ensureCapacity(required: number): void {
    const current = this.memory.buffer.byteLength;
    if (required <= current) return;
    const page = 64 * 1024;
    const deficit = required - current;
    const pages = Math.ceil(deficit / page);
    this.memory.grow(pages);
  }

  private alloc(len: number): number {
    const size = len === 0 ? 1 : len;
    const ptr = this.heapPtr;
    this.heapPtr += size;
    this.ensureCapacity(this.heapPtr);
    return ptr;
  }

  private bytes(): Uint8Array {
    return new Uint8Array(this.memory.buffer);
  }

  private view(): DataView {
    return new DataView(this.memory.buffer);
  }

  private copyFromMemory(ptr: number, len: number): Uint8Array {
    if (len === 0) return new Uint8Array();
    const memory = this.bytes();
    const end = ptr + len;
    if (end > memory.byteLength) {
      throw new Error(
        `out-of-bounds copy (ptr=${ptr} len=${len} mem=${memory.byteLength})`,
      );
    }
    const out = new Uint8Array(len);
    out.set(memory.subarray(ptr, end));
    return out;
  }

  decode(bytes: Uint8Array): string {
    return this.decoder.decode(bytes);
  }

  allocBytes(bytes: Uint8Array): number {
    const ptr = this.alloc(bytes.byteLength);
    if (bytes.byteLength > 0) {
      this.bytes().set(bytes, ptr);
    }
    return ptr;
  }

  readBytes(ptr: number, len: number): Uint8Array {
    return this.copyFromMemory(ptr, len);
  }

  writeU32(ptr: number, value: number): void {
    this.view().setUint32(ptr, value >>> 0, true);
  }

  failWithError(code: number, message: string): void {
    this.setError(code, message);
  }
}
