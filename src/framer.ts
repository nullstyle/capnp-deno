import { ProtocolError } from "./errors.ts";
import {
  type CapnpFrameLimitsOptions,
  validateCapnpFrame,
} from "./frame_limits.ts";

export interface CapnpFrameFramerOptions extends CapnpFrameLimitsOptions {
  maxBufferedBytes?: number;
}

export class CapnpFrameFramer {
  readonly options: CapnpFrameFramerOptions;
  #buffer = new Uint8Array(0);
  #expectedTotal: number | null = null;

  constructor(options: CapnpFrameFramerOptions = {}) {
    this.options = options;
  }

  push(data: Uint8Array): void {
    if (data.byteLength === 0) return;

    this.assertBufferedBytes(this.#buffer.byteLength + data.byteLength);
    const next = new Uint8Array(this.#buffer.byteLength + data.byteLength);
    next.set(this.#buffer, 0);
    next.set(data, this.#buffer.byteLength);
    this.#buffer = next;
  }

  bufferedBytes(): number {
    return this.#buffer.byteLength;
  }

  popFrame(): Uint8Array | null {
    this.updateExpectedTotal();
    if (this.#expectedTotal === null) return null;
    if (this.#buffer.byteLength < this.#expectedTotal) return null;

    const total = this.#expectedTotal;
    const frame = this.#buffer.slice(0, total);
    this.#buffer = this.#buffer.slice(total);
    this.#expectedTotal = null;
    if (this.options.maxNestingDepth !== undefined) {
      validateCapnpFrame(frame, this.options);
    }
    return frame;
  }

  private updateExpectedTotal(): void {
    if (this.#expectedTotal !== null) return;
    if (this.#buffer.byteLength < 4) return;

    const view = new DataView(
      this.#buffer.buffer,
      this.#buffer.byteOffset,
      this.#buffer.byteLength,
    );
    const segmentCountMinusOne = view.getUint32(0, true);
    const segmentCount = segmentCountMinusOne + 1;
    if (segmentCount < 1) {
      throw new ProtocolError("invalid capnp frame segment count");
    }
    const maxSegmentCount = this.options.maxSegmentCount;
    if (
      maxSegmentCount !== undefined &&
      segmentCount > maxSegmentCount
    ) {
      throw new ProtocolError(
        `capnp frame segment count ${segmentCount} exceeds configured limit ${maxSegmentCount}`,
      );
    }

    const paddingWords = (segmentCount % 2 === 0) ? 1 : 0;
    const headerWords = 1 + segmentCount + paddingWords;
    const headerBytes = headerWords * 4;

    if (this.#buffer.byteLength < headerBytes) return;

    let totalWords = 0;
    for (let i = 0; i < segmentCount; i += 1) {
      const wordCount = view.getUint32(4 + i * 4, true);
      totalWords += wordCount;
    }
    const maxTraversalWords = this.options.maxTraversalWords;
    if (maxTraversalWords !== undefined && totalWords > maxTraversalWords) {
      throw new ProtocolError(
        `capnp frame traversal words ${totalWords} exceeds configured limit ${maxTraversalWords}`,
      );
    }

    const bodyBytes = totalWords * 8;
    const totalBytes = headerBytes + bodyBytes;
    this.assertFrameBytes(totalBytes);
    this.assertBufferedBytes(totalBytes);
    this.#expectedTotal = totalBytes;
  }

  private assertFrameBytes(totalBytes: number): void {
    const maxFrameBytes = this.options.maxFrameBytes;
    if (maxFrameBytes !== undefined && totalBytes > maxFrameBytes) {
      throw new ProtocolError(
        `capnp frame size ${totalBytes} exceeds configured limit ${maxFrameBytes}`,
      );
    }
  }

  private assertBufferedBytes(totalBytes: number): void {
    const maxBufferedBytes = this.options.maxBufferedBytes;
    if (maxBufferedBytes !== undefined && totalBytes > maxBufferedBytes) {
      throw new ProtocolError(
        `capnp framer buffer size ${totalBytes} exceeds configured limit ${maxBufferedBytes}`,
      );
    }
  }
}
