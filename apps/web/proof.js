// The Proof page: every claim Vigil makes, with the testnet transactions that
// show it happened. Each hash links to the raw transaction on QoreChain's
// public API, so it can be checked without trusting this site.

const TX_API = "https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/";

export function proofView({ el, pill, overview }) {
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

  const card = ({ tone, status, title, story, outcome, steps, txs, live }) =>
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
      txs && txs.length > 0 ? el("ul", { className: "proof-txs" }, txs) : null,
    ]);

  return {
    title: "Proof",
    async load() {
      return overview();
    },
    render(data) {
      const s = data.rollup.summary;
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
          status: ["bad", "Found by audit"],
          title: "Our audit found a fraud on another rollup that nobody challenged",
          story:
            "Vigil re-executes every qledger-v1 rollup on the testnet from its first batch. Batch 12 of wicketgate-pay kept a correct state root but published a withdrawals root that re-execution does not produce. The chain's own fraud check, run locally on that batch, confirms it. The challenge window passed without a challenge and the batch became final.",
          outcome:
            "A 13 QOR withdrawal was paid out under that root. Vigil reports this and does nothing else: it has no code path that challenges a rollup it does not operate. See the Rollups page for the live audit of every rollup.",
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
            "A capability QoreChain did not have before: contracts can now ask whether a rollup batch truly settled.",
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
          tone: "primary",
          status: ["good", "Money out"],
          title: "A withdrawal was paid out from the rollup",
          story:
            "0.5 QOR withdrawn on the rollup was paid back on QoreChain once its batch was final, with a Merkle proof against the batch's withdrawals root.",
          outcome:
            "Funds really leave the rollup, and only through a batch that survived its challenge window.",
          txs: [
            tx(
              "Withdrawal claim, 0.5 QOR",
              "511A29444A436A13956E9A40D8199B40803EE79197C102A7FD6FBF7967833BE6",
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
