/**
 * Cap'n Proto message framing.
 *
 * Implements the segment-table framing protocol for reading and writing
 * multi-segment Cap'n Proto messages over byte streams.
 *
 * @module
 */

import { ProtocolError } from "./errors.ts";
import {
  type CapnpFrameLimitsOptions,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_SEGMENT_COUNT,
  DEFAULT_MAX_TRAVERSAL_WORDS,
  validateCapnpFrame,
} from "./frame_limits.ts";

/**
 * Options for configuring a {@link CapnpFrameFramer}.
 *
 * Extends {@link CapnpFrameLimitsOptions} with an additional limit on how
 * many bytes can be buffered before a complete frame is assembled.
 */
export interface CapnpFrameFramerOptions extends CapnpFrameLimitsOptions {
  /** Maximum bytes that can be buffered while waiting for a complete frame. */
  maxBufferedBytes?: number;
}

/**
 * Incremental Cap'n Proto frame assembler for stream-oriented transports.
 *
 * Push raw byte chunks from a TCP stream (or similar) into the framer via
 * {@link push}, then call {@link popFrame} to extract complete frames.
 * The framer handles the Cap'n Proto framing protocol (segment count header,
 * segment sizes, padding) and optionally validates frames against size and
 * nesting limits.
 *
 * @example
 * ```ts
 * const framer = new CapnpFrameFramer({ maxFrameBytes: 1_000_000 });
 * framer.push(chunk);
 * let frame: Uint8Array | null;
 * while ((frame = framer.popFrame()) !== null) {
 *   await onFrame(frame);
 * }
 * ```
 */
export class CapnpFrameFramer {
  readonly options: CapnpFrameFramerOptions;
  #buffer = new Uint8Array(0);
  #length = 0;
  #expectedTotal: number | null = null;

  constructor(options: CapnpFrameFramerOptions = {}) {
    this.options = options;
  }

  push(data: Uint8Array): void {
    if (data.byteLength === 0) return;

    const needed = this.#length + data.byteLength;
    this.assertBufferedBytes(needed);
    if (needed > this.#buffer.byteLength) {
      const next = new Uint8Array(
        Math.max(needed, this.#buffer.byteLength * 2),
      );
      next.set(this.#buffer.subarray(0, this.#length), 0);
      this.#buffer = next;
    }
    this.#buffer.set(data, this.#length);
    this.#length = needed;
  }

  bufferedBytes(): number {
    return this.#length;
  }

  popFrame(): Uint8Array | null {
    this.updateExpectedTotal();
    if (this.#expectedTotal === null) return null;
    if (this.#length < this.#expectedTotal) return null;

    const total = this.#expectedTotal;
    const remaining = this.#length - total;
    let frame: Uint8Array;

    if (remaining === 0) {
      // Optimization: take ownership of the buffer when fully consumed,
      // avoiding a copy. Allocate a fresh buffer for future frames.
      frame = this.#buffer.subarray(0, total);
      this.#buffer = new Uint8Array(0);
    } else {
      // Must copy because we'll mutate the buffer via copyWithin
      frame = this.#buffer.slice(0, total);
      this.#buffer.copyWithin(0, total, this.#length);
    }

    this.#length = remaining;
    this.#expectedTotal = null;
    if (this.options.maxNestingDepth !== undefined) {
      validateCapnpFrame(frame, this.options);
    }
    return frame;
  }

  private updateExpectedTotal(): void {
    if (this.#expectedTotal !== null) return;
    if (this.#length < 4) return;

    const view = new DataView(
      this.#buffer.buffer,
      this.#buffer.byteOffset,
      this.#length,
    );
    const segmentCountMinusOne = view.getUint32(0, true);
    const segmentCount = segmentCountMinusOne + 1;
    if (segmentCount < 1) {
      throw new ProtocolError("invalid capnp frame segment count");
    }
    const maxSegmentCount = this.options.maxSegmentCount ??
      DEFAULT_MAX_SEGMENT_COUNT;
    if (segmentCount > maxSegmentCount) {
      throw new ProtocolError(
        `capnp frame segment count ${segmentCount} exceeds configured limit ${maxSegmentCount}`,
      );
    }

    const paddingWords = (segmentCount % 2 === 0) ? 1 : 0;
    const headerWords = 1 + segmentCount + paddingWords;
    const headerBytes = headerWords * 4;

    if (this.#length < headerBytes) return;

    let totalWords = 0;
    for (let i = 0; i < segmentCount; i += 1) {
      const wordCount = view.getUint32(4 + i * 4, true);
      totalWords += wordCount;
    }
    const maxTraversalWords = this.options.maxTraversalWords ??
      DEFAULT_MAX_TRAVERSAL_WORDS;
    if (totalWords > maxTraversalWords) {
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
    const maxFrameBytes = this.options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (totalBytes > maxFrameBytes) {
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
