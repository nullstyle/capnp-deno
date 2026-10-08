// Experimental Level-3 handoff wrappers against the real WASM boundary.
// The module under test is the checked-in runtime (feature bit 10); peers
// are created on one shared module instance exactly like session stacks do.

import {
  acceptProvision,
  CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
  CAP_DESCRIPTOR_TAG_THIRD_PARTY_HOSTED,
  encodeCallRequestFrame,
  encodeFinishFrame,
  encodeReturnExceptionFrame,
  encodeReturnResultsFrame,
  handoffCompletionFromContact,
  instantiatePeer,
  mintHandoffTokens,
  provideCapability,
  sendThirdPartyAnswer,
  WASM_EVENT_KIND_ANSWER_FINISHED,
  WASM_FEATURE_L3_HANDOFF,
  WasmPeer,
} from "../../src/advanced.ts";
import { decodeRpcMessageTag } from "../../src/rpc/wire/decode.ts";
import { decodeReturnFrame } from "../../src/rpc/wire/decode.ts";
import { assert, assertBytes, assertEquals } from "../test_utils.ts";

// Message union tags from rpc.capnp (the TypeScript codec does not yet
// model these message kinds, so the constants are local to the tests).
const RPC_MESSAGE_TAG_PROVIDE = 10;
const RPC_MESSAGE_TAG_ACCEPT = 11;
const RPC_MESSAGE_TAG_THIRD_PARTY_ANSWER = 14;

async function assertRejects(
  promise: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await promise();
  } catch (error) {
    assert(
      pattern.test(String(error)),
      `unexpected failure: ${error}`,
    );
    return;
  }
  throw new Error(`expected failure matching ${pattern}`);
}

const wasmPath = new URL("../../generated/capnp_deno.wasm", import.meta.url);

async function withModule(
  run: (peers: WasmPeer[]) => void | Promise<void>,
  peerCount = 2,
): Promise<void> {
  const { peer } = await instantiatePeer(wasmPath, {}, {
    expectedVersion: 1,
    requireVersionExport: true,
  });
  const extra: WasmPeer[] = [];
  try {
    for (let i = 1; i < peerCount; i += 1) {
      extra.push(WasmPeer.create(peer.abi));
    }
    await run([peer, ...extra]);
  } finally {
    for (const borrowed of extra) borrowed.close();
    peer.close();
  }
}

Deno.test("l3 runtime module advertises feature bit 10", async () => {
  await withModule(([a]) => {
    assert(
      (a.abi.capabilities.featureFlags & WASM_FEATURE_L3_HANDOFF) !== 0n,
      "expected the checked-in runtime to advertise the L3 handoff feature",
    );
    assert(a.abi.capabilities.hasL3Handoff);
  });
});

Deno.test("l3 provideCapability emits a Provide frame", async () => {
  await withModule(([a, b]) => {
    const tokens = mintHandoffTokens();
    const handle = provideCapability(a, b, 3, {
      recipient: tokens.toAwait,
      contact: tokens.contact,
    });
    assert(handle.questionId >= 0);
    assert(handle.vineId >= 0);

    // The Provide travels on the cap-host connection (peer a).
    const frame = a.popOutgoingFrame();
    assert(frame !== null, "expected an outbound Provide frame");
    assertEquals(decodeRpcMessageTag(frame), RPC_MESSAGE_TAG_PROVIDE);
  });
});

Deno.test("l3 acceptProvision resolves the accepted capability from the Return event", async () => {
  await withModule(async ([a]) => {
    const tokens = mintHandoffTokens();
    let questionId = -1;
    const accepted = acceptProvision(a, tokens.toAwait, {
      onQuestionId: (id) => (questionId = id),
    });
    assert(questionId >= 0, "expected the Accept question id synchronously");

    // The Accept frame leaves on this connection first.
    const acceptFrame = a.popOutgoingFrame();
    assert(acceptFrame !== null, "expected an outbound Accept frame");
    assertEquals(decodeRpcMessageTag(acceptFrame), RPC_MESSAGE_TAG_ACCEPT);

    // The host of the provided cap answers with a results Return whose cap
    // table grants the accepted capability.
    const expectedIndex = 5;
    a.pushFrame(encodeReturnResultsFrame({
      answerId: questionId,
      capTable: [{
        tag: CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
        id: expectedIndex,
      }],
    }));

    const result = await accepted;
    assert(
      result.capabilityIndex === expectedIndex,
      `expected capabilityIndex ${expectedIndex}, got ${result.capabilityIndex}`,
    );
  });
});

Deno.test("l3 acceptProvision rejects on an exception Return event", async () => {
  await withModule(async ([a]) => {
    const tokens = mintHandoffTokens();
    let questionId = -1;
    const accepted = acceptProvision(a, tokens.toAwait, {
      onQuestionId: (id) => (questionId = id),
    });
    a.popOutgoingFrame();
    a.pushFrame(encodeReturnExceptionFrame({
      answerId: questionId,
      reason: "provision expired",
    }));
    await assertRejects(() => accepted, /provision expired/);
  });
});

Deno.test("l3 sendThirdPartyAnswer returns a protocol-range answer id", async () => {
  await withModule(([a]) => {
    const tokens = mintHandoffTokens();
    const answerId = sendThirdPartyAnswer(a, tokens.toAwait);
    assert(
      answerId >= 2 ** 30 && answerId < 2 ** 31,
      `expected answerId in [2^30, 2^31), got ${answerId}`,
    );
    const frame = a.popOutgoingFrame();
    assert(frame !== null, "expected an outbound ThirdPartyAnswer frame");
    assertEquals(
      decodeRpcMessageTag(frame),
      RPC_MESSAGE_TAG_THIRD_PARTY_ANSWER,
    );
  });
});

Deno.test("l3 live flow: vine delivered as thirdPartyHosted, recipient resolves and accepts", async () => {
  await withModule(async ([bc, ab, aToC]) => {
    // VatB originates the handoff across its two connections: the cap lives
    // on the bc connection (import 0), the recipient is reachable via ab.
    const tokens = mintHandoffTokens();
    const handle = provideCapability(bc, ab, 0, {
      recipient: tokens.toAwait,
      contact: tokens.contact,
    });
    const provideFrame = bc.popOutgoingFrame();
    assert(
      provideFrame !== null,
      "expected the Provide on the cap-host connection",
    );

    // The recipient asks VatB for the capability; VatB answers through the
    // host-call bridge with a Return whose cap table carries the vine as a
    // thirdPartyHosted descriptor.
    assertEquals(
      ab.pushFrame(encodeCallRequestFrame({
        questionId: 5,
        targetImportedCap: 0,
        interfaceId: 1n,
        methodId: 0,
      })).frames.length,
      0,
    );
    const hostCall = ab.abi.popHostCall(ab.handle);
    assert(hostCall !== null, "expected VatB to queue the call for the host");
    ab.abi.respondHostCallReturnFrame(
      ab.handle,
      encodeReturnResultsFrame({
        answerId: hostCall.questionId,
        capTable: [{
          tag: CAP_DESCRIPTOR_TAG_THIRD_PARTY_HOSTED,
          id: 0,
          vineId: handle.vineId,
          contact: tokens.contact,
        }],
      }),
    );
    const delivered = ab.drainOutgoingFrames().frames;
    assertEquals(delivered.length, 1);
    const decoded = decodeReturnFrame(delivered[0]);
    assert(decoded.kind === "results");
    const descriptor = decoded.capTable.find((entry) =>
      entry.tag === CAP_DESCRIPTOR_TAG_THIRD_PARTY_HOSTED
    );
    assert(descriptor !== undefined, "expected a thirdPartyHosted descriptor");
    assertEquals(descriptor.vineId, handle.vineId);
    assertBytes(
      descriptor.contact ?? new Uint8Array(0),
      Array.from(tokens.contact),
    );

    // The recipient resolves the contact into a completion and accepts it on
    // its own connection to the cap's host; that host answers with the
    // capability placement.
    const completion = handoffCompletionFromContact(descriptor.contact!);
    assertBytes(completion, Array.from(tokens.toAwait));
    let questionId = -1;
    const accepted = acceptProvision(aToC, completion, {
      onQuestionId: (id) => (questionId = id),
    });
    const acceptFrame = aToC.popOutgoingFrame();
    assert(acceptFrame !== null, "expected the Accept on the third connection");
    assertEquals(decodeRpcMessageTag(acceptFrame), RPC_MESSAGE_TAG_ACCEPT);
    aToC.pushFrame(encodeReturnResultsFrame({
      answerId: questionId,
      capTable: [{ tag: CAP_DESCRIPTOR_TAG_SENDER_HOSTED, id: 9 }],
    }));
    assertEquals((await accepted).capabilityIndex, 9);
  }, 3);
});

Deno.test("l3 live flow: a shared provision index lets VatC answer the Accept itself", async () => {
  // The full autonomous three-party topology: VatC is two module-local peers
  // (cToB receives the Provide, cToA receives the Accept) attached to one
  // provision index, so the Accept crossing connections is served by the
  // runtime — no host-forged Returns anywhere in the flow.
  await withModule(async ([bToC, bToA, cToB, cToA, aToC]) => {
    assert(
      bToC.abi.capabilities.hasL3VatHosting,
      "expected the checked-in runtime to advertise vat hosting (bit 11)",
    );

    // VatC hosts the capability: a bootstrap stub publishes an export on the
    // C<->B connection, which VatB's import 0 names as the provided target.
    const stubExportId = cToB.abi.setBootstrapStubWithId(cToB.handle);
    assert(stubExportId >= 0);

    const index = bToC.abi.createProvisionIndex();
    try {
      bToC.abi.attachProvisionIndex(cToB.handle, index);
      bToC.abi.attachProvisionIndex(cToA.handle, index);

      const tokens = mintHandoffTokens();
      provideCapability(bToC, bToA, 0, {
        recipient: tokens.toAwait,
        contact: tokens.contact,
      });

      // The Provide lands on VatC's C<->B peer and registers into the index.
      const provideFrame = bToC.popOutgoingFrame();
      assert(provideFrame !== null);
      cToB.pushFrame(provideFrame);

      // VatA accepts on its own C<->A connection.
      let questionId = -1;
      const accepted = acceptProvision(aToC, tokens.toAwait, {
        onQuestionId: (id) => (questionId = id),
      });
      const acceptFrame = aToC.popOutgoingFrame();
      assert(acceptFrame !== null);
      assertEquals(decodeRpcMessageTag(acceptFrame), RPC_MESSAGE_TAG_ACCEPT);

      // The Accept lands on VatC's C<->A peer; the shared index matches the
      // sibling connection's provision and VatC answers by itself. (pushFrame
      // drains the peer's outbound frames alongside the L3 events.)
      const answered = cToA.pushFrame(acceptFrame).frames;
      assertEquals(
        answered.length,
        1,
        "expected VatC's own answer to the Accept",
      );
      const answer = answered[0];
      const decodedAnswer = decodeReturnFrame(answer);
      assert(decodedAnswer.kind === "results");
      assert(
        decodedAnswer.answerId === questionId,
        "expected the answer addressed to the Accept question",
      );
      assert(decodedAnswer.capTable.length >= 1);

      // The answer returns to VatA and resolves the capability placement.
      aToC.pushFrame(answer);
      const result = await accepted;
      assert(
        result.capabilityIndex >= 0,
        "expected the accepted capability import index",
      );
    } finally {
      // Index-first teardown (the documented supported order when live
      // provisions remain): freeing the index severs both peers' borrowed
      // back-pointers and neutralizes the still-open provision.
      bToC.abi.freeProvisionIndex(index);
    }
  }, 5);
});

Deno.test("answer cancellation: caller Finish surfaces a kind-4 event and sendReturnCanceled answers", async () => {
  await withModule(([server]) => {
    assert(
      server.abi.capabilities.hasAnswerCancellation,
      "expected the checked-in runtime to advertise answer cancellation (bit 12)",
    );
    server.abi.setAnswerFinishedHandler(server.handle, true);

    // An inbound Call the host never answers: bootstrap import target.
    const questionId = 9;
    server.pushFrame(encodeCallRequestFrame({
      questionId,
      targetImportedCap: 0,
      interfaceId: 0xa100n,
      methodId: 3,
    }));
    const hostCall = server.abi.popHostCall(server.handle);
    assert(hostCall !== null, "expected the call queued for the host");

    // The caller gives up: Finish (release result caps) before any Return.
    // Subscribe before the push: pushFrame drains L3 events in pump order.
    const events: number[] = [];
    const unsubscribe = server.addL3EventListener((event) => {
      if (event.kind === WASM_EVENT_KIND_ANSWER_FINISHED) {
        events.push(
          new DataView(
            event.payload.buffer,
            event.payload.byteOffset,
            event.payload.byteLength,
          ).getUint32(0, true),
        );
      }
    });
    server.pushFrame(
      encodeFinishFrame({ questionId, releaseResultCaps: true }),
    );
    unsubscribe();
    assertEquals(events.length, 1);
    assertEquals(events[0], questionId);

    // Answering emits exactly the Return{canceled} frame.
    server.abi.sendReturnCanceled(server.handle, questionId);
    const answer = server.popOutgoingFrame();
    assert(answer !== null, "expected the canceled Return");
    const decoded = decodeReturnFrame(answer);
    assert(decoded.kind === "canceled");
    assertEquals(decoded.answerId, questionId);

    // The id is spent: a second cancel refuses.
    let refused = false;
    try {
      server.abi.sendReturnCanceled(server.handle, questionId);
    } catch {
      refused = true;
    }
    assert(refused, "expected the second cancel to refuse");
  });
});

Deno.test("answer cancellation: sendReturnCanceled refuses before the caller finishes", async () => {
  await withModule(([server]) => {
    server.abi.setAnswerFinishedHandler(server.handle, true);
    server.pushFrame(encodeCallRequestFrame({
      questionId: 4,
      targetImportedCap: 0,
      interfaceId: 0xa100n,
      methodId: 3,
    }));
    const hostCall = server.abi.popHostCall(server.handle);
    assert(hostCall !== null);
    let refused = false;
    try {
      server.abi.sendReturnCanceled(server.handle, 4);
    } catch (error) {
      refused = String(error).includes("AnswerNotFinished");
    }
    assert(refused, "expected AnswerNotFinished");
  });
});
