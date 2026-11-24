// The Learn section: what Vigil is and how it works, in plain language.
// Static content; every value is written as text, never as markup.

const PAGES = [
  ["concept", "Concept"],
  ["how-it-works", "How it works"],
  ["use-cases", "Use cases"],
  ["before-after", "Before and after"],
  ["security", "Security"],
  ["post-quantum", "Post-quantum"],
  ["glossary", "Glossary"],
  ["faq", "FAQ"],
];

const SVG = "http://www.w3.org/2000/svg";

function svg(tag, attributes = {}, children = []) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  for (const child of children) node.append(child);
  return node;
}

/** The settlement path as an animated diagram. Stages light up in order; paths carry a moving dash. */
export function diagram() {
  const nodes = [
    { id: "users", x: 0, y: 140, label: "Users", sub: "sign with ML-DSA-44", tone: "info" },
    { id: "inbox", x: 225, y: 140, label: "Inbox", sub: "on QoreChain", tone: "info" },
    { id: "batcher", x: 450, y: 30, label: "Batcher", sub: "bonded submitter", tone: "violet" },
    {
      id: "chain",
      x: 675,
      y: 140,
      label: "QoreChain",
      sub: "ML-DSA-87 anchored",
      tone: "violet",
    },
    {
      id: "watch",
      x: 450,
      y: 250,
      label: "Watchtower",
      sub: "re-executes every batch",
      tone: "primary",
    },
    {
      id: "final",
      x: 890,
      y: 30,
      label: "Final",
      sub: "after 1 hour, unchallenged",
      tone: "primary",
    },
    { id: "receipt", x: 890, y: 250, label: "Receipt", sub: "verified on chain", tone: "pink" },
  ];
  const at = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const W = 170;
  const H = 64;
  const mid = (n, side) =>
    side === "r"
      ? [n.x + W, n.y + H / 2]
      : side === "l"
        ? [n.x, n.y + H / 2]
        : side === "t"
          ? [n.x + W / 2, n.y]
          : [n.x + W / 2, n.y + H];
  const links = [
    ["users", "r", "inbox", "l", "post"],
    ["inbox", "r", "batcher", "l", "read"],
    ["batcher", "r", "chain", "l", "submit batch"],
    ["inbox", "r", "watch", "l", "archive"],
    ["chain", "l", "watch", "r", "fraud proof"],
    ["chain", "r", "final", "l", "1 hour"],
    ["final", "b", "receipt", "t", "record"],
  ];
  const paths = links.map(([from, fs, to, ts, label], index) => {
    const [x1, y1] = mid(at[from], fs);
    const [x2, y2] = mid(at[to], ts);
    const cx = (x1 + x2) / 2;
    const d =
      fs === "b" || fs === "t"
        ? `M${x1},${y1} L${x2},${y2}`
        : `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`;
    const group = svg("g", { class: `link link-${index}` }, [
      svg("path", { d, class: "link-base" }),
      svg("path", { d, class: "link-flow" }),
    ]);
    const lx = (x1 + x2) / 2;
    const ly = (y1 + y2) / 2 - 8;
    const text = svg("text", { x: lx, y: ly, class: "link-label", "text-anchor": "middle" });
    text.textContent = label;
    group.append(text);
    group.style.setProperty("--i", String(index));
    return group;
  });
  const boxes = nodes.map((n, index) => {
    const group = svg(
      "g",
      { class: `stage tone-${n.tone}`, transform: `translate(${n.x},${n.y})` },
      [svg("rect", { width: W, height: H, rx: 14, class: "stage-box" })],
    );
    const title = svg("text", { x: 16, y: 28, class: "stage-title" });
    title.textContent = n.label;
    const sub = svg("text", { x: 16, y: 48, class: "stage-sub" });
    sub.textContent = n.sub;
    group.append(title, sub);
    group.style.setProperty("--i", String(index));
    return group;
  });
  const root = svg(
    "svg",
    {
      viewBox: "0 0 1070 330",
      class: "diagram",
      role: "img",
      "aria-labelledby": "diagram-title diagram-desc",
    },
    [
      svg("title", { id: "diagram-title" }),
      svg("desc", { id: "diagram-desc" }),
      ...paths,
      ...boxes,
    ],
  );
  root.querySelector("title").textContent = "How a Vigil transaction settles";
  root.querySelector("desc").textContent =
    "Users post signed transactions to the inbox on QoreChain. The batcher reads the inbox and submits a batch with an ML-DSA-87 anchor. The watchtower re-executes each batch from the inbox and sends a fraud proof if it is wrong. After the one-hour window the batch is final and its receipt is recorded on chain.";
  return root;
}

export function learnView({ el, pill, latestBatch }) {
  const p = (text) => el("p", { text });
  const h2 = (text) => el("h2", { text });
  const list = (items) =>
    el(
      "ul",
      { className: "prose-list" },
      items.map((item) => el("li", { text: item })),
    );
  const callout = (title, text, tone = "info") =>
    el("div", { className: `callout ${tone}` }, [el("strong", { text: title }), el("p", { text })]);

  const content = {
    concept: () => [
      el("p", {
        className: "lead",
        text: "Vigil is a rollup on QoreChain that is safe to use because someone is always checking it, and that checking is open to anyone.",
      }),
      h2("The problem"),
      p(
        "A rollup runs transactions off the base chain and posts only a summary, called a batch, back to it. That keeps fees low, but the base chain does not re-run the transactions when the batch arrives. It accepts the summary and waits: for one hour, anyone may prove the batch wrong. If nobody does, the batch becomes final, including any withdrawals it pays out.",
      ),
      p(
        "So a rollup is only as honest as the people watching it. If no one checks, a dishonest submitter can claim balances that do not exist and walk away with the funds.",
      ),
      callout(
        "Seen on the testnet",
        "We submitted deliberately forged batches to our own rollup. QoreChain accepted each one at once. The first was rejected only because another watcher happened to challenge it; the second was caught by Vigil's watchtower and challenged 5 seconds after it landed.",
        "warn",
      ),
      h2("What Vigil does"),
      list([
        "Runs a rollup, vigil-1, on the QoreChain testnet, with batches signed by a post-quantum key (ML-DSA-87).",
        "Runs a watchtower that keeps its own verified copy of every transaction, re-executes every batch, and challenges a wrong one with a fraud proof before the window closes.",
        "Records each final batch's signed settlement on chain, in a contract that checks the post-quantum signature itself, so other contracts can rely on it.",
        "Lets people attach private notes to payments, encrypted with ML-KEM-1024.",
        "Watches QoreChain itself: halts, block time and silent changes to its settings.",
      ]),
      h2("Who it is for"),
      list([
        "People using the rollup, who want to know their funds are being guarded.",
        "Rollup operators, who need a submitter, a watchtower and a status page that work together.",
        "Developers building on QoreChain, who need to know when the chain halts or changes.",
      ]),
      el("div", { className: "actions" }, [
        el("a", { className: "button", href: "#/learn/how-it-works", text: "See how it works" }),
        el("a", { className: "button ghost", href: "#/docs", text: "Read the docs" }),
      ]),
    ],

    "use-cases": () => {
      const useCase = (title, who, what, evidence) =>
        el("section", { className: "use-case" }, [
          el("h2", { text: title }),
          el("p", {}, [el("strong", { text: "For: " }), who]),
          p(what),
          el("p", { className: "muted" }, [
            el("strong", { text: "Shown on the testnet: " }),
            evidence,
          ]),
        ]);
      return [
        el("p", {
          className: "lead",
          text: "Five ways to use Vigil today. Each one already happened on the QoreChain testnet; the Proof page and the docs hold the transactions.",
        }),
        useCase(
          "Payments with a private note",
          "people paying each other on the rollup who need to say what a payment is for",
          "A transfer can carry a memo sealed with ML-KEM-1024 to the key the recipient published on QoreChain, and bound to that transfer. Amounts stay public; the note is readable only by the recipient, now and after quantum computers arrive.",
          "a recipient key, a sealed memo bound to a 1.5 QOR transfer, and the red-team replay refusing a changed or moved memo.",
        ),
        useCase(
          "A watchtower for rollups you do not run",
          "teams running a qledger-v1 rollup on QoreChain, and anyone holding funds in one",
          "Vigil re-executes other teams' rollups from public data and reports any batch it can prove wrong, including frauds that change only the withdrawals root. It never challenges a rollup it does not run; it alerts.",
          "on wicketgate-pay, batch 12 changed only its withdrawals root and paid 13 QOR with nobody challenging it. Vigil's audit reports it as proven fraud.",
        ),
        useCase(
          "Contracts that pay only after settlement",
          "developers who want a contract to act on a rollup batch only once it has truly settled",
          "VigilReceipts records each final batch's ML-DSA-87 settlement anchor after checking it with the pqcVerify precompile. Any contract can ask isAnchorRecorded before releasing money.",
          "SettlementGate, an escrow made with create-qorechain-dapp, released 0.1 QOR only when batch 29's receipt was recorded, and said no to a forged state root.",
        ),
        useCase(
          "AI assistants that check before they answer",
          "operators and users who ask an assistant about the rollup",
          "The Vigil MCP server gives an assistant read-only tools for the rollup, its batches, accounts and the audits of other rollups, beside QoreChain's own tools. It holds no key and cannot send anything.",
          "a live MCP session listed 18 tools and returned batch 18's verdict, its receipt and a verified ML-DSA-87 check of the transaction.",
        ),
        useCase(
          "Other protocols building on vigil-1",
          "teams who need a rollup with an honest, checkable history",
          "Because vigil-1 is based, anyone may post to it. Another team's exit protocol, Wicketgate, deposited 4 QOR, posted a transfer and a 2 QOR withdrawal, and paid an instant exit against batch 28, which Vigil's batcher submitted. The withdrawal was later paid out on chain.",
          "Wicketgate's deposit 178DA6D9… and withdrawal 480B6636… on vigil-1, and the payout of batch 28 withdrawal #7.",
        ),
        el("div", { className: "actions" }, [
          el("a", { className: "button", href: "#/proof", text: "See the transactions" }),
          el("a", {
            className: "button ghost",
            href: "#/rollups",
            text: "Audits of other rollups",
          }),
        ]),
      ];
    },

    "how-it-works": () => {
      const batch = latestBatch();
      return [
        el("p", {
          className: "lead",
          text: "Follow one transaction from the moment it is signed to the moment its settlement is recorded on chain.",
        }),
        el("figure", { className: "diagram-wrap" }, [
          diagram(),
          el("figcaption", {
            className: "muted",
            text: "The highlighted path repeats every few seconds. Every arrow is a real operation on the testnet.",
          }),
        ]),
        h2("Step by step"),
        el(
          "ol",
          { className: "steps-list" },
          [
            [
              "Sign",
              "A user signs a transfer or withdrawal with their rollup key (ML-DSA-44) and posts it to the rollup's inbox on QoreChain. Deposits arrive in the same inbox from the base chain.",
            ],
            [
              "Batch",
              "The batcher, a submitter that has put up a 1,000 QOR bond, reads the new entries, executes them, and submits a batch: the new state root, the withdrawals root and a commitment to exactly which entries it covered. On our own rollup it also signs the settlement anchor with ML-DSA-87.",
            ],
            [
              "Check",
              "The watchtower reads the same inbox independently, checks every entry against the chain's own hash chain, re-executes the batch, and compares every number. If anything differs, it builds a fraud proof, checks it the way the chain will, and submits the challenge.",
            ],
            [
              "Settle",
              "If nobody proves the batch wrong within the challenge window (one hour on the testnet), the batch is final. Withdrawals in it can be claimed with a Merkle proof.",
            ],
            [
              "Record",
              "The batch's ML-DSA-87 anchor is verified by the VigilReceipts contract, which reads the signer's key from QoreChain's key registry, and recorded permanently.",
            ],
          ].map(([title, text], index) =>
            el("li", {}, [
              el("span", { className: "step-number", text: index + 1 }),
              el("div", {}, [el("h3", { text: title }), el("p", { text })]),
            ]),
          ),
        ),
        batch
          ? callout(
              "See it live",
              `Batch ${batch.index} is the most recent. Its page shows each of these steps as they happen.`,
              "info",
            )
          : null,
        batch
          ? el(
              "div",
              { className: "actions" },
              el("a", {
                className: "button",
                href: `#/batches/${batch.index}`,
                text: `Open batch ${batch.index}`,
              }),
            )
          : null,
      ];
    },

    "before-after": () => {
      const side = (kind, label, title, text) =>
        el("div", { className: `ba-side ${kind}` }, [
          el("span", { className: "ba-tag", text: label }),
          el("h4", { text: title }),
          el("p", { text }),
        ]);
      const rows = [
        [
          "A submitter posts a forged batch",
          "Accepted, then final",
          "QoreChain accepts the batch at once. Unless someone happens to prove it wrong within the hour, it becomes final and its withdrawals pay out balances that never existed.",
          "Caught within seconds",
          "The watchtower re-executes the batch on its next round, finds the wrong root, builds the fraud proof, checks it locally and challenges. The batch is rejected and the submitter's bond is slashed.",
        ],
        [
          "Knowing whether a batch is right",
          "Trust the submitter",
          "The rollup kit has no watchtower for qledger-v1 rollups. Checking a batch means writing your own re-execution code.",
          "A verdict on every batch",
          "Every batch is re-executed from a verified copy of the inbox. The verdict sits next to the chain's status on the Batches page, for anyone to see.",
        ],
        [
          "A contract that needs proof of settlement",
          "Not possible",
          "The batch's ML-DSA-87 settlement signature is stored by QoreChain, but no contract can check it.",
          "One call",
          "VigilReceipts verifies the signature against the signer's registered key and records it. Any contract can call isAnchorRecorded.",
        ],
        [
          "A note attached to a payment",
          "Public, or nowhere",
          "Anything written into a transaction is readable by everyone, forever.",
          "Sealed with ML-KEM-1024",
          "Only the recipient's key opens the memo, and the app checks that it points to a real, signed transfer from the same sender.",
        ],
        [
          "The rollup's history",
          "Lost when nodes prune",
          "Inbox entries are read from the chain's nodes, which do not keep them forever. Old batches become impossible to check.",
          "Archived and verified",
          "Every entry is checked against the chain's hash chain and stored, so any batch can be re-checked later.",
        ],
        [
          "The base chain itself",
          "Problems go unnoticed",
          "A halt, a slow block time or a silent settings change is noticed only when something breaks. Mainnet runs at 4.78 s per block against a documented 3.1 s, and nothing said so.",
          "Watched every minute",
          "The monitor measures block production and block time, compares them with the documentation, and records every settings change with what changed.",
        ],
        [
          "Our own batcher makes a mistake",
          "The bond is lost",
          "A bug that produces a wrong batch is indistinguishable from fraud: it gets challenged and the 1,000 QOR bond is slashed.",
          "It refuses to submit",
          "The batcher re-executes its own batch first and will not build on a batch the watchtower judged invalid.",
        ],
        [
          "A future quantum computer",
          "Classical signatures fall",
          "Settlement that rests on elliptic-curve signatures alone could be forged.",
          "Post-quantum where it counts",
          "Batches are anchored with ML-DSA-87, rollup transactions use ML-DSA-44, and memos use ML-KEM-1024.",
        ],
        [
          "Running the rollup day to day",
          "Scripts and guesswork",
          "Command-line tools, block explorers and manual checks, with no single place that says whether everything is healthy.",
          "One console",
          "Overview, wallet, batch explorer, alerts to Telegram or a webhook, and these docs, in one app.",
        ],
      ];
      const timeline = (kind, title, events) =>
        el("div", { className: `ba-timeline ${kind}` }, [
          el("h3", { text: title }),
          el(
            "ol",
            {},
            events.map(([time, text], index) => {
              const item = el("li", {}, [
                el("span", { className: "ba-time", text: time }),
                el("span", { text }),
              ]);
              item.style.setProperty("--i", String(index));
              return item;
            }),
          ),
        ]);
      return [
        el("p", {
          className: "lead",
          text: "The same situations, without Vigil and with it. Everything on the right runs today on the QoreChain testnet.",
        }),
        h2("A forged batch, minute by minute"),
        el("div", { className: "ba-race" }, [
          timeline("without", "Without Vigil", [
            ["0:00", "A forged batch claims balances that do not exist. QoreChain accepts it."],
            ["0:01 – 59:59", "Nobody re-executes it. The challenge window runs down."],
            ["60:00", "The batch is final."],
            ["60:01", "Withdrawals from the forged balances are claimed and paid."],
          ]),
          timeline("with", "With Vigil", [
            ["0:00", "The same forged batch is submitted and accepted."],
            ["0:02", "The watchtower re-executes it: the state root is wrong. Alert raised."],
            ["0:05", "Fraud proof built, checked locally and sent. Challenge confirmed."],
            [
              "0:05",
              "QoreChain upholds the fraud, throws the batch out and slashes the 1,000 QOR bond.",
            ],
          ]),
        ]),
        el("p", {
          className: "muted",
          text: "The timings on the right were measured on the testnet on 17 November 2026, when Vigil's watchtower stopped forged batch 18 of vigil-1. See the Proof page for the transactions.",
        }),
        h2("Side by side"),
        el(
          "div",
          { className: "ba-grid" },
          rows.map(([topic, beforeTitle, beforeText, afterTitle, afterText]) =>
            el("section", { className: "ba-row", "aria-label": topic }, [
              el("h3", { className: "ba-topic", text: topic }),
              el("div", { className: "ba-pair" }, [
                side("without", "Without Vigil", beforeTitle, beforeText),
                side("with", "With Vigil", afterTitle, afterText),
              ]),
            ]),
          ),
        ),
        el("div", { className: "actions" }, [
          el("a", { className: "button", href: "#/batches", text: "See the live verdicts" }),
          el("a", {
            className: "button ghost",
            href: "#/learn/how-it-works",
            text: "How it works",
          }),
        ]),
      ];
    },

    security: () => [
      el("p", {
        className: "lead",
        text: "What Vigil protects, against whom, and where it stops. Every claim is backed by a test or a transaction on the testnet.",
      }),
      el(
        "div",
        { className: "table-wrap", role: "region", "aria-label": "Threats", tabindex: "0" },
        el("table", {}, [
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              ["Threat", "What Vigil does", "Status"].map((h) =>
                el("th", { scope: "col", text: h }),
              ),
            ),
          ),
          el(
            "tbody",
            {},
            [
              [
                "A submitter posts a wrong state or withdrawals root",
                "Re-executes every batch and challenges with a fraud proof checked locally first",
                ["good", "Covered"],
              ],
              [
                "A replacement batch reuses an old verdict",
                "Verdicts belong to the whole claim, not the batch number",
                ["good", "Covered"],
              ],
              [
                "Nobody batches the inbox",
                "Alerts after 600 blocks; any bonded account can submit",
                ["wait", "Detected"],
              ],
              [
                "Inbox data is withheld or altered",
                "Every entry is checked against the chain's hash chain and archived",
                ["good", "Covered"],
              ],
              [
                "A forged or replayed settlement receipt",
                "The contract reads the signer's key from the chain, never from the caller",
                ["good", "Covered"],
              ],
              [
                "A quantum computer forges classical signatures",
                "ML-DSA-87 anchors and hybrid transactions, ML-DSA-44 rollup keys",
                ["wait", "Partly"],
              ],
              [
                "Someone reads a private memo",
                "ML-KEM-1024 encryption to the recipient's registered key",
                ["good", "Covered"],
              ],
              [
                "Leaked keys",
                "Secrets only in the services that sign; redacted from logs; encrypted rollup keystore",
                ["wait", "Reduced"],
              ],
              [
                "QoreChain halts or changes its rules",
                "Detected and reported by the monitor; cannot be prevented",
                ["wait", "Detected"],
              ],
            ].map(([threat, response, [kind, status]]) =>
              el("tr", {}, [
                el("td", { text: threat }),
                el("td", { className: "wrap", text: response }),
                el("td", {}, pill(kind, status)),
              ]),
            ),
          ),
        ]),
      ),
      h2("Limits, stated plainly"),
      list([
        "Fraud is caught only if at least one honest watcher is online during the challenge window.",
        "Hybrid signatures are only as strong as the chain's enforcement of the post-quantum half; a key's first registration is authorised classically.",
        "A memo hides its text only. Who sent it, when, its size and the payment it points to are public.",
        "Vigil is testnet software and has not had a professional audit. It was reviewed by two independent reviewers; their findings are fixed or documented.",
      ]),
      el(
        "div",
        { className: "actions" },
        el("a", {
          className: "button ghost",
          href: "#/docs/THREAT_MODEL",
          text: "Read the full threat model",
        }),
      ),
    ],

    "post-quantum": () => [
      el("p", {
        className: "lead",
        text: "Large quantum computers would break the signatures most blockchains use today. Vigil uses the NIST post-quantum standards wherever a signature or key exchange protects value.",
      }),
      h2("The algorithms"),
      el(
        "div",
        { className: "grid cards" },
        [
          [
            "ML-DSA-87",
            "FIPS 204, highest security level",
            "Signs every batch's settlement anchor and the operator's base-chain transactions (alongside the classical signature). Verified on chain by the pqcVerify precompile.",
            "violet",
          ],
          [
            "ML-DSA-44",
            "FIPS 204",
            "Signs every rollup transaction: transfers and withdrawals. The account id is the hash of this public key.",
            "info",
          ],
          [
            "ML-KEM-1024",
            "FIPS 203, highest security level",
            "Encrypts private memos to the key the recipient published in QoreChain's encryption-key registry.",
            "pink",
          ],
        ].map(([name, standard, use, tone]) =>
          el("div", { className: "card lift" }, [
            pill(tone, standard),
            el("h3", { className: "algo", text: name }),
            el("p", { className: "muted", text: use }),
          ]),
        ),
      ),
      h2("Where each key lives"),
      list([
        "The operator's seed phrase derives the base-chain key pair and the ML-DSA-87 key; it is held only by the services that sign.",
        "Each rollup account's ML-DSA-44 key is stored encrypted on the operator's server (scrypt and AES-256-GCM).",
        "Memo keys are derived from the same seed phrase; only the public ML-KEM-1024 key is published on chain.",
      ]),
    ],

    glossary: () => [
      el("p", { className: "lead", text: "The words used across Vigil, in one place." }),
      el(
        "dl",
        { className: "glossary" },
        [
          [
            "Rollup",
            "A system that runs transactions off the base chain and posts compact summaries (batches) back to it.",
          ],
          [
            "Inbox",
            "The ordered list of transactions and deposits waiting to be batched, kept on QoreChain as a hash chain.",
          ],
          [
            "Batch",
            "A submitter's claim about the result of a range of inbox entries: the new state root, withdrawals root and data hash.",
          ],
          [
            "State root",
            "A single hash that commits to every account balance and nonce on the rollup.",
          ],
          [
            "Withdrawals root",
            "A hash committing to the withdrawals a batch pays out; each withdrawal is claimed with a Merkle proof against it.",
          ],
          [
            "Challenge window",
            "The time after a batch is submitted during which anyone can prove it wrong. One hour on the testnet.",
          ],
          [
            "Fraud proof",
            "The batch's entries plus proofs of the accounts they touch, enough for QoreChain to re-execute the batch and see the error.",
          ],
          [
            "Bond",
            "QOR a submitter locks up. A successful fraud proof slashes it: half is burned, half goes to the challenger.",
          ],
          [
            "Anchor",
            "The rollup creator's ML-DSA-87 signature over a batch's settlement, stored by QoreChain.",
          ],
          [
            "Receipt",
            "An anchor verified and recorded by the VigilReceipts contract, so contracts on QoreChain's EVM can rely on it.",
          ],
          [
            "Watchtower",
            "A service that independently re-executes every batch and challenges wrong ones.",
          ],
          [
            "Based sequencing",
            "Anyone with a bond may submit batches; there is no single privileged sequencer.",
          ],
        ].flatMap(([term, meaning]) => [el("dt", { text: term }), el("dd", { text: meaning })]),
      ),
    ],

    faq: () => [
      el("p", { className: "lead", text: "Short answers to the questions people ask first." }),
      ...[
        [
          "Is this real or a simulation?",
          "Real. The rollup vigil-1 runs on the QoreChain testnet. Every batch, receipt and transfer on these pages is a real testnet transaction; the explorer links prove it.",
        ],
        [
          "What happens if the batcher lies?",
          "The watchtower re-executes the batch, finds the mismatch, and submits a fraud proof. QoreChain re-executes it too, rejects the batch and slashes the submitter's bond. The rollup continues from the last honest state.",
        ],
        [
          "What if the watchtower is offline?",
          "Then a wrong batch can become final after the one-hour window. That is why anyone can run a watchtower: it needs no key and no funds to check, only to challenge.",
        ],
        [
          "Can I check Vigil myself?",
          "Yes. Run the watchtower once from the repository and it re-executes every batch from public data, without trusting this site.",
        ],
        [
          "Why one hour?",
          "It is the testnet's setting for this rollup. On mainnet the default is seven days.",
        ],
        [
          "Where does my money go when I deposit?",
          "Into the rollup's deposit pool on QoreChain. It is credited to your rollup account and paid out again when you withdraw and claim.",
        ],
        [
          "Why does a withdrawal take an hour?",
          "It is paid only after the batch that contains it is final, so that a wrong batch cannot pay out.",
        ],
        [
          "Who can read my memo?",
          "Only the holder of the encryption key you sealed it to. The amount and the accounts of the payment it accompanies are public.",
        ],
        [
          "What is the receipts contract for?",
          "It turns a settlement signature into on-chain fact: any contract on QoreChain's EVM can ask whether a given batch was signed by the rollup's creator.",
        ],
        [
          "What does post-quantum mean here?",
          "Signatures and encryption use the NIST standards ML-DSA and ML-KEM, which are designed to stay secure against quantum computers.",
        ],
        [
          "Is it audited?",
          "No professional audit. Two independent reviews were done; every finding is fixed or documented in the threat model.",
        ],
        ["Is it open source?", "Yes, under the Apache-2.0 licence."],
      ].map(([q, a]) =>
        el("details", { className: "faq" }, [el("summary", { text: q }), el("p", { text: a })]),
      ),
    ],
  };

  return {
    title: "Learn",
    async load() {
      return {};
    },
    render(_data, param) {
      const page = PAGES.some(([id]) => id === param) ? param : "concept";
      const title = PAGES.find(([id]) => id === page)[1];
      const nav = el(
        "nav",
        { className: "side-nav", "aria-label": "Learn" },
        el(
          "ul",
          {},
          PAGES.map(([id, label]) =>
            el(
              "li",
              {},
              el("a", {
                href: `#/learn/${id}`,
                text: label,
                "aria-current": id === page ? "page" : undefined,
              }),
            ),
          ),
        ),
      );
      return el("div", { className: "stack" }, [
        el("div", { className: "page-head" }, [
          el("h1", { text: page === "concept" ? "What is Vigil?" : title }),
        ]),
        el("div", { className: "with-side" }, [
          nav,
          el("article", { className: "prose" }, content[page]()),
        ]),
      ]);
    },
  };
}
