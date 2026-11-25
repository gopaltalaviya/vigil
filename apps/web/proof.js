// The Proof page: every claim Vigil makes, with the testnet transactions that
// show it happened. Each hash links to the raw transaction on QoreChain's
// public API, so it can be checked without trusting this site.

const TX_API = "https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/";

export function proofView({ el, pill, overview, verifyPanel }) {
  const tx = (label, hash, evm = false) =>
    el("li", { className: "proof-tx" }, [
      el("span", { className: "proof-tx-label", text: label }),
      evm
        ? el("code", { text: `${hash.slice(0, 14)}…${hash.slice(-8)}`, title: hash })
        : el(
            "a",
            {
              href: `${TX_API}${hash}`,
              target: "_blank",
              rel: "noopener noreferrer",
              title: `Open transaction ${hash} on the QoreChain testnet API`,
            },
            [
              el("code", { text: `${hash.slice(0, 10)}…${hash.slice(-6)}` }),
              el("span", { className: "ext", text: "verify ↗" }),
            ],
          ),
    ]);

  const card = ({ tone, status, title, story, outcome, steps, txs, live, source, extra }) =>
    el("article", { className: `proof-card tone-${tone}` }, [
      el("div", { className: "proof-top" }, [
        pill(status[0], status[1]),
        live ? el("span", { className: "proof-live", text: "live" }) : null,
      ]),
      el("h2", { text: title }),
      el("p", { className: "proof-story", text: story }),
      steps
        ? el(
            "ol",
            { className: "proof-steps" },
            steps.map(([time, text]) =>
              el("li", {}, [
                el("span", { className: "ba-time", text: time }),
                el("span", { text }),
              ]),
            ),
          )
        : null,
      el("p", { className: "proof-outcome" }, [el("strong", { text: "Result: " }), outcome]),
      source
        ? el("p", { className: "proof-source" }, [
            el("a", {
              href: source[1],
              target: "_blank",
              rel: "noopener noreferrer",
              text: `${source[0]} ↗`,
            }),
          ])
        : null,
      txs && txs.length > 0 ? el("ul", { className: "proof-txs" }, txs) : null,
      extra ?? null,
    ]);

  return {
    title: "Proof",
    async load() {
      return overview();
    },
    render(data) {
      const s = data.rollup.summary;
      const recorded = data.rollup.batches.filter((b) => b.receipt?.anchorCall);
      const latest = recorded.reduce(
        (top, b) => (top === null || b.index > top.index ? b : top),
        null,
      );
      const latestCall = latest ? { batch: latest, call: latest.receipt.anchorCall } : null;
      const mainnet = data.chain.find((c) => c.network === "mainnet");
      const blockTime = mainnet?.tip?.measuredBlockTimeSecs;
      const rejected = data.rollup.batches.filter(
        (b) => b.verdict === "invalid" && b.status === "rejected",
      ).length;

      const cases = [
        {
          tone: "primary",
          status: ["good", "Fraud stopped by Vigil"],
          title: "Our watchtower caught a forged batch and got the cheater fined",
          story:
            "A throwaway account bonded 1,000 QOR as a submitter and posted batch 18 of vigil-1 with a forged state root, the kind of batch that would let a cheater withdraw money that does not exist. QoreChain accepted it, as it accepts every batch.",
          steps: [
            ["11:36:56", "Forged batch 18 lands on QoreChain (height 10,252,827)."],
            [
              "11:36:58",
              "Vigil's watchtower re-executes it: wrong state root. Critical alert raised.",
            ],
            ["11:37:01", "Vigil's watchtower sends the fraud proof (height 10,252,830)."],
            ["11:37:01", "QoreChain re-executes, upholds the fraud and throws the batch out."],
          ],
          outcome:
            "Stopped 5 seconds after it was submitted. The cheater's 1,000 QOR bond was slashed: 500 QOR burned, 500 QOR paid to Vigil's watchtower as the reward. The honest batch replaced it.",
          txs: [
            tx("Forged batch", "E6993DBCAE77E735D138E03748A09321899525BAF24C464BEE360C2A9C02BDB4"),
            tx(
              "Vigil's challenge (fraud upheld)",
              "349C8DF05F888E2AEB8826101F49FD8960EB3662A47530B37C71307206822330",
            ),
            tx(
              "Cheater's 1,000 QOR bond",
              "75CF85AF9C1808109CD221202E2E302793395C9E8BE3F2BE087D414ECBDC4EC0",
            ),
          ],
        },
        {
          tone: "primary",
          status: ["good", "Checked independently"],
          title: "Every batch transaction is checked for a real post-quantum signature",
          live: true,
          story:
            "Vigil does not take the chain's word for it. QoreSign reads each batch transaction and verifies its ML-DSA layer, and the ML-DSA-87 signature on each settlement anchor is verified off chain with @qorechain/pqc. Results are stored when checked, because a signer's key can rotate later.",
          outcome: `${s.pqVerified ?? 0} of ${s.pqChecked ?? 0} checked batch transactions carry a valid ML-DSA signature, and ${s.anchorsVerified ?? 0} settlement anchors verify off chain.`,
          txs: [],
        },
        {
          tone: "warn",
          status: ["wait", "Missed, then fixed"],
          title: "A real attacker forged our batch 29 while our watchtower was offline",
          story:
            "On 18 November an outside account posted two forged versions of vigil-1 batch 29. Each carried the correct state root and a forged withdrawals root. Our watchtower's host was asleep, so it saw neither. Two other teams' watchers challenged them.",
          steps: [
            ["21:41:56", "First forgery lands (height 10,338,740)."],
            ["21:42:06", "Another watcher's fraud proof is upheld (height 10,338,747)."],
            ["22:01:42", "Second forgery lands (height 10,339,572)."],
            ["22:01:56", "A different watcher's fraud proof is upheld (height 10,339,582)."],
          ],
          outcome:
            "The attacker lost 2,000 QOR in bonds. We did not catch this one live. The watchtower now rebuilds this history from chain events on every start, re-executes each rejected claim, names the challenger and raises a missed-while-offline alert.",
          txs: [
            tx("First forgery", "9C99378232BDEAF92ED44D109236D39DA2B693CAD5122572F577E6A734C44DDE"),
            tx(
              "First fraud proof (another team)",
              "07E8CBDCBC4642C5B3752CAECF229620D11C5184246B81BEC76860F29DE8B080",
            ),
            tx(
              "Second forgery",
              "3DB238B4F64AE89A0A8200781FE72D1D671E9D96902EC6698275A166D0B6A2E0",
            ),
            tx(
              "Second fraud proof (another team)",
              "A4D6ADC6086DE183B70DE4C4F404D8ABF61D284D581D241AA9FAC9F17581BF72",
            ),
            tx(
              "Honest batch 29",
              "C84025D3BFD559F6DB4C7F567C5BE00082ADBDA741A0C5A1B2710BD423ED9FE2",
            ),
          ],
        },
        {
          tone: "warn",
          status: ["bad", "Mismatch, finalised"],
          title: "A withdrawals-root mismatch on another rollup, reproduced independently",
          story:
            "Vigil Watchtower re-executes every qledger-v1 rollup on the testnet from public chain data. For batch 12 of wicketgate-pay, re-execution reproduces the batch's state root but not its withdrawals root. The rollup's own team reports the same mismatch in their published proof log. The batch is final on chain.",
          outcome:
            "A 13 QOR withdrawal was executed under that batch. Vigil reports the mismatch and does nothing else: it has no code path that challenges a rollup it does not operate. The Rollups page shows the live audit of every rollup.",
          source: [
            "The wicketgate-pay team's own report (PROOF.md)",
            "https://github.com/timix648/wicketgate/blob/main/PROOF.md",
          ],
          txs: [
            tx(
              "13 QOR payout from batch 12",
              "876EACEBC074CFF1363F82A59DF02DFB779C93CA335CCF5E03C29492CF65A65E",
            ),
          ],
        },
        {
          tone: "warn",
          status: ["wait", "Why it matters"],
          title: "The chain alone does not stop fraud: someone has to prove it",
          story:
            "In an earlier drill, before our watchtower was running, the same kind of forged batch (batch 1) was posted. QoreChain accepted it without question. It was rejected only because another watcher on the testnet happened to send a fraud proof.",
          outcome:
            "Batch 1 was thrown out 10 blocks later and the cheater's bond slashed. Without any watcher, it would have become final an hour later. This is the gap Vigil closes.",
          txs: [
            tx(
              "Forged batch 1",
              "E5F81D8132AF395E1EEDE9B50FC66FFD7013310EE7BAC7A0675CE3FB0DC3FEC9",
            ),
            tx(
              "Challenge by another watcher",
              "D5D739743AEBB1FCA1148D5775DD67CF39FF669D4F3AFBFE2945700CFB0ED9A4",
            ),
          ],
        },
        {
          tone: "violet",
          status: ["good", "Every batch checked"],
          live: true,
          title: `${s.batches} batches submitted, every one re-executed`,
          story:
            "Each batch of vigil-1 carries an ML-DSA-87 post-quantum anchor signature. The watchtower re-executes every one from its own verified copy of the inbox and compares the results.",
          outcome: `${s.valid} judged valid and ${s.invalid} judged invalid; ${rejected} of the invalid ones ${rejected === 1 ? "was" : "were"} rejected by the chain after a challenge. ${s.finalized} batches are final. No honest batch was ever flagged.`,
          txs: [
            tx(
              "Batch 0, ML-DSA-87 anchored",
              "B15BF4B9BACA1DE7ED0E290C8BD9D409AF11A8207D38FD5481066C047092E70E",
            ),
          ],
        },
        {
          tone: "info",
          status: ["good", "On-chain receipts"],
          live: true,
          title: `${s.receiptsRecorded} settlements verified and recorded by a contract`,
          story:
            "VigilReceipts checks each final batch's ML-DSA-87 signature on chain, against the signer's key in QoreChain's registry, so any contract can rely on the settlement.",
          outcome:
            "Any contract can ask whether a rollup batch truly settled. So can your browser: the button below asks the contract directly, for the latest recorded batch.",
          extra: latestCall
            ? el("div", { className: "onchain-box" }, [
                el("h3", { text: `Check batch ${latestCall.batch.index} yourself` }),
                verifyPanel({ el, pill }, latestCall.batch.receipt.contract, latestCall.call),
              ])
            : null,
          txs: [
            tx(
              "Contract deployed",
              "0x23e434f38211df166fad1b29ee4e3d80c1853161e012d867be14067ab5596f23",
              true,
            ),
            tx(
              "Receipt for batch 0",
              "0xa4e7838ccc9e11bb03d7650a53579aa99e34f3c7a67177b322f6dfe0cc7b1855",
              true,
            ),
          ],
        },
        {
          tone: "info",
          status: ["good", "Contract relies on it"],
          title: "A contract paid out only after a batch had settled and was re-executed",
          story:
            "SettlementGate, an escrow made with create-qorechain-dapp, locked 0.1 QOR until batch 29 of vigil-1 had a recorded receipt. Asked with a forged state root, it said no; asked with the batch's real anchor, it said yes. Version 2 also requires the watchtower's ML-DSA-87 attestation of the same batch: on batch 26 it said no with the real anchor and an unrecorded attestation, and yes with both recorded.",
          outcome:
            "Each version released 0.1 QOR to the payee. Any contract can gate money on a rollup batch's ML-DSA-87 settlement, and on an independent re-execution of it, the same way.",
          txs: [
            tx(
              "SettlementGate deployed",
              "0xd1e0f1d15dd80ab5090388e76d3d67c55eee00d1f86dc34fbf16068464fb1202",
              true,
            ),
            tx(
              "0.1 QOR locked on batch 29",
              "0xfbc44efd07656a3f52d51f7e48582306f9af804dab724a557b008fbccae2a249",
              true,
            ),
            tx(
              "Released to the payee",
              "0xc80015952bc57f2d48e4cee4034ba2415485ee482d35980cae389463a2f7eb70",
              true,
            ),
            tx(
              "Version 2 deployed",
              "0x958204fcc2d2049d1260957ad9f4a92af89f5544a93e4098fab05afceda76264",
              true,
            ),
            tx(
              "0.1 QOR locked on batch 26",
              "0x83dc35cb3ba32816b863a50fe660912a8d415f97653b878fe959537d6e9ad9f8",
              true,
            ),
            tx(
              "Released with anchor and attestation",
              "0x1610167f21848b3b814834e04a8199e5d357e791bb969657b3633d832caa109f",
              true,
            ),
          ],
        },
        {
          tone: "primary",
          status: ["good", "Money out"],
          title: "Withdrawals were paid out from the rollup",
          story:
            "Money withdrawn on the rollup was paid back on QoreChain once its batch was final, each payout with a Merkle proof against the batch's withdrawals root. Eight of the nine withdrawals in final batches are paid, 2.85 QOR in all; one of them was another team's exit through vigil-1.",
          outcome:
            "Funds really leave the rollup, and only through a batch that survived its challenge window.",
          txs: [
            tx(
              "Withdrawal claim, 0.5 QOR",
              "511A29444A436A13956E9A40D8199B40803EE79197C102A7FD6FBF7967833BE6",
            ),
            tx(
              "Withdrawal claim, 0.3 QOR (batch 3)",
              "EF08E2F0A81C1DC9A8A35770577DFFB2CAF958C3EF80EA5047177CDD5FEE8617",
            ),
          ],
        },
        {
          tone: "info",
          status: ["good", "Interop"],
          title: "Money withdrawn from the rollup left QoreChain for Osmosis",
          story:
            "0.5 QOR, withdrawn from vigil-1 to the operator's account, was sent over IBC (ICS-20, channel-1) to the operator's own address on Osmosis testnet. QoreChain's relayer delivered it and the acknowledgement came back 21 seconds later.",
          outcome:
            "The Osmosis balance went from 0 to 0.5 QOR as an IBC token. Funds can leave the rollup and then leave QoreChain.",
          txs: [
            tx(
              "IBC transfer, 0.5 QOR",
              "471BDAC775B1A4A2766BCFF8CDC6B1970CF7D4C67865ED6B5471439871BC6CD5",
            ),
            tx(
              "Relayer's acknowledgement",
              "54F9AE440FFE9BE6C0998AE62D802E3C0CD450D08CABCAE781F7716CB0293E24",
            ),
          ],
        },
        {
          tone: "primary",
          status: ["good", "Used by others"],
          title: "Another team's protocol paid an instant exit from vigil-1",
          story:
            "Wicketgate, another fest team's exit protocol, deposited 4 QOR into vigil-1 and posted a transfer and a 2 QOR withdrawal. Vigil's batcher included them in batch 28; Wicketgate's watchers re-executed it and paid the exit before the batch was final.",
          outcome:
            "vigil-1 is open to anyone and its history is checkable by others. The 2 QOR withdrawal was later paid out on chain.",
          txs: [
            tx(
              "Wicketgate's deposit, 4 QOR",
              "178DA6D9ECDFD389A84D7E2DBA58DF62A30736104898139C293B011762921527",
            ),
            tx(
              "Wicketgate's withdrawal post",
              "480B66366A148320444647A36C781A23379BB829AED726327D7A0AF4F481AA85",
            ),
          ],
        },
        {
          tone: "info",
          status: ["good", "Least privilege"],
          title: "The receipts key can do nothing but record receipts",
          story:
            "Record calls are signed by a hot key linked to a QoreChain smart account with one spending rule: only recordAnchor and recordAttestation on VigilReceipts, no value, for 14 days. When that key is not ready, an EVM window that can reach only this contract is used instead.",
          outcome:
            "A stolen receipts key could record a receipt and nothing else. The attestations of batches 26 and 27 were recorded through each lane.",
          txs: [
            tx(
              "Scoped EVM window",
              "87F3D1C1BFD5B80CDB016E3E2CE1081B5D1CE69143E695C4184E4F569D1C0C93",
            ),
            tx(
              "Attestation of batch 27 (window)",
              "0xaefc88412dccc090f52167a8f25669e14a620dfac61712d2c6200404c8e62c6d",
              true,
            ),
            tx(
              "Hot key linked to the smart account",
              "FF2A147287FEDCC422209A01B0EDFC752CAE82B427DD9A3EF33D7EF1C6B8E82E",
            ),
            tx(
              "Attestation of batch 26 (smart account)",
              "6C37DDE1DFAF4BBA539A11093B86829D8978CBC96C7387F1BD4B2F47C0CF018C",
            ),
          ],
        },
        {
          tone: "pink",
          status: ["good", "Private"],
          title: "A payment note only the recipient could read",
          story:
            "The recipient published an ML-KEM-1024 key. A transfer carried a sealed memo; the chain stores only ciphertext, and the recipient decrypted it.",
          outcome:
            "The amount stays public; the note is private, and protected against future quantum computers.",
          txs: [
            tx(
              "Recipient's ML-KEM-1024 key",
              "9409BE3284B456530AE1EDBA7622D04AB1D6B12A6D7C28835FE6000D36FD4CBC",
            ),
            tx("Sealed memo", "1D39B55A28FDD65478B4769200156D5785449DA02B33C751D0A067E125BCA674"),
          ],
        },
        {
          tone: "warn",
          status: ["wait", "Chain monitor"],
          live: true,
          title: "QoreChain mainnet is slower than documented",
          story:
            "The monitor measures block production on QoreChain itself and compares it with the published value of 3.1 seconds per block.",
          outcome:
            blockTime === undefined
              ? "Measurement not available right now; see Base chain."
              : `Mainnet measured at ${blockTime.toFixed(2)} s per block right now, against the documented 3.1 s.`,
          txs: [],
        },
      ];

      return el("div", { className: "stack" }, [
        el("div", { className: "page-head" }, [
          el("h1", { text: "Proof" }),
          el("p", {
            text: "Every claim on this site, with the QoreChain testnet transactions that show it happened. Open any hash: it is the chain's own record, not ours.",
          }),
        ]),
        el("div", { className: "proof-grid" }, cases.map(card)),
        el("p", {
          className: "muted",
          text: "Hashes starting with 0x are EVM transactions on chain 9800; the others open QoreChain's public REST API. Times are UTC, November 2026.",
        }),
      ]);
    },
  };
}
