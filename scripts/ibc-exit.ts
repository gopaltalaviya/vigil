/**
 * IBC exit: QOR that was withdrawn from the rollup leaves QoreChain for Osmosis
 * testnet over ICS-20 and the testnet's existing relayer (QORel). It sends to
 * the operator's own address on Osmosis (same key, `osmo` prefix), then waits
 * for the relayer's acknowledgement and reads the balance on Osmosis.
 *
 *   pnpm ibc-exit --check     # read-only: channel, client, pending packets, receiver
 *   pnpm ibc-exit 0.5         # send 0.5 QOR and follow it to Osmosis
 */
import { createHash } from "node:crypto";
import { bech32ToHex, hexToBech32, qorToUqor, signerFromEnv } from "@qorechain/rdk";
import { createChain, createLogger, loadConfig } from "@vigil/core";
import { broadcastFromMainAccount } from "@vigil/receipts";

const CHANNEL = "channel-1";
const COUNTERPARTY_CHAIN = "osmo-test-5";
const OSMOSIS_REST = "https://lcd.osmotest5.osmosis.zone";

const config = loadConfig();
const chain = createChain(config);
const context = { config, rdk: chain.rdk, log: createLogger({ service: "ibc", level: "warn" }) };
const get = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`);
  return (await response.json()) as T;
};
const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Preflight, read-only.
const channel = await get<{
  channel: { state: string; counterparty: { channel_id: string } };
}>(`${config.restUrl}/ibc/core/channel/v1/channels/${CHANNEL}/ports/transfer`);
const client = await get<{
  identified_client_state: {
    client_state: { chain_id: string; frozen_height?: { revision_height: string } };
  };
}>(`${config.restUrl}/ibc/core/channel/v1/channels/${CHANNEL}/ports/transfer/client_state`);
const pending = await get<{ pagination: { total: string } }>(
  `${config.restUrl}/ibc/core/channel/v1/channels/${CHANNEL}/ports/transfer/packet_commitments`,
);
const clientState = client.identified_client_state.client_state;
const remote = channel.channel.counterparty.channel_id;
const remoteChannel = await get<{ channel: { state: string } }>(
  `${OSMOSIS_REST}/ibc/core/channel/v1/channels/${remote}/ports/transfer`,
);
const signer = await signerFromEnv({
  QORE_MNEMONIC: config.secrets.mnemonic,
  QORE_PQC_SEED_HEX: config.secrets.pqcSeedHex,
});
const [account] = (await signer?.getAccounts()) ?? [];
if (account === undefined) throw new Error("QORE_MNEMONIC is not set");
const receiver = hexToBech32(bech32ToHex(account.address), "osmo");
const ibcDenom = `ibc/${createHash("sha256").update(`transfer/${remote}/uqor`).digest("hex").toUpperCase()}`;
const frozen = Number(clientState.frozen_height?.revision_height ?? "0") !== 0;

console.log(
  `Channel ${CHANNEL} -> ${COUNTERPARTY_CHAIN} ${remote}: ${channel.channel.state} here, ${remoteChannel.channel.state} there`,
);
console.log(
  `Client ${clientState.chain_id}${frozen ? " FROZEN" : ""}; packets waiting for the relayer: ${pending.pagination.total}`,
);
console.log(`Receiver ${receiver}, denom there ${ibcDenom}`);
const ready =
  channel.channel.state === "STATE_OPEN" &&
  remoteChannel.channel.state === "STATE_OPEN" &&
  clientState.chain_id === COUNTERPARTY_CHAIN &&
  !frozen;
if (!ready) throw new Error("the channel is not usable; nothing sent");
if (process.argv.includes("--check")) process.exit(0);

const amount = qorToUqor(process.argv[2] ?? "0.5");
const balanceThere = async (): Promise<bigint> => {
  const answer = await get<{ balance?: { amount: string } }>(
    `${OSMOSIS_REST}/cosmos/bank/v1beta1/balances/${receiver}/by_denom?denom=${encodeURIComponent(ibcDenom)}`,
  );
  return BigInt(answer.balance?.amount ?? "0");
};
const before = await balanceThere();

const hash = await broadcastFromMainAccount(context, "ibc-transfer", (from) => [
  {
    typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
    value: {
      sourcePort: "transfer",
      sourceChannel: CHANNEL,
      token: { denom: "uqor", amount },
      sender: from,
      receiver,
      timeoutHeight: { revisionNumber: 0n, revisionHeight: 0n },
      // 20 minutes; after that the transfer is refunded instead of delivered.
      timeoutTimestamp: BigInt(Date.now() + 20 * 60_000) * 1_000_000n,
      memo: "Vigil Watchtower: rollup withdrawal leaving over IBC",
    },
  },
]);
console.log(`Sent ${amount} uqor: ${hash}`);

let sequence: string | undefined;
for (let i = 0; i < 20 && sequence === undefined; i++) {
  try {
    const tx = await get<{
      tx_response: { events: { type: string; attributes: { key: string; value: string }[] }[] };
    }>(`${config.restUrl}/cosmos/tx/v1beta1/txs/${hash}`);
    sequence = tx.tx_response.events
      .find((e) => e.type === "send_packet")
      ?.attributes.find((a) => a.key === "packet_sequence")?.value;
  } catch {
    await sleep(3_000);
  }
}
if (sequence === undefined) throw new Error("the transfer has no send_packet event");
console.log(`Packet ${sequence} on ${CHANNEL}; waiting for the relayer…`);

const started = Date.now();
for (;;) {
  const query = `acknowledge_packet.packet_src_channel='${CHANNEL}' AND acknowledge_packet.packet_sequence='${sequence}'`;
  const acks = await get<{
    tx_responses?: { txhash: string; height: string; timestamp: string }[];
  }>(`${config.restUrl}/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(query)}`);
  const ack = acks.tx_responses?.[0];
  if (ack !== undefined) {
    const seconds = Math.round((Date.now() - started) / 1_000);
    console.log(
      `Acknowledged in ${ack.txhash} at height ${ack.height} (${String(seconds)} s after sending)`,
    );
    break;
  }
  if (Date.now() - started > 25 * 60_000) throw new Error("no acknowledgement within 25 minutes");
  await sleep(10_000);
}
const after = await balanceThere();
console.log(`Balance of ${receiver} on Osmosis: ${String(before)} -> ${String(after)} ${ibcDenom}`);
