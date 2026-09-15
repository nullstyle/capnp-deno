import type { RpcTransport } from "../../../src/advanced.ts";
import {
  CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
  decodeCallRequestFrame,
  decodeFinishFrame,
  decodeReleaseFrame,
  decodeRpcMessageTag,
  decodeStructPointer,
  pointerWordIndex,
  readU32InStruct,
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_FINISH,
  RPC_MESSAGE_TAG_RELEASE,
  RPC_MESSAGE_TAG_RETURN,
  segmentsFromFrame,
} from "../../../src/rpc/wire.ts";
import { assert, assertEquals } from "../../test_utils.ts";
import {
  DoublerInterfaceId,
  DoublerMethodOrdinals,
} from "./gen/interop_types.ts";

/** Inspect actual wire traffic without changing its order or contents. */
export class CancellationAudit {
  #questionId: number | undefined;
  #capabilityId: number | undefined;
  #trackingQuestion = true;
  #finished = 0;
  #returned = 0;
  #released = 0;

  wrap(transport: RpcTransport, denoIsCaller: boolean): RpcTransport {
    return {
      start: (receive) =>
        transport.start((frame) => {
          this.#observe(frame, !denoIsCaller);
          return receive(frame);
        }),
      send: (frame) => {
        this.#observe(frame, denoIsCaller);
        return transport.send(frame);
      },
      close: () => transport.close(),
      subscribeClose: (observer) =>
        transport.subscribeClose?.(observer) ??
          (() => {}),
    };
  }

  #observe(frame: Uint8Array, fromCaller: boolean): void {
    const tag = decodeRpcMessageTag(frame);
    if (fromCaller && tag === RPC_MESSAGE_TAG_CALL) {
      const call = decodeCallRequestFrame(frame);
      if (this.#trackingQuestion && call.questionId === this.#questionId) {
        // Native peers can reuse an ID after Finish and its terminal Return.
        // Continue auditing the original call generation, not its successor.
        assertEquals(this.#finished, 1, "question reuse follows Finish");
        assertEquals(
          this.#returned,
          1,
          "question reuse follows terminal Return",
        );
        this.#trackingQuestion = false;
      }
      if (
        call.interfaceId === DoublerInterfaceId &&
        call.methodId === DoublerMethodOrdinals.hold
      ) {
        assertEquals(this.#questionId, undefined, "one pending hold per row");
        this.#questionId = call.questionId;
        assertEquals(call.paramsCapTable.length, 1);
        assertEquals(
          call.paramsCapTable[0].tag,
          CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
        );
        this.#capabilityId = call.paramsCapTable[0].id;
      }
    } else if (fromCaller && tag === RPC_MESSAGE_TAG_FINISH) {
      const finish = decodeFinishFrame(frame);
      if (this.#trackingQuestion && finish.questionId === this.#questionId) {
        assertEquals(
          this.#returned,
          0,
          "Finish must cancel a still-pending RPC",
        );
        this.#finished++;
      }
    } else if (!fromCaller && tag === RPC_MESSAGE_TAG_RETURN) {
      // Only read the common Return header: native C++ may send canceled,
      // which is not a normal results/exception response for a live caller.
      const segments = segmentsFromFrame(frame);
      const message = decodeStructPointer(segments, {
        segmentId: 0,
        wordIndex: 0,
      });
      assert(message !== null);
      const response = decodeStructPointer(
        segments,
        pointerWordIndex(message, 0),
      );
      assert(response !== null);
      if (
        this.#trackingQuestion &&
        readU32InStruct(segments, response, 0) === this.#questionId
      ) this.#returned++;
    } else if (!fromCaller && tag === RPC_MESSAGE_TAG_RELEASE) {
      const release = decodeReleaseFrame(frame);
      if (release.id === this.#capabilityId) {
        this.#released += release.referenceCount;
      }
    }
  }

  check(): void {
    assert(this.#questionId !== undefined, "pending hold crossed the wire");
    assertEquals(this.#finished, 1, "pending hold gets exactly one Finish");
    assertEquals(
      this.#returned,
      1,
      "canceled question receives its terminal Return",
    );
    assertEquals(
      this.#released,
      1,
      "held callback capability is released once",
    );
  }
}

/**
 * Force the native scheduling edge: enqueue cancellation and the following
 * status Call together, without changing either frame's bytes or their order.
 * The outer audit still observes every individual frame.
 */
export class BatchedCancellationTransport implements RpcTransport {
  #holdQuestionId: number | undefined;
  #finish: Uint8Array | undefined;
  #batches = 0;

  constructor(readonly transport: RpcTransport) {}

  start(
    receive: (frame: Uint8Array) => void | Promise<void>,
  ): void | Promise<void> {
    return this.transport.start(receive);
  }

  send(frame: Uint8Array): void | Promise<void> {
    const tag = decodeRpcMessageTag(frame);
    if (tag === RPC_MESSAGE_TAG_CALL) {
      const call = decodeCallRequestFrame(frame);
      if (
        call.interfaceId === DoublerInterfaceId &&
        call.methodId === DoublerMethodOrdinals.hold
      ) {
        this.#holdQuestionId = call.questionId;
      }
      if (this.#finish) {
        assertEquals(call.interfaceId, DoublerInterfaceId);
        assertEquals(call.methodId, DoublerMethodOrdinals.holdStatus);
        const batch = new Uint8Array(
          this.#finish.byteLength + frame.byteLength,
        );
        batch.set(this.#finish);
        batch.set(frame, this.#finish.byteLength);
        this.#finish = undefined;
        this.#batches++;
        return this.transport.send(batch);
      }
    }
    if (tag === RPC_MESSAGE_TAG_FINISH) {
      const finish = decodeFinishFrame(frame);
      if (finish.questionId === this.#holdQuestionId) {
        assertEquals(
          finish.requireEarlyCancellation,
          true,
          "exercise the legacy deferred-cancellation scheduling edge",
        );
        assertEquals(this.#finish, undefined);
        // Accept the bytes into this bounded test queue. The next status Call
        // flushes both frames in one TCP transport write, as packet coalescing can.
        this.#finish = new Uint8Array(frame);
        return;
      }
    }
    assertEquals(this.#finish, undefined, "no frame may overtake held Finish");
    return this.transport.send(frame);
  }

  close(): void | Promise<void> {
    return this.transport.close();
  }
  subscribeClose(observer: () => void | Promise<void>): () => void {
    return this.transport.subscribeClose?.(observer) ?? (() => {});
  }

  check(): void {
    assertEquals(
      this.#batches,
      1,
      "Finish and status must share one TCP write",
    );
    assertEquals(
      this.#finish,
      undefined,
      "buffered Finish must have been sent",
    );
  }
}
