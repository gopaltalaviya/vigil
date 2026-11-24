/**
 * Red-team replay: real attacks against Vigil, each run against live testnet data
 * and refused by a named check, each with a control that the same check accepts.
 * Nothing is broadcast. EVM attacks are `eth_call`s; the double withdrawal is a
 * node simulation.
 *
 *   pnpm redteam          # no key needed; the double withdrawal is skipped
 *   pnpm redteam:full     # with .env: also simulates the double withdrawal
 *   pnpm redteam --json
 *
 * Exits 1 if any attack is accepted or any control is refused.
 */
import { decodeTxRaw, fromBase64, isQoreSignError } from "@qorechain/qoresign";
import { assertPqLayerMatchesRegisteredKey } from "@qorechain/qoresign/network";
import {
  bech32ToHex,
  decodeQledgerTx,
  executeWithdrawalMsg,
  qledgerWithdrawalProof,
  verifyQledgerTx,
} from "@qorechain/rdk";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  defineChain,
  http,
  type Hex,
} from "viem";
import {
  InboxArchive,
  Store,
  chainHistory,
  chainInboxSource,
  connectTxSender,
  createChain,
  ledgerAtSequence,
  loadConfig,
  toBatchClaim,
  toStoredBatch,
  verifyBatch,
  type BatchClaim,
} from "@vigil/core";
import { memoKeys, openMemo, sealMemo, transferHash } from "@vigil/memo";
import { ReceiptsContract, buildAnchorCall, vigilReceiptsAbi } from "@vigil/receipts";

const ROLLUP_ID = "vigil-1";
const RECEIPTS: Hex = "0xced683ad4319a34873e2c1aa90d18e2fcf1af1d1";
/** BIP-39's public test mnemonic: a throwaway recipient for the memo attacks. */
const THROWAWAY =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const config = loadConfig({ ...process.env, ROLLUP_ID, QORE_NETWORK: "testnet" });
const chain = createChain(config);
const contract = new ReceiptsContract(config);
const evm = createPublicClient({
  chain: defineChain({
    id: 9800,
    name: "QoreChain Testnet",
    nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
    rpcUrls: { default: { http: [config.evmRpcUrl] } },
  }),
  transport: http(config.evmRpcUrl),
});

interface Case {
  attack: string;
  check: string;
  /** What the check said about the attack. */
  attackResult: string;
  refused: boolean;
  /** What the same check said about the honest input. */
  controlResult: string;
  controlAccepted: boolean;
  skipped?: string;
}

/** The custom error a reverted call carries, by name. */
const revertName = (error: unknown): string => {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      return reverted.data?.errorName ?? reverted.reason ?? "reverted";
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
};

const flip = (bytes: Uint8Array, at: number): Uint8Array => {
  const copy = bytes.slice();
  copy[at] = (copy[at] ?? 0) ^ 0x01;
  return copy;
};
const flipHex = (hex: string): string =>
  `${hex.slice(0, -1)}${((parseInt(hex.slice(-1), 16) ^ 1) & 15).toString(16)}`;

// The rollup, rebuilt from the chain: every inbox entry checked against the accumulator.
const store = Store.open(":memory:");
const archive = new InboxArchive({
  chainId: config.chainId,
  rollupId: ROLLUP_ID,
  store,
  source: chainInboxSource(chain, config.chainId, ROLLUP_ID),
});
const synced = await archive.sync();
const rollup = await chain.rdk.rest.getRollup(ROLLUP_ID);
const batches = (await chain.rdk.rest.listBatches(ROLLUP_ID)).map(toStoredBatch);
const judge = (claim: BatchClaim) =>
  verifyBatch(claim, {
    chainId: config.chainId,
    rollupId: ROLLUP_ID,
    parent: ledgerAtSequence(
      { chainId: config.chainId, rollupId: ROLLUP_ID, store, archive },
      claim.inboxStart,
    ),
    entries: archive.range(claim.inboxStart, claim.inboxEnd),
    accFrom: archive.accAt(claim.inboxStart),
    accTo: archive.accAt(claim.inboxEnd),
  });
const byIndex = (index: number) => {
  const batch = batches.find((b) => b.batchIndex === index);
  if (batch === undefined) throw new Error(`batch ${String(index)} is not on chain`);
  return toBatchClaim(batch);
};
const verdictText = (claim: BatchClaim) => {
  const v = judge(claim);
  return {
    valid: v.verdict === "valid",
    text: v.verdict === "valid" ? "valid" : `invalid: ${v.reasons.join(", ")}`,
  };
};

const cases: Case[] = [];

// 1. Forged state root: the batch would let its submitter withdraw money that does not exist.
{
  const honest = byIndex(29);
  const control = verdictText(honest);
  const forged = verdictText({ ...honest, stateRoot: flipHex(honest.stateRoot) });
  cases.push({
    attack: "Forged state root (batch 29, one bit changed)",
    check: "Watchtower re-execution, verifyBatch",
    attackResult: forged.text,
    refused: !forged.valid,
    controlResult: control.text,
    controlAccepted: control.valid,
  });
}

// 2. Forged withdrawals root only, state root untouched: the class that paid out on wicketgate-pay batch 12.
{
  const withWithdrawals = batches.find((b) => b.withdrawalsRoot !== "" && b.status === "finalized");
  if (withWithdrawals === undefined) throw new Error("no batch with withdrawals");
  const honest = toBatchClaim(withWithdrawals);
  const control = verdictText(honest);
  const forged = verdictText({ ...honest, withdrawalsRoot: flipHex(honest.withdrawalsRoot) });
  cases.push({
    attack: `Forged withdrawals root only (batch ${String(honest.batchIndex)})`,
    check: "Watchtower re-execution, verifyBatch",
    attackResult: forged.text,
    refused: !forged.valid,
    controlResult: control.text,
    controlAccepted: control.valid,
  });
}

// 3. A forged L2 transfer: someone else's signed transfer with one byte of the signature changed.
{
  const entry = archive.range(0, synced.head).find((e) => decodeQledgerTx(e.payload) !== undefined);
  if (entry === undefined) throw new Error("no L2 transaction in the inbox");
  const honest = decodeQledgerTx(entry.payload);
  const forged = decodeQledgerTx(flip(entry.payload, entry.payload.length - 1));
  const ok = (tx: typeof honest) =>
    tx !== undefined && verifyQledgerTx(tx, config.chainId, ROLLUP_ID);
  cases.push({
    attack: "L2 transaction with a changed ML-DSA-44 signature byte",
    check: "verifyQledgerTx (the ledger skips it)",
    attackResult: ok(forged) ? "accepted" : "signature invalid",
    refused: !ok(forged),
    controlResult: ok(honest) ? "signature valid" : "refused",
    controlAccepted: ok(honest),
  });
}

// 4-6. Settlement receipts, against the live VigilReceipts contract with eth_call.
const call0 = await buildAnchorCall(chain.rdk, config.chainId, ROLLUP_ID, 0);
const deployer: Hex = "0x32a41108d00b8a4fd0bc720c492cd331f1fcde6e";
{
  let attackResult: string;
  try {
    await evm.simulateContract({
      account: deployer,
      address: RECEIPTS,
      abi: vigilReceiptsAbi,
      functionName: "recordAnchor",
      args: [call0.signer, call0.receipt, call0.signature],
    });
    attackResult = "accepted";
  } catch (error) {
    attackResult = revertName(error);
  }
  const control = await contract.checkAnchor(RECEIPTS, call0);
  cases.push({
    attack: "Replay batch 0's recorded receipt (recordAnchor again)",
    check: "VigilReceipts: one record per signer and message",
    attackResult,
    refused: attackResult !== "accepted",
    controlResult: control ? "signature valid (checkAnchor)" : "refused",
    controlAccepted: control,
  });
}
{
  // The creator's real signature, presented as another registered account's.
  const asOther = await contract.checkAnchor(RECEIPTS, { ...call0, signer: deployer });
  const control = await contract.checkAnchor(RECEIPTS, call0);
  cases.push({
    attack: "Batch 0's anchor claimed for another registered signer",
    check: "VigilReceipts: pqcVerify against that signer's registered key",
    attackResult: asOther ? "accepted" : "signature invalid",
    refused: !asOther,
    controlResult: control ? "valid for the rollup creator" : "refused",
    controlAccepted: control,
  });
}
{
  const unregistered: Hex = "0x000000000000000000000000000000000000dead";
  let attackResult: string;
  try {
    attackResult = (await contract.checkAnchor(RECEIPTS, { ...call0, signer: unregistered }))
      ? "accepted"
      : "signature invalid";
  } catch (error) {
    attackResult = revertName(error);
  }
  const control = await contract.checkAnchor(RECEIPTS, call0);
  cases.push({
    attack: "Anchor for a signer with no registered ML-DSA-87 key",
    check: "VigilReceipts: pqcKeyStatus",
    attackResult,
    refused: attackResult !== "accepted",
    controlResult: control ? "registered and valid" : "refused",
    controlAccepted: control,
  });
}

// 7. A batch transaction whose body was changed after signing.
{
  const batch0 = batches.find((b) => b.batchIndex === 0);
  if (batch0 === undefined) throw new Error("batch 0 is not on chain");
  const search = await fetch(
    `${config.rpcUrl}/tx_search?query=${encodeURIComponent(`"batch_submitted.rollup_id='${ROLLUP_ID}' AND batch_submitted.batch_index='0'"`)}`,
  );
  const found = (await search.json()) as { result: { txs: { tx: string; height: string }[] } };
  const raw = found.result.txs.find((t) => Number(t.height) === batch0.submittedAt);
  if (raw === undefined) throw new Error("batch 0's transaction was not found");
  const parts = decodeTxRaw(fromBase64(raw.tx));
  /** QoreSign throws PQ_SIGNATURE_INVALID for a layer that does not verify. */
  const verify = async (
    bodyBytes: Uint8Array,
  ): Promise<{ valid: boolean; reason?: string; signBytesVersion?: string }> => {
    try {
      return await assertPqLayerMatchesRegisteredKey({
        rest: config.restUrl,
        chainId: config.chainId,
        signer: rollup.creator,
        bodyBytes,
        authInfoBytes: parts.authInfoBytes,
      });
    } catch (error) {
      if (isQoreSignError(error)) return { valid: false, reason: error.code };
      throw error;
    }
  };
  const control = await verify(parts.bodyBytes);
  const tampered = await verify(flip(parts.bodyBytes, parts.bodyBytes.length - 1));
  cases.push({
    attack: "Batch 0's submission with one body byte changed",
    check: "QoreSign: ML-DSA-87 layer against the registered key",
    attackResult: tampered.valid ? "accepted" : `refused (${tampered.reason ?? "invalid"})`,
    refused: !tampered.valid,
    controlResult: control.valid ? `valid (${control.signBytesVersion ?? ""})` : "refused",
    controlAccepted: control.valid,
  });
}

// 8-9. Sealed memos, with a throwaway recipient: a changed ciphertext, and a memo moved to another transfer.
{
  const keys = memoKeys(THROWAWAY);
  const boundTo = transferHash(new TextEncoder().encode("transfer 1"));
  const payload = sealMemo({
    chainId: config.chainId,
    rollupId: ROLLUP_ID,
    recipientKey: keys.mlkemPublicKey,
    boundTo,
    text: "invoice 42",
  });
  const open = (p: Uint8Array) =>
    openMemo({ chainId: config.chainId, rollupId: ROLLUP_ID, keys, payload: p });
  const control = open(payload);
  const tampered = open(flip(payload, payload.length - 1));
  cases.push({
    attack: "Sealed memo with one ciphertext byte changed",
    check: "QoreSeal: ML-KEM-1024 envelope, authenticated decryption",
    attackResult: tampered === undefined ? "refused" : "opened",
    refused: tampered === undefined,
    controlResult: control?.text === "invoice 42" ? "opened: invoice 42" : "refused",
    controlAccepted: control?.text === "invoice 42",
  });
  const moved = payload.slice();
  moved.set(transferHash(new TextEncoder().encode("transfer 2")), 5);
  const rebound = open(moved);
  cases.push({
    attack: "Sealed memo moved to another transfer",
    check: "QoreSeal: the transfer hash is the envelope's associated data",
    attackResult: rebound === undefined ? "refused" : "opened",
    refused: rebound === undefined,
    controlResult: control?.text === "invoice 42" ? "opened on its own transfer" : "refused",
    controlAccepted: control?.text === "invoice 42",
  });
}

// 10. Double withdrawal: claim a withdrawal the chain already paid. Needs a key to simulate.
{
  const [paid] = await chainHistory(chain.rest, config.restUrl, ROLLUP_ID).withdrawals();
  if (config.secrets.mnemonic === undefined || paid === undefined) {
    cases.push({
      attack: "Claim an already paid withdrawal again",
      check: "QoreChain RDK: each withdrawal index pays once",
      attackResult: "",
      refused: true,
      controlResult: "",
      controlAccepted: true,
      skipped: "needs QORE_MNEMONIC to simulate (pnpm redteam:full)",
    });
  } else {
    const verdict = judge(byIndex(paid.batchIndex));
    const position = verdict.withdrawals.findIndex((w) => Number(w.index) === paid.withdrawalIndex);
    const proof = qledgerWithdrawalProof(config.chainId, ROLLUP_ID, verdict.withdrawals, position);
    const sender = await connectTxSender(config, chain.rdk);
    let attackResult: string;
    try {
      await sender.simulate([
        executeWithdrawalMsg({
          submitter: sender.address,
          rollupId: ROLLUP_ID,
          batchIndex: paid.batchIndex,
          withdrawalIndex: paid.withdrawalIndex,
          recipient: paid.recipient,
          denom: "uqor",
          amount: paid.amountUqor,
          proof,
        }),
      ]);
      attackResult = "accepted";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The node's own reason, without the gRPC wrapping.
      attackResult = (/message index: \d+: (.*?)(?: \[|$)/.exec(message)?.[1] ?? message).slice(
        0,
        160,
      );
    }
    cases.push({
      attack: `Claim batch ${String(paid.batchIndex)} withdrawal #${String(paid.withdrawalIndex)} again`,
      check: "QoreChain RDK: each withdrawal index pays once",
      attackResult,
      refused: attackResult !== "accepted",
      controlResult:
        position >= 0
          ? `proof rebuilt from the batch (paid in ${paid.txHash.slice(0, 10)}…)`
          : "not found",
      controlAccepted: position >= 0,
    });
  }
}
store.close();

const failures = cases.filter((c) => c.skipped === undefined && (!c.refused || !c.controlAccepted));
if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      { rollupCreator: bech32ToHex(rollup.creator), cases, failures: failures.length },
      null,
      2,
    ),
  );
} else {
  for (const c of cases) {
    const mark =
      c.skipped !== undefined ? "skip" : c.refused && c.controlAccepted ? "ok  " : "FAIL";
    console.log(`${mark}  ${c.attack}`);
    console.log(`      check:   ${c.check}`);
    if (c.skipped !== undefined) {
      console.log(`      skipped: ${c.skipped}`);
      continue;
    }
    console.log(`      attack:  ${c.attackResult}`);
    console.log(`      control: ${c.controlResult}`);
  }
  const run = cases.filter((c) => c.skipped === undefined).length;
  console.log(
    `\n${String(run - failures.length)} of ${String(run)} attacks refused with a passing control.`,
  );
}
process.exit(failures.length === 0 ? 0 : 1);
