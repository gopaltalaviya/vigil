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
  setTimeout(() => node.remove(), bad ? 12_000 : 8_000);
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

function batchTable(batches, caption) {
  if (batches.length === 0) return el("p", { className: "empty", text: "No batches yet." });
  const rows = batches.map((batch) => {
    const [vk, vt] = lookup(VERDICT, batch.verdict);
    const [sk, st] = lookup(STATUS, batch.status);
    const verdict = el("div", {}, [pill(vk, vt)]);
    if (batch.reasons.length > 0) {
      verdict.append(
        el("span", { className: "reasons", text: `Mismatch: ${batch.reasons.join(", ")}` }),
      );
    }
    return el("tr", { className: "link" }, [
      el("td", {}, el("a", { href: `#/batches/${batch.index}`, text: `Batch ${batch.index}` })),
      el("td", {}, verdict),
      el("td", {}, pill(sk, st)),
      el("td", { text: `${batch.entries.from}–${batch.entries.to}` }),
      el("td", { className: "mono", text: short(batch.stateRoot), title: batch.stateRoot }),
      el(
        "td",
        {},
        batch.receipt
          ? pill("good", "Recorded")
          : pill("plain", batch.status === "rejected" ? "None" : "Not yet"),
      ),
      el("td", { className: "muted", text: ago(batch.submittedTime) }),
    ]);
  });
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
            [
              "Batch",
              "Watchtower verdict",
              "Chain status",
              "Inbox entries",
              "State root",
              "Receipt",
              "Submitted",
            ].map((h) => el("th", { scope: "col", text: h })),
          ),
        ),
        el("tbody", {}, rows),
      ]),
    ],
  );
}

const SEVERITY = {
  critical: ["bad", "Critical"],
  warning: ["wait", "Warning"],
  info: ["plain", "Info"],
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
        : pill("good", "Producing blocks");
  const facts = [
    ["Height", tip ? tip.height.toLocaleString("en-US") : "—"],
    ["Last block", tip ? ago(tip.tipTime) : "—"],
    [
      "Measured block time",
      tip && tip.measuredBlockTimeSecs !== null ? `${tip.measuredBlockTimeSecs} s` : "—",
    ],
    ["Checked", ago(network.checkedAt)],
  ];
  return el("div", { className: "card" }, [
    el("div", { className: "card-head" }, [el("h3", { text: network.network }), badge]),
    el(
      "dl",
      { className: "facts" },
      facts.flatMap(([term, value]) => [el("dt", { text: term }), el("dd", { text: value })]),
    ),
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
    title: "Overview",
    async load() {
      return state.overview;
    },
    render(data) {
      const s = data.rollup.summary;
      const tiles = [
        ["Batches checked", s.valid + s.invalid, `of ${s.batches} seen`],
        ["Judged valid", s.valid, "re-executed from the inbox"],
        ["Judged invalid", s.invalid, s.invalid === 0 ? "none so far" : "see alerts"],
        ["Final", s.finalized, "past the challenge window"],
        ["Receipts on chain", s.receiptsRecorded, "verified by the contract"],
        ["Inbox entries", data.rollup.inboxEntriesArchived, "in the verified archive"],
      ];
      return el("div", { className: "stack" }, [
        el("section", { className: "hero" }, [
          el("h1", {}, [
            document.createTextNode("The rollup that "),
            el("em", { text: "never looks away." }),
          ]),
          el("p", {
            text: "Vigil is a post-quantum rollup on QoreChain. Every batch is signed with ML-DSA-87, and a watchtower re-executes each one from the inbox and compares it with what the submitter claimed.",
          }),
          el("div", { className: "actions" }, [
            el("a", { className: "button", href: "#/wallet", text: "Open wallet" }),
            el("a", { className: "button ghost", href: "#/batches", text: "Browse batches" }),
          ]),
        ]),
        el(
          "section",
          { "aria-label": "Summary" },
          el(
            "div",
            { className: "grid tiles" },
            tiles.map(([label, value, hint]) =>
              el("div", { className: "tile" }, [
                el("div", { className: "label", text: label }),
                el("div", { className: "value", text: value }),
                el("div", { className: "hint", text: hint }),
              ]),
            ),
          ),
        ),
        section(
          "Latest batches",
          el("a", { href: "#/batches", text: "All batches" }),
          batchTable(data.rollup.batches.slice(0, 5), "Latest batches"),
        ),
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
            "div",
            { className: "grid tiles" },
            data.services.length === 0
              ? [el("p", { className: "empty", text: "No service has reported yet." })]
              : data.services.map((service) =>
                  el("div", { className: "tile" }, [
                    el("div", { className: "label", text: service.service }),
                    el(
                      "div",
                      { className: "value" },
                      pill(
                        service.ageSecs > 180 ? "wait" : "good",
                        service.ageSecs > 180 ? "Silent" : "Running",
                      ),
                    ),
                    el("div", { className: "hint", text: `last seen ${ago(service.lastSeen)}` }),
                  ]),
                ),
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
              text: `Every batch submitted for rollup ${data.rollup.id}, with the watchtower's own verdict next to the chain's status.`,
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
      const kinds = {
        deposit: ["good", "Deposit"],
        transfer: ["plain", "Transfer"],
        withdrawal: ["wait", "Withdrawal"],
        memo: ["plain", "Sealed memo"],
        data: ["plain", "Data"],
      };
      return el("div", { className: "stack" }, [
        el("div", { className: "page-head" }, [
          el("p", {}, el("a", { href: "#/batches", text: "← All batches" })),
          el("h1", { text: `Batch ${b.index}` }),
          el("div", { className: "actions" }, [
            pill(vk, `Watchtower: ${vt}`),
            pill(sk, `Chain: ${st}`),
            b.receipt ? pill("good", "Receipt recorded") : pill("plain", "No receipt yet"),
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
            el("h2", { text: "What the submitter claimed" }),
            el("dl", { className: "facts" }, [
              ...rootRow("State root", b.stateRoot, b.expectedStateRoot),
              ...rootRow("Withdrawals root", b.withdrawalsRoot, b.expectedWithdrawalsRoot),
              ...rootRow("Previous state root", b.prevStateRoot, null),
              ...rootRow("Data hash", b.dataHash, null),
            ]),
          ]),
          el("div", { className: "card" }, [
            el("h2", { text: "Timeline" }),
            el("dl", { className: "facts" }, [
              el("dt", { text: "Inbox entries" }),
              el("dd", { text: `${b.entries.from}–${b.entries.to}` }),
              el("dt", { text: "Submitted" }),
              el("dd", {
                text: `${ago(b.submittedTime)} (height ${b.submittedAtHeight.toLocaleString("en-US")})`,
              }),
              el("dt", { text: "Final at height" }),
              el("dd", {
                text: b.finalizedAtHeight ? b.finalizedAtHeight.toLocaleString("en-US") : "not yet",
              }),
              el("dt", { text: "Re-executed" }),
              el("dd", { text: b.checkedAt ? ago(b.checkedAt) : "not yet" }),
              el("dt", { text: "Receipt transaction" }),
              el(
                "dd",
                {},
                b.receipt?.txHash
                  ? copyable(b.receipt.txHash)
                  : document.createTextNode(b.receipt ? "recorded" : "none"),
              ),
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
                      const [kind, word] = lookup(kinds, entry.kind);
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
              batchTable(data.rejectedClaims, "Rejected claims"),
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
          data.activity.length === 0
            ? el("p", { className: "empty", text: "Nothing sent yet." })
            : el(
                "ul",
                { className: "feed" },
                data.activity.map((tx) =>
                  el("li", {}, [
                    el("div", { className: "row" }, [
                      el("span", { className: "title" }, [
                        pill(
                          tx.status === "confirmed"
                            ? "good"
                            : tx.status === "failed"
                              ? "bad"
                              : "wait",
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
              ),
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

function parseRoute() {
  const [, route = "overview", param] = location.hash.split("/");
  return views[route]
    ? { route, param: param || undefined }
    : { route: "overview", param: undefined };
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
  document.title = `${view.title} · Vigil`;
  const main = $("view");
  try {
    if (state.overview === null) await refreshOverview();
    const data = await view.load(next.param);
    if (data === null && next.route !== "wallet")
      throw new Error("No data yet. Is the watchtower running?");
    const scroll = window.scrollY;
    main.replaceChildren(view.render(data, next.param));
    if (changed) {
      window.scrollTo(0, 0);
      main.focus({ preventScroll: true });
    } else {
      window.scrollTo(0, scroll);
    }
  } catch (error) {
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
