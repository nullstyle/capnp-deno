// Experimental Level-3 handoff wrappers against the real WASM boundary.
// The module under test is the checked-in runtime (feature bit 10); peers
// are created on one shared module instance exactly like session stacks do.

import {
  acceptProvision,
  CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
  CAP_DESCRIPTOR_TAG_THIRD_PARTY_HOSTED,
  encodeCallRequestFrame,
  encodeReturnExceptionFrame,
  encodeReturnResultsFrame,
  handoffCompletionFromContact,
  instantiatePeer,
  mintHandoffTokens,
  provideCapability,
  sendThirdPartyAnswer,
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
