import { assert, assertEquals } from "../test_utils.ts";
import {
  type RuntimeReceipt,
  type RuntimeToolchain,
  verifyRuntime,
} from "../../tools/runtime_artifact.ts";

async function assertRejects(
  run: () => Promise<void>,
  text: string,
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert(
    caught instanceof Error && caught.message.includes(text),
    `expected ${text}; got ${String(caught)}`,
  );
}

async function fixture() {
  return {
    bytes: await Deno.readFile(
      new URL("../../generated/capnp_deno.wasm", import.meta.url),
    ),
    receipt: JSON.parse(
      await Deno.readTextFile(
        new URL("../../generated/capnp_deno.provenance.json", import.meta.url),
      ),
    ) as RuntimeReceipt,
    pin: JSON.parse(
      await Deno.readTextFile(
        new URL("../../tools/runtime-toolchain.json", import.meta.url),
      ),
    ) as RuntimeToolchain,
  };
}

Deno.test("runtime receipt verifies the shipped module and pinned ABI", async () => {
  const { bytes, receipt, pin } = await fixture();
  await verifyRuntime(bytes, receipt, pin);
  assertEquals(receipt.abi.version, 1);
  assertEquals(receipt.abi.features[0], 1023);
});

Deno.test("runtime receipt rejects damaged bytes before WASM compilation", async () => {
  const { bytes, receipt, pin } = await fixture();
  bytes[0] ^= 1;
  await assertRejects(
    () => verifyRuntime(bytes, receipt, pin),
    "integrity mismatch",
  );
});

Deno.test("runtime receipt rejects an unpinned producer revision", async () => {
  const { bytes, receipt, pin } = await fixture();
  receipt.toolchain.capnpZigCommit = "0".repeat(40);
  await assertRejects(
    () => verifyRuntime(bytes, receipt, pin),
    "pinned toolchain",
  );
});

Deno.test("runtime receipt detects incorrect ABI and export inventories", async () => {
  const { bytes, receipt, pin } = await fixture();
  receipt.abi.features[0] = 0;
  await assertRejects(
    () => verifyRuntime(bytes, receipt, pin),
    "ABI/export receipt",
  );
  receipt.abi.features[0] = 1023;
  receipt.exports.pop();
  await assertRejects(
    () => verifyRuntime(bytes, receipt, pin),
    "ABI/export receipt",
  );
});
