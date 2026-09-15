import {
  CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
  decodeCallRequestFrame,
  decodeReturnFrame,
  decodeRpcMessageTag,
  EMPTY_STRUCT_MESSAGE,
  encodeCallRequestFrame,
  encodeReleaseFrame,
  encodeReturnExceptionFrame,
  encodeReturnResultsFrame,
  InMemoryRpcHarnessTransport,
  ProtocolError,
  RPC_MESSAGE_TAG_CALL,
  RPC_MESSAGE_TAG_FINISH,
  RPC_MESSAGE_TAG_RETURN,
  RpcSession,
  type RpcTransport,
  RpcWireClient,
  SessionError,
  SessionRpcClientTransport,
  WasmPeer,
} from "../src/advanced.ts";
import {
  createPingerClient,
  createPingerServiceClient,
  PongerInterfaceId,
} from "../examples/ping/gen/schema_types.ts";
import { RETURN_TAG_BYTE_OFFSET } from "../src/rpc/gen/capnp/rpc_wire_constants.ts";
import {
  decodeStructPointer,
  pointerWordIndex,
  segmentsFromFrame,
} from "../src/rpc/wire.ts";
import { FakeCapnpWasm } from "./fake_wasm.ts";
import { assert, assertEquals, withTimeout } from "./test_utils.ts";

type Adapter = "wire" | "session";
type Terminal = "results" | "exception" | "canceled";

function terminalFrame(
  answerId: number,
  kind: Terminal,
  releaseParamCaps = true,
): Uint8Array {
  const flags = { answerId, releaseParamCaps, noFinishNeeded: true };
  if (kind === "exception") {
    return encodeReturnExceptionFrame({ ...flags, reason: "expected failure" });
  }
  const frame = encodeReturnResultsFrame({
    ...flags,
    content: EMPTY_STRUCT_MESSAGE,
  });
  if (kind === "canceled") {
    const table = segmentsFromFrame(frame);
    const root = decodeStructPointer(table, { segmentId: 0, wordIndex: 0 })!;
    const response = decodeStructPointer(table, pointerWordIndex(root, 0))!;
    table.views[response.segmentId].setUint16(
      response.startWord * 8 + RETURN_TAG_BYTE_OFFSET,
      2,
      true,
    );
  }
  return frame;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  await withTimeout(
    (async () => {
      while (!predicate()) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })(),
    500,
    label,
  );
}

function harness(
  adapter: Adapter,
  maxOutstandingParamCapQuestions?: number,
  failCallAfterHandoff = false,
) {
  const sent: Uint8Array[] = [];
  if (adapter === "wire") {
    let onFrame: (frame: Uint8Array) => void | Promise<void> = () => {};
    const transport: RpcTransport = {
      start(callback) {
        onFrame = callback;
      },
      send(frame) {
        sent.push(new Uint8Array(frame));
        if (
          failCallAfterHandoff &&
          decodeRpcMessageTag(frame) === RPC_MESSAGE_TAG_CALL
        ) {
          failCallAfterHandoff = false;
          return Promise.reject(
            new Error("write failed after request handoff"),
          );
        }
      },
      close() {},
    };
    return {
      client: new RpcWireClient(transport, {
        interfaceId: 8n,
        maxOutstandingParamCapQuestions,
      }),
      sent,
      receive: async (frame: Uint8Array) => {
        await onFrame(frame);
      },
    };
  }
  const fake = new FakeCapnpWasm({
    onPushFrame(frame) {
      sent.push(frame);
      return [];
    },
    extraExports: {
      capnp_peer_pop_host_call: () => 0,
      capnp_peer_respond_host_call_results: () => {},
      capnp_peer_respond_host_call_exception: () => {},
    },
  });
  class HandoffTransport extends InMemoryRpcHarnessTransport {
    override async emitInbound(frame: Uint8Array): Promise<void> {
      await super.emitInbound(frame);
      if (
        failCallAfterHandoff &&
        decodeRpcMessageTag(frame) === RPC_MESSAGE_TAG_CALL
      ) {
        failCallAfterHandoff = false;
        throw new Error("write failed after request handoff");
      }
    }
  }
  const transport = new HandoffTransport();
  const session = new RpcSession(WasmPeer.fromExports(fake.exports), transport);
  return {
    client: new SessionRpcClientTransport(session, transport, {
      interfaceId: 8n,
      maxOutstandingParamCapQuestions,
    }),
    sent,
    receive: (frame: Uint8Array) => {
      transport.send(frame);
    },
  };
}

async function callbackProbe(
  h: ReturnType<typeof harness>,
  id: number,
  interfaceId: bigint,
  questionId: number,
): Promise<"results" | "exception" | "canceled"> {
  await h.receive(encodeCallRequestFrame({
    questionId,
    target: { tag: 0, importedCap: id },
    interfaceId,
    methodId: 0,
    paramsContent: EMPTY_STRUCT_MESSAGE,
  }));
  const find = () =>
    h.sent.find((frame) =>
      decodeRpcMessageTag(frame) === RPC_MESSAGE_TAG_RETURN &&
      decodeReturnFrame(frame).answerId === questionId
    );
  await waitFor(() => find() !== undefined, "callback response");
  return decodeReturnFrame(find()!).kind;
}

for (const adapter of ["wire", "session"] as const) {
  for (const kind of ["results", "exception", "canceled"] as const) {
    for (const late of [false, true]) {
      Deno.test(`${adapter}: generated callback grant settles on ${late ? "late " : ""}${kind} Return`, async () => {
        const h = harness(adapter);
        const controller = new AbortController();
        const pinger = createPingerServiceClient(
          createPingerClient(h.client, { capabilityIndex: 9 }),
          h.client,
        );
        let callbacks = 0;
        try {
          const call = pinger.ping({
            pong() {
              callbacks++;
              return Promise.resolve();
            },
          }, {
            signal: controller.signal,
          }).then(() => null, (error) => error);
          await waitFor(
            () =>
              h.sent.some((f) =>
                decodeRpcMessageTag(f) === RPC_MESSAGE_TAG_CALL
              ),
            "generated call written",
          );
          const request = decodeCallRequestFrame(
            h.sent.find((f) =>
              decodeRpcMessageTag(f) === RPC_MESSAGE_TAG_CALL
            )!,
          );
          assertEquals(request.paramsCapTable.length, 1);
          const id = request.paramsCapTable[0].id;
          assertEquals(
            await callbackProbe(h, id, PongerInterfaceId, 1000),
            "results",
          );
          assertEquals(callbacks, 1);
          if (late) {
            controller.abort();
            assert(await call instanceof SessionError);
          }
          const finishesBefore = h.sent.filter((f) =>
            decodeRpcMessageTag(f) === RPC_MESSAGE_TAG_FINISH
          ).length;
          await h.receive(terminalFrame(request.questionId, kind));
          if (!late) {
            const result = await call;
            if (kind === "results") {
              assertEquals(result, null);
            } else assert(result instanceof ProtocolError);
          }
          assertEquals(
            await callbackProbe(h, id, PongerInterfaceId, 1001),
            "exception",
            "settled generated callback must no longer be callable",
          );
          assertEquals(callbacks, 1);
          assertEquals(h.client.exportedCapabilityCount, 0);
          assertEquals(h.client.pendingReturnCount, 0);
          if (late) {
            assertEquals(
              h.sent.filter((f) =>
                decodeRpcMessageTag(f) === RPC_MESSAGE_TAG_FINISH
              ).length,
              finishesBefore,
              "terminal must not send a second Finish",
            );
          }
        } finally {
          await h.client.close();
        }
      });
    }
  }

  for (const releaseParamCaps of [true, false]) {
    Deno.test(`${adapter}: repeated param grants preserve another lease and settle once (implicit=${releaseParamCaps})`, async () => {
      const h = harness(adapter);
      try {
        const cap = h.client.exportCapability({
          interfaceId: 8n,
          dispatch: () => EMPTY_STRUCT_MESSAGE,
        }, { referenceCount: 3 });
        const controller = new AbortController();
        const result = h.client.callRaw(
          { capabilityIndex: 9 },
          0,
          EMPTY_STRUCT_MESSAGE,
          {
            signal: controller.signal,
            paramsCapTable: [cap, cap].map((c) => ({
              tag: CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
              id: c.capabilityIndex,
            })),
          },
        ).catch((error) => error);
        await waitFor(
          () => h.client.pendingReturnCount === 1,
          "pending cap-bearing call",
        );
        controller.abort();
        assert(await result instanceof SessionError);
        if (!releaseParamCaps) {
          // A retaining peer can release the two grants before its terminal.
          await h.receive(
            encodeReleaseFrame({ id: cap.capabilityIndex, referenceCount: 2 }),
          );
        }
        await h.receive(terminalFrame(1, "canceled", releaseParamCaps));
        assertEquals(
          await callbackProbe(h, cap.capabilityIndex, 8n, 2000),
          "results",
        );
        // Replayed terminal flags must not spend an unrelated standing grant.
        await h.receive(terminalFrame(1, "canceled", true));
        assertEquals(
          await callbackProbe(h, cap.capabilityIndex, 8n, 2001),
          "results",
        );
        await h.receive(
          encodeReleaseFrame({ id: cap.capabilityIndex, referenceCount: 1 }),
        );
        assertEquals(
          await callbackProbe(h, cap.capabilityIndex, 8n, 2002),
          "exception",
        );
        assertEquals(h.client.exportedCapabilityCount, 0);
      } finally {
        await h.client.close();
      }
    });
  }
}

for (const adapter of ["wire", "session"] as const) {
  Deno.test(`${adapter}: standing Release then implicit param release retires both grants`, async () => {
    const h = harness(adapter);
    try {
      const cap = h.client.exportCapability({
        interfaceId: 8n,
        dispatch: () => EMPTY_STRUCT_MESSAGE,
      }, { referenceCount: 2 });
      const result = h.client.callRaw(
        { capabilityIndex: 9 },
        0,
        EMPTY_STRUCT_MESSAGE,
        {
          paramsCapTable: [{
            tag: CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
            id: cap.capabilityIndex,
          }],
        },
      );
      await waitFor(
        () => h.client.pendingReturnCount === 1,
        "pending cap call",
      );
      // Release cannot identify a question: this drops the older standing
      // grant, so the pending Call grant must still settle from Return(true).
      await h.receive(
        encodeReleaseFrame({ id: cap.capabilityIndex, referenceCount: 1 }),
      );
      assertEquals(
        await callbackProbe(h, cap.capabilityIndex, 8n, 3000),
        "results",
      );
      await h.receive(terminalFrame(1, "results"));
      await result;
      assertEquals(
        await callbackProbe(h, cap.capabilityIndex, 8n, 3001),
        "exception",
      );
      assertEquals(h.client.exportedCapabilityCount, 0);
    } finally {
      await h.client.close();
    }
  });

  Deno.test(`${adapter}: aborted grant questions remain bounded until terminal or close`, async () => {
    const h = harness(adapter, 2);
    const pinger = createPingerServiceClient(
      createPingerClient(h.client, { capabilityIndex: 9 }),
      h.client,
    );
    const questions: number[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const controller = new AbortController();
        const call = pinger.ping({ pong: () => Promise.resolve() }, {
          signal: controller.signal,
          onQuestionId(id) {
            questions.push(id);
          },
        }).catch((error) => error);
        await waitFor(
          () => h.client.pendingReturnCount === 1,
          "pending generated call",
        );
        controller.abort();
        assert(await call instanceof SessionError);
      }
      const before = h.sent.length;
      const rejected = await withTimeout(
        pinger.ping({ pong: () => Promise.resolve() }).catch((error) => error),
        500,
        "full param-cap admission rejects",
      );
      assert(
        rejected instanceof SessionError &&
          /param.*cap.*question/i.test(rejected.message),
      );
      assertEquals(
        h.sent.length,
        before,
        "admission limit must not send a Call",
      );
      assertEquals(
        h.client.exportedCapabilityCount,
        2,
        "rejected generated admission must not leak a new export",
      );
      const firstCall = h.sent.find((frame) =>
        decodeRpcMessageTag(frame) === RPC_MESSAGE_TAG_CALL
      )!;
      const firstCap = decodeCallRequestFrame(firstCall).paramsCapTable[0].id;
      assertEquals(
        await callbackProbe(h, firstCap, PongerInterfaceId, 4000),
        "results",
        "admission limit must not evict an existing remote grant",
      );
      let announced = false;
      const rejectedRaw = await h.client.callRaw(
        { capabilityIndex: 9 },
        0,
        EMPTY_STRUCT_MESSAGE,
        {
          paramsCapTable: [{
            tag: CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
            id: firstCap,
          }],
          onQuestionId() {
            announced = true;
          },
        },
      ).catch((error) => error);
      assert(rejectedRaw instanceof SessionError);
      assertEquals(
        announced,
        false,
        "rejected admission must not transfer ownership through onQuestionId",
      );
      // This bound only covers grants: cap-free work and control traffic
      // continue while the remote still holds canceled Call references.
      const capFree = h.client.callRaw(
        { capabilityIndex: 9 },
        0,
        EMPTY_STRUCT_MESSAGE,
      );
      await waitFor(
        () => h.client.pendingReturnCount === 1,
        "cap-free call admitted at limit",
      );
      const capFreeFrame = h.sent.filter((frame) =>
        decodeRpcMessageTag(frame) === RPC_MESSAGE_TAG_CALL
      ).at(-1)!;
      await h.receive(
        terminalFrame(
          decodeCallRequestFrame(capFreeFrame).questionId,
          "results",
        ),
      );
      await capFree;
      assertEquals(h.client.exportedCapabilityCount, 2);
      await h.receive(terminalFrame(questions[0], "canceled"));
      await waitFor(
        () => h.client.exportedCapabilityCount === 1,
        "terminal releases admission slot",
      );
      const next = pinger.ping({ pong: () => Promise.resolve() }).then(
        () => null,
        (error) => error,
      );
      await waitFor(
        () => h.client.pendingReturnCount === 1,
        "call admitted after terminal",
      );
      const lastCall = h.sent.filter((frame) =>
        decodeRpcMessageTag(frame) === RPC_MESSAGE_TAG_CALL
      ).at(-1)!;
      await h.receive(
        terminalFrame(decodeCallRequestFrame(lastCall).questionId, "results"),
      );
      assertEquals(await next, null);
      await h.client.close();
      assertEquals(h.client.exportedCapabilityCount, 0);
      assertEquals(h.client.pendingReturnCount, 0);
    } finally {
      await h.client.close();
    }
  });
}

for (const adapter of ["wire", "session"] as const) {
  Deno.test(`${adapter}: timed-out param grant settles only after terminal`, async () => {
    const h = harness(adapter);
    try {
      const cap = h.client.exportCapability({
        interfaceId: 8n,
        dispatch: () => EMPTY_STRUCT_MESSAGE,
      });
      const result = h.client.callRaw(
        { capabilityIndex: 9 },
        0,
        EMPTY_STRUCT_MESSAGE,
        {
          timeoutMs: 5,
          paramsCapTable: [{
            tag: CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
            id: cap.capabilityIndex,
          }],
        },
      ).catch((error) => error);
      assert(await result instanceof SessionError);
      assertEquals(h.client.pendingReturnCount, 0);
      assertEquals(
        await callbackProbe(h, cap.capabilityIndex, 8n, 5000),
        "results",
      );
      await h.receive(terminalFrame(1, "exception"));
      assertEquals(
        await callbackProbe(h, cap.capabilityIndex, 8n, 5001),
        "exception",
      );
      assertEquals(h.client.exportedCapabilityCount, 0);
    } finally {
      await h.client.close();
    }
  });
}

Deno.test("session: pipelined aborted param grants wait for manual Finish and terminal", async () => {
  const h = harness("session");
  assert(h.client instanceof SessionRpcClientTransport);
  const controller = new AbortController();
  try {
    const cap = h.client.exportCapability({
      interfaceId: 8n,
      dispatch: () => EMPTY_STRUCT_MESSAGE,
    });
    const { pipeline, result } = await h.client.callRawPipelined(
      { capabilityIndex: 9 },
      0,
      EMPTY_STRUCT_MESSAGE,
      {
        signal: controller.signal,
        paramsCapTable: [{
          tag: CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
          id: cap.capabilityIndex,
        }],
      },
    );
    const rejection = result.catch((error) => error);
    controller.abort();
    assert(await rejection instanceof SessionError);
    assertEquals(
      h.sent.filter((frame) =>
        decodeRpcMessageTag(frame) === RPC_MESSAGE_TAG_FINISH
      ).length,
      0,
    );
    assertEquals(
      await callbackProbe(h, cap.capabilityIndex, 8n, 6000),
      "results",
    );
    await h.client.finish(pipeline.questionId);
    await h.receive(terminalFrame(pipeline.questionId, "canceled"));
    assertEquals(
      await callbackProbe(h, cap.capabilityIndex, 8n, 6001),
      "exception",
    );
    assertEquals(h.client.exportedCapabilityCount, 0);
  } finally {
    await h.client.close();
  }
});

for (
  const [adapter, pipelined] of [["wire", false], ["session", false], [
    "session",
    true,
  ]] as const
) {
  Deno.test(`${adapter}${pipelined ? " pipelined" : ""}: rejected write can still receive a terminal Return`, async () => {
    const h = harness(adapter, 1, true);
    try {
      // One outstanding Call grant and one unrelated standing grant.
      const cap = h.client.exportCapability({
        interfaceId: 8n,
        dispatch: () => EMPTY_STRUCT_MESSAGE,
      }, { referenceCount: 2 });
      const options = {
        paramsCapTable: [{
          tag: CAP_DESCRIPTOR_TAG_SENDER_HOSTED,
          id: cap.capabilityIndex,
        }],
      };
      let call: Promise<unknown>;
      if (pipelined) {
        assert(h.client instanceof SessionRpcClientTransport);
        call = h.client.callRawPipelined(
          { capabilityIndex: 9 },
          0,
          EMPTY_STRUCT_MESSAGE,
          options,
        );
      } else {
        call = h.client.callRaw(
          { capabilityIndex: 9 },
          0,
          EMPTY_STRUCT_MESSAGE,
          options,
        );
      }
      const failed = await withTimeout(
        call.then(() => null, (error) => error),
        500,
        "late-failing write rejects caller",
      );
      assert(failed instanceof Error);
      assertEquals(
        h.sent.filter((frame) =>
          decodeRpcMessageTag(frame) === RPC_MESSAGE_TAG_CALL
        ).length,
        1,
        "transport accepted the request before rejecting its write promise",
      );
      assertEquals(h.client.pendingReturnCount, 0);
      assertEquals(
        await callbackProbe(h, cap.capabilityIndex, 8n, 7000),
        "results",
      );
      await h.receive(terminalFrame(1, "exception"));
      assertEquals(
        await callbackProbe(h, cap.capabilityIndex, 8n, 7001),
        "results",
        "the unrelated standing grant remains callable",
      );
      await h.receive(terminalFrame(1, "exception"));
      assertEquals(
        await callbackProbe(h, cap.capabilityIndex, 8n, 7002),
        "results",
        "duplicate terminal must not retire the standing grant",
      );
      await h.receive(
        encodeReleaseFrame({ id: cap.capabilityIndex, referenceCount: 1 }),
      );
      assertEquals(
        await callbackProbe(h, cap.capabilityIndex, 8n, 7003),
        "exception",
        "late terminal and explicit standing release must retire exactly two grants",
      );
      assertEquals(h.client.exportedCapabilityCount, 0);
    } finally {
      await h.client.close();
    }
  });
}
