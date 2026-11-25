// The home page: what Vigil is, at a glance, with live proof from the testnet.
// The first screen alone should tell a visitor what the product is, how it
// works and that it is running.

export function homeView({
  el,
  pill,
  verdictPill,
  statusCell,
  countValue,
  ago,
  diagram,
  overview,
}) {
  const icon = (paths) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const d of paths) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  };
  const ICONS = {
    sign: ["M12 3l7 4v5c0 4.5-3 8-7 9-4-1-7-4.5-7-9V7l7-4z", "M9 12l2 2 4-4"],
    check: ["M4 12a8 8 0 1 0 16 0 8 8 0 1 0-16 0", "M12 8v4l3 2"],
    settle: ["M5 12l4 4L19 6"],
    eye: ["M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z", "M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6"],
    stack: ["M12 3l9 5-9 5-9-5 9-5z", "M3 13l9 5 9-5"],
    receipt: ["M6 3h12v18l-3-2-3 2-3-2-3 2V3z", "M9 8h6M9 12h6"],
    lock: ["M6 11h12v10H6z", "M8 11V8a4 4 0 0 1 8 0v3"],
    pulse: ["M3 12h4l3-7 4 14 3-7h4"],
    console: ["M3 5h18v14H3z", "M7 10l3 2-3 2M13 14h4"],
  };

  function liveCard(data) {
    const watch = data.services.find((s) => s.service === "watchtower");
    const onDuty = watch !== undefined && watch.ageSecs <= 180;
    const s = data.rollup.summary;
    const latest = data.rollup.batches.slice(0, 4);
    return el("aside", { className: "live-card", "aria-label": "Live from the testnet" }, [
      el("div", { className: "live-head" }, [
        el("div", { className: "live-title" }, [
          el("span", { className: onDuty ? "pulse" : "dot-off" }),
          el("strong", { text: "Watchtower" }),
        ]),
        pill(onDuty ? "good" : "wait", onDuty ? "On duty" : "Silent"),
      ]),
      el(
        "ul",
        { className: "live-list" },
        latest.length === 0
          ? [el("li", { className: "empty", text: "No batches yet." })]
          : latest.map((batch, index) => {
              const item = el("li", {}, [
                el("a", { href: `#/batches/${batch.index}`, text: `Batch ${batch.index}` }),
                verdictPill(batch),
                el("div", { className: "live-status" }, statusCell(batch)),
              ]);
              item.style.setProperty("--i", String(index));
              return item;
            }),
      ),
      el("div", { className: "live-foot" }, [
        el("div", {}, [
          countValue(s.valid + s.invalid, "num"),
          el("span", { text: "batches re-executed" }),
        ]),
        el("div", {}, [countValue(s.invalid, "num"), el("span", { text: "found invalid" })]),
        el("div", {}, [
          countValue(s.receiptsRecorded, "num"),
          el("span", { text: "receipts on chain" }),
        ]),
      ]),
      el("p", {
        className: "live-note",
        text: watch
          ? `Last check ${ago(watch.lastSeen)} · rollup ${data.rollup.id}`
          : `Rollup ${data.rollup.id}`,
      }),
    ]);
  }

  const pillars = [
    ["sign", "Signed", "Every batch carries an ML-DSA-87 post-quantum signature."],
    ["check", "Re-checked", "A watchtower re-executes every batch and challenges a wrong one."],
    ["settle", "Settled on chain", "Final batches are verified and recorded by a contract."],
  ];

  const features = [
    [
      "eye",
      "primary",
      "Watchtower",
      "Re-executes every batch from a verified inbox copy and sends the fraud proof.",
      "#/batches",
      "See verdicts",
    ],
    [
      "stack",
      "violet",
      "Bonded batcher",
      "Submits batches with a post-quantum anchor, and refuses to submit a wrong one.",
      "#/batches",
      "Browse batches",
    ],
    [
      "receipt",
      "info",
      "Verified receipts",
      "A contract checks the ML-DSA-87 signature on chain, so other contracts can rely on it.",
      "#/docs/CONTRACT",
      "Read the contract",
    ],
    [
      "lock",
      "pink",
      "Private memos",
      "Notes on payments, sealed with ML-KEM-1024 to the recipient's key.",
      "#/learn/post-quantum",
      "How it is sealed",
    ],
    [
      "pulse",
      "warn",
      "Chain monitor",
      "Watches QoreChain itself: halts, block time and silent settings changes.",
      "#/chain",
      "Base chain",
    ],
    [
      "console",
      "primary",
      "Operator console",
      "Deposit, send, withdraw and claim from the browser, with alerts to Telegram.",
      "#/wallet",
      "Open wallet",
    ],
  ];

  const compare = [
    [
      "A forged batch",
      "Accepted, and final an hour later. Fake balances are withdrawn.",
      "Re-executed in seconds, challenged, rejected. The forger's bond is slashed.",
    ],
    [
      "Proof of settlement",
      "A signature no contract can check.",
      "Verified and recorded on chain by VigilReceipts.",
    ],
    [
      "Payment notes",
      "Readable by everyone, forever.",
      "Sealed with ML-KEM-1024 for the recipient only.",
    ],
  ];

  return {
    title: "Home",
    async load() {
      return overview();
    },
    render(data) {
      const hero = el("section", { className: "home-hero hero" }, [
        el("div", { className: "home-pitch" }, [
          el("span", { className: "eyebrow" }, [
            el("span", { className: "pulse" }),
            "Live on the QoreChain testnet",
          ]),
          el("h1", {}, [
            document.createTextNode("The rollup that "),
            el("em", { text: "never looks away." }),
          ]),
          el("p", {
            className: "home-lead",
            text: "Vigil Watchtower is a post-quantum rollup on QoreChain with its own watchtower. Every batch is re-executed the moment it lands, and a wrong one is challenged before it can settle.",
          }),
          el(
            "ol",
            { className: "pillars" },
            pillars.map(([key, title, text], index) => {
              const item = el("li", {}, [
                el("span", { className: "pillar-icon" }, icon(ICONS[key])),
                el("div", {}, [el("strong", { text: title }), el("span", { text })]),
              ]);
              item.style.setProperty("--i", String(index));
              return item;
            }),
          ),
          el("div", { className: "actions" }, [
            el("a", { className: "button", href: "#/overview", text: "Open the live dashboard" }),
            el("a", {
              className: "button ghost",
              href: "#/learn/how-it-works",
              text: "How it works",
            }),
          ]),
        ]),
        data ? liveCard(data) : null,
      ]);

      return el("div", { className: "stack home" }, [
        hero,

        el("section", { className: "home-section", "aria-labelledby": "why" }, [
          el("div", { className: "home-head" }, [
            el("span", { className: "kicker", text: "Why it matters" }),
            el("h2", { id: "why", text: "A rollup is only as honest as the people watching it" }),
            el("p", {
              text: "QoreChain accepts every batch at once and gives the world one hour to prove it wrong. Without a watcher, nobody does.",
            }),
          ]),
          el("div", { className: "compare" }, [
            el("div", { className: "compare-head" }, [
              el("span"),
              el("span", { className: "compare-label without", text: "Without Vigil" }),
              el("span", { className: "compare-label with", text: "With Vigil" }),
            ]),
            ...compare.map(([topic, before, after]) =>
              el("div", { className: "compare-row" }, [
                el("strong", { text: topic }),
                el("p", { className: "without", text: before }),
                el("p", { className: "with", text: after }),
              ]),
            ),
          ]),
          el("div", { className: "proof-banner" }, [
            el("span", { className: "pulse" }),
            el("p", {}, [
              el("strong", { text: "It happened on the testnet: " }),
              "a forged batch was caught and challenged by Vigil's watchtower 5 seconds after it was submitted. The cheater lost a 1,000 QOR bond.",
            ]),
            el("a", { className: "button", href: "#/proof", text: "See the proof" }),
          ]),
          el("a", {
            className: "more",
            href: "#/learn/before-after",
            text: "All nine situations, side by side",
          }),
        ]),

        el("section", { className: "home-section", "aria-labelledby": "how" }, [
          el("div", { className: "home-head" }, [
            el("span", { className: "kicker", text: "How it works" }),
            el("h2", { id: "how", text: "Sign, batch, check, settle, record" }),
            el("p", { text: "Every arrow below is a real operation on the testnet." }),
          ]),
          el("figure", { className: "diagram-wrap" }, diagram()),
        ]),

        el("section", { className: "home-section", "aria-labelledby": "inside" }, [
          el("div", { className: "home-head" }, [
            el("span", { className: "kicker", text: "What is inside" }),
            el("h2", { id: "inside", text: "Six parts that work together" }),
          ]),
          el(
            "div",
            { className: "feature-grid" },
            features.map(([key, tone, title, text, href, link]) =>
              el("a", { className: `feature tone-${tone}`, href }, [
                el("span", { className: "feature-icon" }, icon(ICONS[key])),
                el("h3", { text: title }),
                el("p", { text }),
                el("span", { className: "feature-link", text: link }),
              ]),
            ),
          ),
        ]),

        el("section", { className: "home-section pq-band", "aria-labelledby": "pq" }, [
          el("div", { className: "home-head" }, [
            el("span", { className: "kicker", text: "Post-quantum" }),
            el("h2", { id: "pq", text: "Built for after Q-Day" }),
            el("p", {
              text: "Large quantum computers would break the signatures most chains rely on. Vigil uses the NIST standards wherever value is at stake.",
            }),
          ]),
          el(
            "div",
            { className: "algos" },
            [
              ["ML-DSA-87", "Batch anchors and operator transactions"],
              ["ML-DSA-44", "Every rollup transaction"],
              ["ML-KEM-1024", "Private payment memos"],
            ].map(([name, use]) =>
              el("div", { className: "algo-chip" }, [
                el("code", { text: name }),
                el("span", { text: use }),
              ]),
            ),
          ),
        ]),

        el("section", { className: "home-cta" }, [
          el("h2", { text: "Do not trust this page. Check it." }),
          el("p", {
            text: "Run the watchtower once and it re-executes every batch of vigil-1 from public data.",
          }),
          el(
            "pre",
            { className: "code" },
            el("code", { text: "ROLLUP_ID=vigil-1 pnpm watchtower --once" }),
          ),
          el("div", { className: "actions" }, [
            el("a", { className: "button", href: "#/docs/JUDGES", text: "Evidence for judges" }),
            el("a", { className: "button ghost", href: "#/docs", text: "Read the docs" }),
          ]),
        ]),
      ]);
    },
  };
}
