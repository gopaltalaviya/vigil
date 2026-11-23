import { docsView } from "./docs.js";
import { homeView } from "./home.js";
import { proofView } from "./proof.js";
import { diagram, learnView } from "./learn.js";

// Vigil web app. No dependencies and no build step. Every value that comes
// from the network is written with textContent, so nothing read from the chain
// can inject markup.

const REFRESH_MS = 10_000;
const $ = (id) => document.getElementById(id);

// ---------- small helpers ----------

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "on")
      for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of [children].flat()) {
    if (child !== undefined && child !== null) node.append(child);
  }
  return node;
}

/** uqor (decimal string) -> "1.5" */
function qor(uqor) {
  const value = BigInt(uqor ?? "0");
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

function ago(unixSeconds) {
  if (!unixSeconds) return "never";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

const short = (value, head = 10, tail = 6) =>
  value && value.length > head + tail + 1
    ? `${value.slice(0, head)}…${value.slice(-tail)}`
    : (value ?? "");
const pill = (kind, text, title) => el("span", { className: `pill ${kind}`, text, title });

function copyable(value, shown = short(value)) {
  const button = el("button", {
    className: "copy",
    type: "button",
    text: "Copy",
    "aria-label": `Copy ${shown}`,
    on: {
      click: async () => {
        try {
          await navigator.clipboard.writeText(value);
          button.textContent = "Copied";
        } catch {
          button.textContent = "Select and copy";
        }
        setTimeout(() => (button.textContent = "Copy"), 1500);
      },
    },
  });
  return el("span", {}, [el("span", { className: "mono", text: shown, title: value }), button]);
}

function toast(title, detail, bad = false) {
  const node = el("div", { className: bad ? "toast bad" : "toast" }, [
    el("strong", { text: title }),
    detail ? el("span", { text: detail }) : null,
  ]);
  $("toasts").append(node);
  setTimeout(
    () => {
      node.classList.add("leaving");
      setTimeout(() => node.remove(), 250);
    },
    bad ? 12_000 : 8_000,
  );
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers:
      body === undefined ? {} : { "content-type": "application/json", "x-vigil-request": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    /* an empty or non-JSON answer is handled by the status check below */
  }
  if (!response.ok) {
    const error = new Error(data.error ?? `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const VERDICT = {
  valid: ["good", "Valid"],
  invalid: ["bad", "Invalid"],
  undecidable: ["wait", "Waiting for data"],
  pending: ["plain", "Not judged yet"],
};
const STATUS = {
  finalized: ["good", "Final"],
  submitted: ["wait", "In challenge window"],
  challenged: ["bad", "Challenged"],
  rejected: ["bad", "Rejected"],
};
const lookup = (map, key) => map[key] ?? ["plain", key];

// ---------- shared state ----------

const state = { session: { console: false, signedIn: false }, overview: null };

function setStatus(kind, text) {
  $("state").className = `state ${kind}`;
  $("state-text").textContent = text;
}

function overallStatus(data) {
  if (data.rollup.batches.some((b) => b.verdict === "invalid" && b.status !== "rejected")) {
    return ["bad", "Invalid batch detected"];
  }
  const watchtower = data.services.find((s) => s.service === "watchtower");
  if (!watchtower) return ["warn", "Watchtower not started"];
  if (watchtower.ageSecs > 180)
    return ["warn", `Watchtower silent for ${ago(watchtower.lastSeen).replace(" ago", "")}`];
  if (data.chain.some((c) => c.network === "testnet" && c.tip?.halted))
    return ["warn", "Base chain halted"];
  return ["ok", "On duty"];
}

// ---------- reusable pieces ----------

function section(title, aside, body) {
  return el("section", {}, [
    el("div", { className: "section-head" }, [el("h2", { text: title }), aside ?? null]),
    body,
  ]);
}

// ---------- motion and progress helpers ----------

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let animateNumbers = false;

/** A number that counts up from zero when a page is first shown. */
function countValue(target, className = "value") {
  const node = el("div", { className, text: animateNumbers && !reducedMotion() ? "0" : target });
  if (animateNumbers && !reducedMotion() && Number(target) > 0) {
    const end = Number(target);
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 700);
      node.textContent = String(Math.round(end * (1 - Math.pow(1 - t, 3))));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  return node;
}

const challengeWindow = () => state.overview?.rollup.challengeWindowSecs ?? 3600;

function windowState(batch) {
  const total = challengeWindow();
  const elapsed = Math.max(0, Date.now() / 1000 - batch.submittedTime);
  return { fraction: Math.min(1, elapsed / total), left: Math.max(0, total - elapsed) };
}

function duration(seconds) {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`;
  const minutes = Math.round((seconds % 3600) / 60);
  return `${Math.floor(seconds / 3600)} h${minutes ? ` ${minutes} min` : ""}`;
}

/** An accessible progress bar; the fill is set through CSSOM, which the CSP allows. */
function progressBar(fraction, label, kind = "") {
  const fill = el("span");
  fill.style.setProperty("--p", String(fraction));
  return el(
    "div",
    {
      className: `progress ${kind}`,
      role: "progressbar",
      "aria-label": label,
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": String(Math.round(fraction * 100)),
    },
    fill,
  );
}

function statusCell(batch) {
  const [kind, text] = lookup(STATUS, batch.status);
  if (batch.status !== "submitted") return pill(kind, text);
  const { fraction, left } = windowState(batch);
  return el("div", { className: "status-cell" }, [
    progressBar(fraction, `Challenge window ${Math.round(fraction * 100)}% elapsed`, "window"),
    el("span", {
      className: "meta",
      text: left > 0 ? `${duration(left)} left to challenge` : "finalizing",
    }),
  ]);
}

/** `compact` keeps only batch, verdict, status and time, for narrow places. */
function batchTable(batches, caption, compact = false) {
  if (batches.length === 0) return el("p", { className: "empty", text: "No batches yet." });
  const rows = batches.map((batch) => {
    const [vk, vt] = lookup(VERDICT, batch.verdict);
    const verdict = el("div", {}, [pill(vk, vt)]);
    if (batch.reasons.length > 0) {
      verdict.append(
        el("span", { className: "reasons", text: `Mismatch: ${batch.reasons.join(", ")}` }),
      );
    }
    const cells = [
      el("td", {}, el("a", { href: `#/batches/${batch.index}`, text: `Batch ${batch.index}` })),
      el("td", {}, verdict),
      el("td", {}, statusCell(batch)),
      el("td", { text: `${batch.entries.from}–${batch.entries.to}` }),
      el("td", { className: "mono", text: short(batch.stateRoot), title: batch.stateRoot }),
      el(
        "td",
        {},
        batch.receipt
          ? pill("info", "Recorded")
          : pill("plain", batch.status === "rejected" ? "None" : "Not yet"),
      ),
      el("td", { className: "muted", text: ago(batch.submittedTime) }),
    ];
    return el(
      "tr",
      { className: "link" },
      compact ? [cells[0], cells[1], cells[2], cells[6]] : cells,
    );
  });
  const headings = [
    "Batch",
    "Watchtower verdict",
    "Chain status",
    "Inbox entries",
    "State root",
    "Receipt",
    "Submitted",
  ];
  return el(
    "div",
    { className: "table-wrap", role: "region", "aria-label": caption, tabindex: "0" },
    [
      el("table", {}, [
        el("caption", { className: "visually-hidden", text: caption }),
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            (compact ? [headings[0], headings[1], headings[2], headings[6]] : headings).map((h) =>
              el("th", { scope: "col", text: h }),
            ),
          ),
        ),
        el("tbody", {}, rows),
      ]),
    ],
  );
}

const ENTRY_KINDS = {
  deposit: ["info", "Deposit"],
  transfer: ["violet", "Transfer"],
  withdrawal: ["wait", "Withdrawal"],
  memo: ["pink", "Sealed memo"],
  data: ["plain", "Data"],
};

function entryFeed(entries) {
  if (entries.length === 0)
    return el("p", { className: "empty", text: "Nothing has been posted yet." });
  return el(
    "ul",
    { className: "feed compact" },
    entries.map((entry) => {
      const [kind, word] = lookup(ENTRY_KINDS, entry.kind);
      return el(
        "li",
        {},
        el("div", { className: "row" }, [
          el("span", { className: "title" }, [
            pill(kind, word),
            document.createTextNode(entry.amount === undefined ? "" : ` ${qor(entry.amount)} QOR`),
            entry.signatureValid === false
              ? el("span", { className: "reasons", text: "invalid signature: ignored" })
              : null,
          ]),
          el("span", { className: "meta", text: `entry ${entry.sequence}` }),
        ]),
      );
    }),
  );
}

const DOCUMENTED_BLOCK_TIME = { testnet: 1.3, mainnet: 3.1 };

const SEVERITY = {
  critical: ["bad", "Critical"],
  warning: ["wait", "Warning"],
  info: ["info", "Info"],
};
const openEntries = new Set();

function feed(items, emptyText, listId) {
  if (items.length === 0) return el("p", { className: "empty", text: emptyText });
  return el(
    "ul",
    { className: "feed" },
    items.map((item) => {
      const key = `${listId}:${item.createdAt}:${item.title}`;
      const [kind, word] = lookup(SEVERITY, item.severity);
      const when = el("time", {
        text: ago(item.createdAt),
        datetime: new Date(item.createdAt * 1000).toISOString(),
      });
      const details = el("details", { open: openEntries.has(key) }, [
        el(
          "summary",
          {},
          el("span", { className: "row" }, [
            el("span", { className: "title" }, [
              pill(kind, word),
              document.createTextNode(` ${item.title}`),
            ]),
            when,
          ]),
        ),
        el("pre", { text: item.detail ?? item.body ?? "" }),
      ]);
      details.addEventListener("toggle", () =>
        details.open ? openEntries.add(key) : openEntries.delete(key),
      );
      return el("li", { className: item.severity }, details);
    }),
  );
}

const SOURCE_LABELS = {
  "upgrade-plan": "Upgrade plan",
  "voting-proposals": "Proposals",
  "circuit-breaker": "Circuit breaker",
  "evm-params": "EVM settings",
  "rdk-params": "Rollup settings",
  "multilayer-params": "Layer settings",
  "pqc-params": "Post-quantum settings",
  "staking-params": "Staking settings",
  "node-manifest": "Node release",
};

function networkCard(network) {
  const tip = network.tip;
  const badge =
    !tip || !network.tipAvailable
      ? pill("plain", "No data")
      : tip.halted
        ? pill("bad", "Halted")
        : el("span", { className: "pill good live" }, [
            el("span", { className: "pulse" }),
            "Producing blocks",
          ]);
  const measured = tip?.measuredBlockTimeSecs ?? null;
  const documented = DOCUMENTED_BLOCK_TIME[network.network];
  const facts = [
    ["Height", tip ? tip.height.toLocaleString("en-US") : "—"],
    ["Last block", tip ? ago(tip.tipTime) : "—"],
    ["Checked", ago(network.checkedAt)],
  ];
  let timing = null;
  if (measured !== null && documented !== undefined) {
    const max = Math.max(measured, documented) * 1.1;
    const drift = Math.round((measured / documented - 1) * 100);
    timing = el("div", { className: "timing" }, [
      el("div", { className: "row" }, [
        el("span", { className: "title", text: "Block time" }),
        el("span", {
          className: Math.abs(drift) > 50 ? "meta drift-high" : "meta",
          text: `${drift > 0 ? "+" : ""}${drift}% vs documented`,
        }),
      ]),
      el("div", { className: "bars" }, [
        el("span", { className: "bar-label", text: "Measured" }),
        progressBar(measured / max, `Measured block time ${measured} seconds`),
        el("span", { className: "bar-value", text: `${measured} s` }),
        el("span", { className: "bar-label", text: "Documented" }),
        progressBar(documented / max, `Documented block time ${documented} seconds`, "neutral"),
        el("span", { className: "bar-value", text: `${documented} s` }),
      ]),
    ]);
  }
  return el("div", { className: "card lift" }, [
    el("div", { className: "card-head" }, [el("h2", { text: network.network }), badge]),
    el(
      "dl",
      { className: "facts" },
      facts.flatMap(([term, value]) => [el("dt", { text: term }), el("dd", { text: value })]),
    ),
    timing,
    el(
      "div",
      { className: "chips" },
      network.sources.map((source) => {
        const name = SOURCE_LABELS[source.source] ?? source.source;
        return pill(
          source.available ? "plain" : "wait",
          source.available ? name : `${name}: unavailable`,
          source.available
            ? `Last changed ${ago(source.changedAt)}; checked ${ago(source.checkedAt)}`
            : "Could not be read on the last check",
        );
      }),
    ),
  ]);
}

// ---------- views ----------

const views = {
  overview: {
    title: "Dashboard",
    async load() {
      const entries = await api("/api/entries").catch(() => ({ entries: [] }));
      return { ...state.overview, entries: entries.entries };
    },
    render(data) {
      const s = data.rollup.summary;
      const flow = [
        ["Inbox entries", data.rollup.inboxEntriesArchived, "posted by users"],
        ["Batches", s.batches, "submitted to QoreChain"],
        [
          "Re-executed",
          s.valid + s.invalid,
          s.invalid === 0 ? "all valid" : `${s.invalid} invalid`,
        ],
        ["Final", s.finalized, "past the challenge window"],
        ["Receipts", s.receiptsRecorded, "verified on chain"],
      ];
      const openBatches = data.rollup.batches.filter((b) => b.status === "submitted");
      const stopped = data.rollup.batches.filter(
        (b) => b.verdict === "invalid" && b.status === "rejected",
      ).length;
      const openInvalid = data.rollup.batches.filter(
        (b) => b.verdict === "invalid" && b.status !== "rejected",
      ).length;
      return el("div", { className: "stack" }, [
        el("div", { className: "page-head" }, [
          el("span", { className: "eyebrow" }, [
            el("span", { className: "pulse" }),
            `Live on QoreChain testnet · rollup ${data.rollup.id}`,
          ]),
          el("h1", { text: "Dashboard" }),
          el("p", {
            text: "The rollup right now: what users posted, what was batched, what the watchtower re-executed, and what is final.",
          }),
          el("div", { className: "actions" }, [
            el("a", { className: "button", href: "#/wallet", text: "Open wallet" }),
            el("a", { className: "button ghost", href: "#/batches", text: "Browse batches" }),
          ]),
        ]),
        openInvalid > 0
          ? el("p", {
              className: "notice warn",
              text: `The watchtower found ${openInvalid} invalid batch${openInvalid === 1 ? "" : "es"} the chain has not rejected. See Alerts.`,
            })
          : null,
        stopped > 0
          ? el("p", { className: "notice good" }, [
              `The watchtower caught ${stopped} forged batch${stopped === 1 ? "" : "es"}; the chain threw ${stopped === 1 ? "it" : "them"} out and slashed the bond. `,
              el("a", { href: "#/proof", text: "See the proof" }),
            ])
          : null,
        el("section", { "aria-label": "How a transaction settles" }, [
          el(
            "ol",
            { className: "flow" },
            flow.map(([label, value, hint], index) =>
              el("li", { className: "flow-step" }, [
                el("span", { className: "flow-index", text: index + 1 }),
                el("div", { className: "label", text: label }),
                countValue(value),
                el("div", { className: "hint", text: hint }),
              ]),
            ),
          ),
        ]),
        openBatches.length > 0
          ? section(
              "In the challenge window",
              el("p", { className: "muted", text: "Anyone can still prove these batches wrong." }),
              el(
                "div",
                { className: "grid cards" },
                openBatches.map((batch) => {
                  const { fraction, left } = windowState(batch);
                  return el(
                    "a",
                    { className: "card lift window-card", href: `#/batches/${batch.index}` },
                    [
                      el("div", { className: "row" }, [
                        el("span", { className: "title", text: `Batch ${batch.index}` }),
                        pill(...lookup(VERDICT, batch.verdict)),
                      ]),
                      progressBar(
                        fraction,
                        `Challenge window ${Math.round(fraction * 100)}% elapsed`,
                        "window",
                      ),
                      el("div", { className: "row" }, [
                        el("span", {
                          className: "meta",
                          text: `entries ${batch.entries.from}–${batch.entries.to}`,
                        }),
                        el("span", {
                          className: "meta",
                          text: left > 0 ? `${duration(left)} left` : "finalizing",
                        }),
                      ]),
                    ],
                  );
                }),
              ),
            )
          : null,
        el("div", { className: "split wide-left" }, [
          section(
            "Latest batches",
            el("a", { href: "#/batches", text: "All batches" }),
            batchTable(data.rollup.batches.slice(0, 6), "Latest batches", true),
          ),
          section(
            "Live inbox",
            el("a", { href: "#/accounts", text: "Accounts" }),
            entryFeed(data.entries.slice(0, 6)),
          ),
        ]),
        section(
          "How it works",
          null,
          el("div", { className: "grid cards steps" }, [
            el("div", { className: "card" }, [
              el("h3", { text: "Use the rollup" }),
              el("p", {
                text: "Deposit QOR from the base chain, send it between rollup accounts, and withdraw it again. Transactions are signed with post-quantum keys.",
              }),
            ]),
            el("div", { className: "card" }, [
              el("h3", { text: "Batches settle on QoreChain" }),
              el("p", {
                text: "A bonded submitter groups transactions into a batch and posts its result to the base chain with an ML-DSA-87 signature.",
              }),
            ]),
            el("div", { className: "card" }, [
              el("h3", { text: "The watchtower checks everything" }),
              el("p", {
                text: "It replays every batch independently. A wrong batch is challenged with a fraud proof inside the one-hour window, and the submitter loses its bond.",
              }),
            ]),
          ]),
        ),
        section(
          "Services",
          el("p", { className: "muted", text: "Last time each service finished a round." }),
          el(
            "ul",
            { className: "services" },
            data.services.length === 0
              ? [el("li", { className: "empty", text: "No service has reported yet." })]
              : data.services.map((service) => {
                  const running = service.ageSecs <= 180;
                  return el("li", { className: running ? "service up" : "service down" }, [
                    el("span", { className: running ? "pulse" : "dot-off" }),
                    el("span", { className: "title", text: service.service }),
                    el("span", {
                      className: "meta",
                      text: running
                        ? `active ${ago(service.lastSeen)}`
                        : `silent since ${ago(service.lastSeen)}`,
                    }),
                  ]);
                }),
          ),
        ),
      ]);
    },
  },

  batches: {
    title: "Batches",
    async load(param) {
      return param === undefined
        ? state.overview
        : api(`/api/batches/${encodeURIComponent(param)}`);
    },
    render(data, param) {
      if (param === undefined) {
        return el("div", { className: "stack" }, [
          el("div", { className: "page-head" }, [
            el("h1", { text: "Batches" }),
            el("p", {
              text: `Every batch submitted for rollup ${data.rollup.id}, with the watchtower's own verdict next to the chain's status. A batch can be challenged for ${duration(challengeWindow())} after it is submitted.`,
            }),
          ]),
          batchTable(data.rollup.batches, "All batches"),
        ]);
      }
      const b = data.batch;
      const [vk, vt] = lookup(VERDICT, b.verdict);
      const [sk, st] = lookup(STATUS, b.status);
      const rootRow = (label, claimed, expected) => [
        el("dt", { text: label }),
        el("dd", { className: "compare" }, [
          el("span", { className: "mono", text: claimed === "" ? "(none)" : claimed }),
          expected !== null && expected !== claimed
            ? el("span", {
                className: "reasons",
                text: `re-executed: ${expected === "" ? "(none)" : expected}`,
              })
            : null,
        ]),
      ];

      const judged = b.verdict === "valid" || b.verdict === "invalid";
      const window = windowState(b);
      const steps = [
        {
          title: "Submitted to QoreChain",
          detail: `${ago(b.submittedTime)} at height ${b.submittedAtHeight.toLocaleString("en-US")}`,
          state: "done",
        },
        {
          title: "Re-executed by the watchtower",
          detail: judged
            ? b.verdict === "valid"
              ? `every commitment matches · ${ago(b.checkedAt)}`
              : `mismatch: ${b.reasons.join(", ")}`
            : "waiting for the inbox data",
          state: b.verdict === "valid" ? "done" : b.verdict === "invalid" ? "bad" : "current",
        },
        {
          title: "Challenge window",
          detail:
            b.status === "rejected"
              ? "a fraud proof was upheld; the batch was rejected"
              : b.status === "finalized"
                ? "closed without a successful challenge"
                : `${duration(window.left)} left`,
          state: b.status === "rejected" ? "bad" : b.status === "finalized" ? "done" : "current",
          progress: b.status === "submitted" ? window.fraction : null,
        },
        {
          title: "Final",
          detail: b.finalizedAtHeight
            ? `at height ${b.finalizedAtHeight.toLocaleString("en-US")}`
            : "after the window closes",
          state: b.status === "finalized" ? "done" : "pending",
        },
        {
          title: "Receipt recorded on chain",
          detail: b.receipt
            ? "ML-DSA-87 anchor verified by VigilReceipts"
            : "recorded once the batch is final",
          state: b.receipt ? "done" : "pending",
          hash: b.receipt?.txHash,
        },
      ];

      return el("div", { className: "stack" }, [
        el("div", { className: "page-head" }, [
          el("p", {}, el("a", { href: "#/batches", text: "← All batches" })),
          el("h1", { text: `Batch ${b.index}` }),
          el("div", { className: "actions" }, [
            pill(vk, `Watchtower: ${vt}`),
            pill(sk, `Chain: ${st}`),
            b.receipt ? pill("info", "Receipt recorded") : pill("plain", "No receipt yet"),
          ]),
        ]),
        b.reasons.length > 0
          ? el("p", {
              className: "notice warn",
              text: `The watchtower's re-execution disagrees with this batch on: ${b.reasons.join(", ")}.`,
            })
          : null,
        el("div", { className: "split" }, [
          el("div", { className: "card" }, [
            el("h2", { text: "Settlement" }),
            el(
              "ol",
              { className: "stepper" },
              steps.map((step) =>
                el("li", { className: step.state }, [
                  el("span", { className: "step-dot", "aria-hidden": "true" }),
                  el("div", { className: "step-body" }, [
                    el("div", { className: "title", text: step.title }),
                    el("div", { className: "meta", text: step.detail }),
                    step.progress !== null && step.progress !== undefined
                      ? progressBar(
                          step.progress,
                          `Challenge window ${Math.round(step.progress * 100)}% elapsed`,
                          "window",
                        )
                      : null,
                    step.hash ? el("div", {}, copyable(step.hash)) : null,
                  ]),
                  el("span", { className: "visually-hidden", text: `(${step.state})` }),
                ]),
              ),
            ),
          ]),
          el("div", { className: "card" }, [
            el("h2", { text: "What the submitter claimed" }),
            el("dl", { className: "facts" }, [
              ...rootRow("State root", b.stateRoot, b.expectedStateRoot),
              ...rootRow("Withdrawals root", b.withdrawalsRoot, b.expectedWithdrawalsRoot),
              ...rootRow("Previous state root", b.prevStateRoot, null),
              ...rootRow("Data hash", b.dataHash, null),
              el("dt", { text: "Inbox entries" }),
              el("dd", { text: `${b.entries.from}–${b.entries.to}` }),
            ]),
          ]),
        ]),
        section(
          "Inbox entries in this batch",
          el("p", { className: "muted", text: "Decoded from the verified archive." }),
          data.entries.length === 0
            ? el("p", {
                className: "empty",
                text: "The entries of this batch are not archived yet.",
              })
            : el(
                "div",
                {
                  className: "table-wrap",
                  role: "region",
                  "aria-label": "Inbox entries",
                  tabindex: "0",
                },
                el("table", {}, [
                  el(
                    "thead",
                    {},
                    el(
                      "tr",
                      {},
                      ["Entry", "Type", "Amount", "From", "To", "Posted by"].map((h) =>
                        el("th", { scope: "col", text: h }),
                      ),
                    ),
                  ),
                  el(
                    "tbody",
                    {},
                    data.entries.map((entry) => {
                      const [kind, word] = lookup(ENTRY_KINDS, entry.kind);
                      const target = entry.to ?? entry.recipient;
                      return el("tr", {}, [
                        el("td", { className: "mono", text: `#${entry.sequence}` }),
                        el("td", {}, [
                          pill(kind, word),
                          entry.signatureValid === false
                            ? el("span", {
                                className: "reasons",
                                text: "invalid signature: ignored",
                              })
                            : null,
                        ]),
                        el("td", {
                          text: entry.amount === undefined ? "—" : `${qor(entry.amount)} QOR`,
                        }),
                        el(
                          "td",
                          {},
                          entry.from
                            ? el("a", {
                                className: "mono",
                                href: `#/accounts/${entry.from}`,
                                text: short(entry.from),
                              })
                            : document.createTextNode("—"),
                        ),
                        el(
                          "td",
                          {},
                          entry.to
                            ? el("a", {
                                className: "mono",
                                href: `#/accounts/${entry.to}`,
                                text: short(entry.to),
                              })
                            : el("span", {
                                className: "mono",
                                text: target ? short(target, 12, 6) : "—",
                                title: target,
                              }),
                        ),
                        el("td", {
                          className: "mono",
                          text: short(entry.poster, 14, 6),
                          title: entry.poster,
                        }),
                      ]);
                    }),
                  ),
                ]),
              ),
        ),
        data.rejectedClaims.length > 0
          ? section(
              "Rejected claims at this index",
              null,
              el("div", {}, [
                batchTable(data.rejectedClaims, "Rejected claims"),
                ...data.rejectedClaims
                  .filter((claim) => claim.rejection)
                  .map((claim) =>
                    el("p", {
                      className: "muted",
                      text:
                        `Fraud proof ${short(claim.rejection.txHash, 10, 6)} at height ${claim.rejection.height}: ` +
                        `challenger ${short(claim.rejection.challenger, 14, 6)}, submitter ${short(claim.rejection.submitter, 14, 6)}, ` +
                        `${Number(claim.rejection.slashedUqor) / 1e6} QOR slashed. ` +
                        (claim.rejection.seenLive
                          ? "This watchtower saw the claim before it was rejected."
                          : "Restored from chain events: this watchtower was not watching at the time."),
                    }),
                  ),
              ]),
            )
          : null,
      ]);
    },
  },

  accounts: {
    title: "Accounts",
    async load(param) {
      const [entries, account] = await Promise.all([
        api("/api/entries"),
        param && /^[0-9a-fA-F]{64}$/.test(param)
          ? api(`/api/accounts/${param}`)
          : Promise.resolve(null),
      ]);
      return { entries: entries.entries, account };
    },
    render(data, param) {
      const input = el("input", {
        id: "account-id",
        name: "id",
        required: true,
        autocomplete: "off",
        spellcheck: "false",
        placeholder: "64 hexadecimal characters",
        value: param ?? "",
        pattern: "[0-9a-fA-F]{64}",
      });
      const form = el(
        "form",
        {
          on: {
            submit: (event) => {
              event.preventDefault();
              location.hash = `#/accounts/${input.value.trim().toLowerCase()}`;
            },
          },
        },
        [
          el("div", { className: "field" }, [
            el("label", { for: "account-id", text: "Rollup account id" }),
            input,
            el("span", {
              className: "help",
              text: "An account id is the hash of an ML-DSA-44 public key. Balances are public.",
            }),
          ]),
          el("div", {}, el("button", { className: "button", type: "submit", text: "Look up" })),
        ],
      );
      const kinds = {
        deposit: "Deposit",
        transfer: "Transfer",
        withdrawal: "Withdrawal",
        memo: "Sealed memo",
        data: "Data",
      };
      return el("div", { className: "stack" }, [
        el("div", { className: "page-head" }, [
          el("h1", { text: "Accounts" }),
          el("p", {
            text: "Look up any rollup account. The balance is computed by replaying the verified inbox, not taken from anyone's word.",
          }),
        ]),
        el("div", { className: "split" }, [
          el("div", { className: "card" }, [el("h2", { text: "Find an account" }), form]),
          data.account
            ? el("div", { className: "card" }, [
                el("h2", { text: "Account" }),
                el(
                  "div",
                  { className: "balance" },
                  el("div", {}, [
                    el("span", { className: "amount", text: qor(data.account.balance) }),
                    el("span", { className: "unit", text: "QOR" }),
                  ]),
                ),
                el("dl", { className: "facts" }, [
                  el("dt", { text: "Account id" }),
                  el("dd", {}, copyable(data.account.accountId)),
                  el("dt", { text: "Transactions sent" }),
                  el("dd", { text: data.account.nonce }),
                  el("dt", { text: "As of inbox entry" }),
                  el("dd", { text: data.account.asOfEntry }),
                ]),
              ])
            : el("p", {
                className: "empty",
                text: param
                  ? "That is not a valid account id."
                  : "Enter an account id to see its balance.",
              }),
        ]),
        section(
          "Recent activity",
          el("p", { className: "muted", text: "The latest inbox entries." }),
          data.entries.length === 0
            ? el("p", { className: "empty", text: "Nothing has been posted yet." })
            : el(
                "ul",
                { className: "feed" },
                data.entries.slice(0, 20).map((entry) =>
                  el(
                    "li",
                    {},
                    el("div", { className: "row" }, [
                      el("span", {
                        className: "title",
                        text: `${kinds[entry.kind] ?? entry.kind}${entry.amount === undefined ? "" : ` of ${qor(entry.amount)} QOR`}`,
                      }),
                      el("span", {
                        className: "meta",
                        text: `entry ${entry.sequence} · height ${entry.height.toLocaleString("en-US")}`,
                      }),
                    ]),
                  ),
                ),
              ),
        ),
      ]);
    },
  },

  chain: {
    title: "Base chain",
    async load() {
      return state.overview;
    },
    render(data) {
      return el("div", { className: "stack" }, [
        el("div", { className: "page-head" }, [
          el("h1", { text: "Base chain" }),
          el("p", {
            text: "Vigil measures QoreChain itself: block production, block time against the documented value, and any change to upgrade plans, parameters and enabled features.",
          }),
        ]),
        el("div", { className: "grid cards" }, data.chain.map(networkCard)),
        section(
          "Detected changes",
          null,
          feed(data.chainEvents, "No changes detected since monitoring began.", "events"),
        ),
      ]);
    },
  },

  alerts: {
    title: "Alerts",
    async load() {
      return state.overview;
    },
    render(data) {
      return el("div", { className: "stack" }, [
        el("div", { className: "page-head" }, [
          el("h1", { text: "Watchtower alerts" }),
          el("p", {
            text: "Raised when re-execution disagrees with a batch, a challenge window is about to close, or the rollup stops batching.",
          }),
        ]),
        feed(data.alerts, "No alerts. Every batch judged so far is valid.", "alerts"),
      ]);
    },
  },

  wallet: {
    title: "Wallet",
    // Wallet data changes only through actions here, so it is not re-rendered while a form is in use.
    quiet: true,
    async load() {
      return state.session.signedIn ? api("/api/wallet") : null;
    },
    render(data) {
      const head = el("div", { className: "page-head" }, [
        el("h1", { text: "Wallet" }),
        el("p", { text: "Deposit, send, withdraw and attach encrypted memos on the rollup." }),
      ]);
      if (!state.session.console) {
        return el("div", { className: "stack" }, [
          head,
          el("p", {
            className: "notice",
            text: "This is the public, read-only site. Wallet actions are available in the operator console, which runs next to the rollup's own services. You can still look up any account under Accounts.",
          }),
        ]);
      }
      if (!state.session.signedIn) return el("div", { className: "stack" }, [head, signInCard()]);
      if (data.account === null) {
        return el("div", { className: "stack" }, [
          head,
          el("div", { className: "card" }, [
            el("h2", { text: "Create your rollup account" }),
            el("p", {
              className: "muted",
              text: "A rollup account is an ML-DSA-44 key pair. It is generated here and stored encrypted on the server.",
            }),
            el(
              "div",
              { className: "actions" },
              actionButton(
                "Create account",
                () => api("/api/wallet/account", {}),
                (r) => `Account ${short(r.accountId)} created`,
              ),
            ),
          ]),
        ]);
      }
      return el("div", { className: "stack" }, [
        head,
        el("div", { className: "card" }, [
          el("div", { className: "balance" }, [
            el("div", {}, [
              el("div", { className: "muted", text: "Rollup balance" }),
              el("span", { className: "amount", text: qor(data.account.balance) }),
              el("span", { className: "unit", text: "QOR" }),
            ]),
            el("dl", { className: "facts" }, [
              el("dt", { text: "Settled in a batch" }),
              el("dd", { text: `${qor(data.account.batchedBalance)} QOR` }),
              el("dt", { text: "On the base chain" }),
              el("dd", { text: `${qor(data.baseBalance)} QOR` }),
              el("dt", { text: "Rollup account" }),
              el("dd", {}, copyable(data.account.accountId)),
              el("dt", { text: "Base-chain address" }),
              el("dd", {}, copyable(data.baseAddress, short(data.baseAddress, 12, 6))),
            ]),
          ]),
        ]),
        el("div", { className: "split" }, [
          actionsCard(data),
          el("div", { className: "stack" }, [withdrawalsCard(data), memoKeyCard(data)]),
        ]),
        section(
          "Memos for you",
          el("p", { className: "muted", text: "Decrypted here with your ML-KEM-1024 key." }),
          data.memos.length === 0
            ? el("p", { className: "empty", text: "No memos yet." })
            : el(
                "ul",
                { className: "feed" },
                data.memos.map((memo) =>
                  el("li", {}, [
                    el("div", { className: "row" }, [
                      el("span", {
                        className: "title",
                        text:
                          memo.transfer === null
                            ? "Memo"
                            : `Memo with ${qor(memo.transfer.amount)} QOR`,
                      }),
                      memo.transfer === null
                        ? pill("plain", "No transfer linked")
                        : memo.transfer.verified
                          ? pill(
                              "good",
                              memo.transfer.paysThisAccount
                                ? "Signed transfer to you"
                                : "Signed transfer",
                            )
                          : pill(
                              "bad",
                              "Transfer not verified",
                              "The linked entry is not a signed transfer from the memo's sender. Do not treat it as payment.",
                            ),
                    ]),
                    el("p", { className: "memo-text", text: memo.text }),
                    el("p", {
                      className: "meta muted",
                      text: `entry ${memo.entry} · posted by ${short(memo.poster, 14, 6)}`,
                    }),
                  ]),
                ),
              ),
        ),
        section(
          "Activity",
          el("p", { className: "muted", text: "Base-chain transactions sent from this console." }),
          activityList(data.activity),
        ),
      ]);
    },
  },
};

const ACTIVITY = {
  deposit: "Deposit",
  transfer: "Transfer",
  withdraw: "Withdrawal",
  note: "Sealed memo",
  claim: "Withdrawal claimed",
  "submit-batch": "Batch submitted",
  "challenge-batch": "Fraud challenge",
  "resolve-challenge": "Challenge resolved",
  "register-kem-key": "Encryption key published",
  "create-rollup": "Rollup created",
  "bond-submitter": "Submitter bonded",
};

let showAllActivity = false;

function activityList(activity) {
  if (activity.length === 0) return el("p", { className: "empty", text: "Nothing sent yet." });
  const LIMIT = 6;
  const shown = showAllActivity ? activity : activity.slice(0, LIMIT);
  const list = el(
    "ul",
    { className: "feed" },
    shown.map((tx) =>
      el("li", {}, [
        el("div", { className: "row" }, [
          el("span", { className: "title" }, [
            pill(
              tx.status === "confirmed" ? "good" : tx.status === "failed" ? "bad" : "wait",
              tx.status,
            ),
            document.createTextNode(` ${ACTIVITY[tx.label] ?? tx.label}`),
          ]),
          el("time", { text: ago(tx.createdAt) }),
        ]),
        tx.hash ? el("p", {}, copyable(tx.hash)) : null,
        tx.error ? el("p", { className: "error", text: tx.error }) : null,
      ]),
    ),
  );
  if (activity.length <= LIMIT) return list;
  const toggle = el("button", {
    className: "button ghost small",
    type: "button",
    text: showAllActivity ? "Show fewer" : `Show all ${activity.length}`,
    "aria-expanded": String(showAllActivity),
    on: {
      click: () => {
        showAllActivity = !showAllActivity;
        void show(true);
      },
    },
  });
  return el("div", { className: "stack" }, [list, el("div", {}, toggle)]);
}

// ---------- wallet pieces ----------

/** A button that runs an action, shows progress, reports the result and refreshes the page. */
function actionButton(label, run, describe, className = "button") {
  const button = el("button", { className, type: "button", text: label });
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      const result = await run();
      toast("Done", describe(result));
      await show(true);
    } catch (error) {
      toast("That did not work", error.message, true);
      if (error.status === 401) await refreshSession();
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  });
  return button;
}

function field(id, label, attributes, help) {
  const input = el(attributes.rows ? "textarea" : "input", { id, name: id, ...attributes });
  return {
    input,
    node: el("div", { className: "field" }, [
      el("label", { for: id, text: label }),
      input,
      help ? el("span", { className: "help", text: help }) : null,
    ]),
  };
}

function actionForm(fields, label, send, describe) {
  const error = el("p", { className: "error", role: "alert" });
  const submit = el("button", { className: "button", type: "submit", text: label });
  const form = el("form", { novalidate: true }, [
    ...fields.map((f) => f.node),
    error,
    el("div", {}, submit),
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    const missing = fields.find((f) => f.input.required && f.input.value.trim() === "");
    if (missing) {
      error.textContent = "Fill in the required fields.";
      missing.input.focus();
      return;
    }
    submit.disabled = true;
    submit.setAttribute("aria-busy", "true");
    try {
      const result = await send();
      toast("Sent", describe(result));
      form.reset();
      await show(true);
    } catch (problem) {
      error.textContent = problem.message;
      if (problem.status === 401) await refreshSession();
    } finally {
      submit.disabled = false;
      submit.removeAttribute("aria-busy");
    }
  });
  return form;
}

let walletTab = "send";

function actionsCard(data) {
  const amountAttributes = {
    required: true,
    inputmode: "decimal",
    autocomplete: "off",
    placeholder: "0.00",
    pattern: "\\d+(\\.\\d{1,6})?",
  };
  const panels = {
    send: () => {
      const to = field("send-to", "To rollup account", {
        required: true,
        autocomplete: "off",
        spellcheck: "false",
        placeholder: "64 hexadecimal characters",
      });
      const amount = field(
        "send-amount",
        "Amount in QOR",
        amountAttributes,
        `Available: ${qor(data.account.balance)} QOR`,
      );
      const memo = field(
        "send-memo",
        "Private memo (optional)",
        { rows: 3, maxlength: 1500, placeholder: "Only the recipient can read this" },
        "Encrypted with ML-KEM-1024. The amount and the accounts stay public.",
      );
      const memoTo = field(
        "send-memo-to",
        "Memo recipient's base-chain address",
        { autocomplete: "off", spellcheck: "false", placeholder: "qor1…" },
        "Needed with a memo: the address whose published key encrypts it.",
      );
      return actionForm(
        [to, amount, memo, memoTo],
        "Send",
        () =>
          api("/api/wallet/transfer", {
            to: to.input.value,
            amount: amount.input.value,
            memo: memo.input.value,
            memoRecipient: memoTo.input.value,
          }),
        (r) =>
          `Transfer posted: ${short(r.hash)}${r.memoHash ? `, memo: ${short(r.memoHash)}` : ""}`,
      );
    },
    deposit: () => {
      const amount = field(
        "deposit-amount",
        "Amount in QOR",
        amountAttributes,
        `On the base chain: ${qor(data.baseBalance)} QOR. Smallest deposit: 1 QOR.`,
      );
      return actionForm(
        [amount],
        "Deposit",
        () => api("/api/wallet/deposit", { amount: amount.input.value }),
        (r) => `Deposit sent: ${short(r.hash)}`,
      );
    },
    withdraw: () => {
      const amount = field(
        "withdraw-amount",
        "Amount in QOR",
        amountAttributes,
        `Available: ${qor(data.account.balance)} QOR`,
      );
      const recipient = field(
        "withdraw-to",
        "To base-chain address (optional)",
        { autocomplete: "off", spellcheck: "false", placeholder: short(data.baseAddress, 12, 6) },
        "Leave empty to withdraw to your own address. It can be claimed about an hour after it is batched.",
      );
      return actionForm(
        [amount, recipient],
        "Withdraw",
        () =>
          api("/api/wallet/withdraw", {
            amount: amount.input.value,
            recipient: recipient.input.value,
          }),
        (r) => `Withdrawal posted: ${short(r.hash)}`,
      );
    },
  };
  const panel = el("div", { role: "tabpanel", id: "wallet-panel" });
  const tabs = el("div", {
    className: "segmented",
    role: "tablist",
    "aria-label": "Wallet actions",
  });
  const select = (name) => {
    walletTab = name;
    for (const button of tabs.children)
      button.setAttribute("aria-selected", String(button.dataset.tab === name));
    panel.replaceChildren(panels[name]());
  };
  for (const [name, label] of [
    ["send", "Send"],
    ["deposit", "Deposit"],
    ["withdraw", "Withdraw"],
  ]) {
    tabs.append(
      el("button", {
        type: "button",
        role: "tab",
        "data-tab": name,
        "aria-controls": "wallet-panel",
        text: label,
        on: { click: () => select(name) },
      }),
    );
  }
  select(walletTab);
  return el("div", { className: "card" }, [el("h2", { text: "Move funds" }), tabs, panel]);
}

function withdrawalsCard(data) {
  const claimable = data.withdrawals.filter((w) => w.claimable);
  return el("div", { className: "card" }, [
    el("div", { className: "card-head" }, [
      el("h2", { text: "Withdrawals" }),
      claimable.length > 0
        ? actionButton(
            `Claim ${claimable.length}`,
            () => api("/api/wallet/claim", {}),
            (r) =>
              r.failed.length > 0
                ? `Paid ${r.paid.length}, failed ${r.failed.length}: ${r.failed[0]}`
                : `Paid ${r.paid.length} withdrawal(s)`,
            "button small",
          )
        : null,
    ]),
    data.withdrawals.length === 0
      ? el("p", { className: "muted", text: "No withdrawals yet." })
      : el(
          "ul",
          { className: "feed" },
          data.withdrawals.map((w) =>
            el(
              "li",
              {},
              el("div", { className: "row" }, [
                el("span", { className: "title", text: `${qor(w.amount)} QOR` }),
                el("span", {}, [
                  el("a", { href: `#/batches/${w.batchIndex}`, text: `batch ${w.batchIndex}` }),
                  document.createTextNode(" "),
                  w.claimed
                    ? pill("good", "Paid")
                    : w.claimable
                      ? pill("wait", "Ready to claim")
                      : pill("plain", "Waiting for finality"),
                ]),
              ]),
            ),
          ),
        ),
  ]);
}

function memoKeyCard(data) {
  return el("div", { className: "card" }, [
    el("div", { className: "card-head" }, [
      el("h2", { text: "Encryption key" }),
      data.memoKeyPublished ? pill("good", "Published") : pill("wait", "Not published"),
    ]),
    el("p", {
      className: "muted",
      text: data.memoKeyPublished
        ? "Others can send you private memos at your base-chain address."
        : "Publish your ML-KEM-1024 key so others can send you private memos.",
    }),
    data.memoKeyPublished
      ? null
      : el(
          "div",
          { className: "actions" },
          actionButton(
            "Publish key",
            () => api("/api/wallet/memo-key", {}),
            (r) => `Key published: ${short(r.hash)}`,
            "button ghost",
          ),
        ),
  ]);
}

function signInCard() {
  const password = field("password", "Operator password", {
    type: "password",
    required: true,
    autocomplete: "current-password",
  });
  const error = el("p", { className: "error", role: "alert" });
  const submit = el("button", { className: "button", type: "submit", text: "Sign in" });
  const form = el("form", {}, [password.node, error, el("div", {}, submit)]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    submit.disabled = true;
    try {
      await api("/api/session", { password: password.input.value });
      await refreshSession();
      await show(true);
    } catch (problem) {
      error.textContent = problem.message;
      password.input.select();
    } finally {
      submit.disabled = false;
    }
  });
  return el("div", { className: "card" }, [
    el("h2", { text: "Sign in to the console" }),
    el("p", {
      className: "muted",
      text: "The console signs transactions with the rollup operator's account, so it is protected by a password.",
    }),
    form,
  ]);
}

// ---------- routing and refresh ----------

let current = { route: "", param: undefined };
let navigated = false;

views.learn = learnView({
  el,
  pill,
  latestBatch: () => state.overview?.rollup.batches[0],
});
views.docs = docsView({ el });
views.proof = proofView({ el, pill, overview: () => state.overview });
views.home = homeView({
  el,
  pill,
  verdictPill: (batch) => pill(...lookup(VERDICT, batch.verdict)),
  statusCell,
  countValue,
  ago,
  diagram,
  overview: () => state.overview,
});

function parseRoute() {
  const [, route = "home", param] = location.hash.split("/");
  return views[route] ? { route, param: param || undefined } : { route: "home", param: undefined };
}

async function refreshSession() {
  try {
    state.session = await api("/api/session");
  } catch {
    state.session = { console: false, signedIn: false };
  }
  $("sign-out").hidden = !state.session.signedIn;
}

async function refreshOverview() {
  try {
    state.overview = await api("/api/overview");
    setStatus(...overallStatus(state.overview));
    $("updated").textContent =
      ` Updated ${new Date(state.overview.generatedAt * 1000).toLocaleTimeString()}.`;
    return true;
  } catch {
    setStatus("warn", "Cannot reach the server");
    return false;
  }
}

/** Renders the current route. `force` re-renders even a page that is normally left alone. */
async function show(force = false) {
  const next = parseRoute();
  const changed = next.route !== current.route || next.param !== current.param;
  const view = views[next.route];
  if (!changed && !force) {
    if (view.quiet) return;
    // Never re-render under someone who is typing.
    const active = document.activeElement;
    if (active && $("view").contains(active) && /^(INPUT|TEXTAREA)$/.test(active.tagName)) return;
  }
  current = next;
  for (const link of $("tabs").querySelectorAll("a")) {
    if (link.dataset.route === next.route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  document.title = `${view.title} · Vigil Watchtower`;
  const main = $("view");
  // On a new page, say so if loading takes more than a moment.
  const placeholder = changed
    ? setTimeout(() => {
        main.replaceChildren(
          el(
            "div",
            {
              className: "skeleton",
              role: "status",
              "aria-label": `Loading ${view.title.toLowerCase()}`,
            },
            [
              el("span", { className: "sk sk-title" }),
              el("span", { className: "sk sk-line" }),
              el(
                "div",
                { className: "sk-grid" },
                [1, 2, 3].map(() => el("span", { className: "sk sk-card" })),
              ),
            ],
          ),
        );
      }, 250)
    : undefined;
  try {
    if (state.overview === null) await refreshOverview();
    const data = await view.load(next.param);
    clearTimeout(placeholder);
    if (data === null && next.route !== "wallet")
      throw new Error("No data yet. Is the watchtower running?");
    const scroll = window.scrollY;
    animateNumbers = changed;
    main.replaceChildren(view.render(data, next.param));
    animateNumbers = false;
    if (changed && !reducedMotion()) {
      main.classList.remove("enter");
      void main.offsetWidth;
      main.classList.add("enter");
    }
    if (changed) {
      window.scrollTo(0, 0);
      // Move focus to the new page only when the user navigated, not on the first load,
      // so the first Tab still reaches "Skip to content" and the menu.
      if (navigated) main.focus({ preventScroll: true });
      navigated = true;
    } else {
      window.scrollTo(0, scroll);
    }
  } catch (error) {
    clearTimeout(placeholder);
    main.replaceChildren(
      el("div", { className: "stack" }, [
        el("div", { className: "page-head" }, el("h1", { text: view.title })),
        el("p", {
          className: "notice warn",
          text: error.status === 404 ? "Nothing found here." : error.message,
        }),
      ]),
    );
  }
}

// ---------- theme ----------

const THEMES = ["system", "light", "dark"];
const THEME_ICONS = {
  system: "M3 5h18v11H3zM8 20h8M12 16v4",
  light:
    "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z",
  dark: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
};

function currentTheme() {
  try {
    const stored = localStorage.getItem("vigil-theme");
    return THEMES.includes(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("vigil-theme", theme);
  } catch {
    /* the choice still applies for this visit */
  }
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  const button = $("theme");
  button.setAttribute("aria-label", `Theme: ${theme}. Switch to ${next}.`);
  button.title = `Theme: ${theme}`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", THEME_ICONS[theme]);
  svg.append(path);
  button.replaceChildren(svg);
}

$("theme").addEventListener("click", () => {
  const theme = currentTheme();
  applyTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]);
});
applyTheme(currentTheme());

$("sign-out").addEventListener("click", async () => {
  try {
    await api("/api/session/logout", {});
  } finally {
    await refreshSession();
    await show(true);
  }
});
window.addEventListener("hashchange", () => show());

await refreshSession();
await refreshOverview();
await show(true);
setInterval(async () => {
  if (document.hidden) return;
  if (await refreshOverview()) await show();
}, REFRESH_MS);
