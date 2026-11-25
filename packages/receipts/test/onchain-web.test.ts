import { encodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import {
  EVM_RPC,
  askContract,
  encodeIsAnchorRecorded,
  withOneDigitChanged,
  type AnchorCallArgs,
} from "../../../apps/web/onchain.js";
import { vigilReceiptsAbi } from "../src/abi.js";

// The web app's "Verify on chain" encodes the call by hand (no bundler, no dependency).
// It must produce exactly what viem produces from the contract's ABI.
const call: AnchorCallArgs = {
  signer: "0x7f806b5bf878a7b89d7f7d0b4ec3a517a38d15c7",
  chainId: "qorechain-diana",
  layerId: "vigil-1",
  layerHeight: "18",
  stateRoot: "0x953c2d1a437e5b8593770086f32ce474dee36dbc305d48f8e0ccfe473a281c90",
  validatorSetHash: "0x",
  txCount: "1",
};

const viem = (c: AnchorCallArgs) =>
  encodeFunctionData({
    abi: vigilReceiptsAbi,
    functionName: "isAnchorRecorded",
    args: [
      c.signer as `0x${string}`,
      {
        chainId: c.chainId,
        layerId: c.layerId,
        layerHeight: BigInt(c.layerHeight),
        stateRoot: c.stateRoot as `0x${string}`,
        validatorSetHash: c.validatorSetHash as `0x${string}`,
        txCount: BigInt(c.txCount),
      },
    ],
  });

const answer = (result: unknown, ok = true) =>
  (() =>
    Promise.resolve(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(result as object) }), {
        status: ok ? 200 : 502,
      }),
    )) as unknown as typeof fetch;

describe("web Verify on chain", () => {
  it("encodes isAnchorRecorded exactly as viem does", () => {
    expect(encodeIsAnchorRecorded(call)).toBe(viem(call));
    const long = {
      ...call,
      chainId: "a-chain-identifier-longer-than-one-32-byte-word",
      layerId: "x",
      layerHeight: (2n ** 63n).toString(),
      validatorSetHash: "0x" + "ab".repeat(33),
      txCount: "7",
    };
    expect(encodeIsAnchorRecorded(long)).toBe(viem(long));
  });

  it("changes exactly one digit of the state root", () => {
    const changed = withOneDigitChanged(call);
    expect(changed.stateRoot).not.toBe(call.stateRoot);
    expect(changed.stateRoot.slice(0, -1)).toBe(call.stateRoot.slice(0, -1));
    expect(withOneDigitChanged({ ...call, stateRoot: "0x" + "1".repeat(63) + "0" }).stateRoot).toBe(
      "0x" + "1".repeat(64),
    );
  });

  it("sends eth_call to the public EVM endpoint and reads the boolean", async () => {
    let sent: { url: string; body: string } | undefined;
    const fetchImpl = ((url: string, init: { body: string }) => {
      sent = { url, body: init.body };
      return Promise.resolve(
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + "1".padStart(64, "0") }),
        ),
      );
    }) as unknown as typeof fetch;
    await expect(
      askContract("0xced683ad4319a34873e2c1aa90d18e2fcf1af1d1", call, fetchImpl),
    ).resolves.toBe(true);
    expect(sent?.url).toBe(EVM_RPC);
    expect(JSON.parse(sent?.body ?? "{}")).toMatchObject({
      method: "eth_call",
      params: [{ to: "0xced683ad4319a34873e2c1aa90d18e2fcf1af1d1", data: viem(call) }, "latest"],
    });
    await expect(askContract("0x1", call, answer({ result: "0x" + "0".repeat(64) }))).resolves.toBe(
      false,
    );
  });

  it("reports a failed call instead of an answer", async () => {
    await expect(askContract("0x1", call, answer({}, false))).rejects.toThrow("HTTP 502");
    await expect(
      askContract("0x1", call, answer({ error: { message: "execution reverted" } })),
    ).rejects.toThrow("execution reverted");
    await expect(askContract("0x1", call, answer({ result: "0x01" }))).rejects.toThrow(
      "unexpected answer",
    );
  });
});
