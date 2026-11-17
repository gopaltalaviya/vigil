// The Learn section: what Vigil is and how it works, in plain language.
// Static content; every value is written as text, never as markup.

const PAGES = [
  ["concept", "Concept"],
  ["how-it-works", "How it works"],
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
function diagram() {
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
        "We submitted a deliberately forged batch to our own rollup. QoreChain accepted it at once. A fraud proof rejected it ten blocks later: the system works only when a watcher is online.",
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
