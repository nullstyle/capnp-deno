import * as encoding from "../src/encoding.ts";
import * as rpc from "../src/rpc.ts";
import { assert } from "./test_utils.ts";

Deno.test("rpc entrypoint exposes runtime APIs but not encoding helpers", () => {
  assert("TCP" in rpc, "expected rpc entrypoint to export TCP service helpers");
  assert("WS" in rpc, "expected rpc entrypoint to export WS service helpers");
  assert(
    !("encodeCallRequestFrame" in rpc),
    "rpc entrypoint should not export wire encode helpers",
  );
  assert(
    !("CapnpFrameFramer" in rpc),
    "rpc entrypoint should not export framing helpers",
  );
  assert(
    !("WasmSerde" in rpc),
    "rpc entrypoint should not export encoding serde helpers",
  );
});

Deno.test("encoding entrypoint exposes serde/runtime APIs but not rpc helpers", () => {
  assert(
    "WasmSerde" in encoding,
    "expected encoding entrypoint to export serde helpers",
  );
  assert(
    "encodeStructMessage" in encoding,
    "expected encoding entrypoint to export struct encoding helpers",
  );
  assert(
    "decodeStructMessage" in encoding,
    "expected encoding entrypoint to export struct decoding helpers",
  );
  assert(
    !("encodeCallRequestFrame" in encoding),
    "encoding entrypoint should not export rpc wire helpers",
  );
  assert(
    !("CapnpFrameFramer" in encoding),
    "encoding entrypoint should not export rpc framing helpers",
  );
  assert(
    !("TCP" in encoding),
    "encoding entrypoint should not export TCP runtime helpers",
  );
  assert(
    !("WS" in encoding),
    "encoding entrypoint should not export WS runtime helpers",
  );
  assert(
    !("RpcSession" in encoding),
    "encoding entrypoint should not export session runtime",
  );
});
