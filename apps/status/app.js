// Status page logic. No dependencies; every value is written with textContent,
// so nothing read from the chain can inject markup.
"use strict";

const REFRESH_MS = 15_000;
const $ = (id) => document.getElementById(id);

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.title) node.title = options.title;
  for (const child of children) node.append(child);
  return node;
}

function ago(unixSeconds) {
  if (!unixSeconds) return "never";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

const short = (hex, size = 10) =>
  hex.length > size * 2 ? `${hex.slice(0, size)}…${hex.slice(-6)}` : hex;
const pill = (kind, text) => el("span", { className: `pill ${kind}`, text });

const VERDICT = {
  valid: ["good", "Valid"],
  invalid: ["bad", "Invalid"],
  undecidable: ["wait", "Waiting for data"],
  pending: ["plain", "Not judged yet"],
};
const STATUS = {
  finalized: ["good", "Finalized"],
  submitted: ["wait", "In challenge window"],
  challenged: ["bad", "Challenged"],
  rejected: ["bad", "Rejected"],
};

function setState(kind, text) {
  $("state").className = `state ${kind}`;
  $("state-text").textContent = text;
}

function renderTiles(summary, rollup) {
  const tiles = [
    ["Batches checked", summary.valid + summary.invalid, `of ${summary.batches} seen`],
    ["Judged valid", summary.valid, "re-executed from the inbox"],
    ["Judged invalid", summary.invalid, summary.invalid === 0 ? "none so far" : "see alerts"],
    ["Finalized", summary.finalized, "past the challenge window"],
    ["Receipts on chain", summary.receiptsRecorded, "verified by the contract"],
    ["Inbox entries", rollup.inboxEntriesArchived, "in the verified archive"],
  ];
  $("tiles").replaceChildren(
    ...tiles.map(([label, value, hint]) =>
      el("div", { className: "tile" }, [
        el("div", { className: "label", text: label }),
        el("div", { className: "value", text: value }),
        el("div", { className: "hint", text: hint }),
      ]),
    ),
  );
}

function renderBatches(rollup) {
  $("rollup-meta").textContent = `Rollup ${rollup.id} on ${rollup.chainId}`;
  $("batches-empty").hidden = rollup.batches.length > 0;
  $("batches").replaceChildren(
    ...rollup.batches.map((batch) => {
      const [verdictKind, verdictText] = VERDICT[batch.verdict] ?? ["plain", batch.verdict];
      const [statusKind, statusText] = STATUS[batch.status] ?? ["plain", batch.status];
      const verdict = pill(verdictKind, verdictText);
      if (batch.reasons.length > 0) verdict.title = `Mismatch: ${batch.reasons.join(", ")}`;
      const receipt = batch.receipt
        ? pill("good", "Recorded")
        : pill("plain", batch.status === "rejected" ? "None" : "Not yet");
      if (batch.receipt?.txHash) receipt.title = `Transaction ${batch.receipt.txHash}`;
      return el("tr", {}, [
        el("td", { className: "mono", text: `#${batch.index}` }),
        el("td", {}, [verdict]),
        el("td", {}, [pill(statusKind, statusText)]),
        el("td", { text: `${batch.entries.from}–${batch.entries.to}` }),
        el("td", { className: "mono", text: short(batch.stateRoot), title: batch.stateRoot }),
        el("td", {}, [receipt]),
        el("td", { className: "muted", text: ago(batch.submittedTime) }),
      ]);
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

function renderChain(chain) {
  $("chain").replaceChildren(
    ...chain.map((network) => {
      const tip = network.tip;
      const state =
        !tip || !network.tipAvailable
          ? pill("plain", "No data")
          : tip.halted
            ? pill("bad", "Halted")
            : pill("good", "Producing blocks");
      const rows = [
        ["Height", tip ? tip.height.toLocaleString("en-US") : "—"],
        ["Last block", tip ? ago(tip.tipTime) : "—"],
        [
          "Measured block time",
          tip && tip.measuredBlockTimeSecs !== null ? `${tip.measuredBlockTimeSecs} s` : "—",
        ],
        ["Checked", ago(network.checkedAt)],
      ];
      return el("div", { className: "card" }, [
        el("div", { className: "card-head" }, [el("h3", { text: network.network }), state]),
        el(
          "dl",
          {},
          rows.flatMap(([term, value]) => [el("dt", { text: term }), el("dd", { text: value })]),
        ),
        el(
          "div",
          { className: "sources" },
          network.sources.map((source) => {
            const item = pill(
              source.available ? "plain" : "wait",
              SOURCE_LABELS[source.source] ?? source.source,
            );
            item.title = source.available
              ? `Last changed ${ago(source.changedAt)}; checked ${ago(source.checkedAt)}`
              : "Could not be read on the last check";
            return item;
          }),
        ),
      ]);
    }),
  );
}

function renderFeed(listId, emptyId, items) {
  $(emptyId).hidden = items.length > 0;
  $(listId).replaceChildren(
    ...items.map((item) =>
      el("li", { className: item.severity }, [
        el("div", { className: "title" }, [
          el("span", { text: item.title }),
          el("time", { text: ago(item.createdAt) }),
        ]),
        el("pre", { text: item.detail ?? item.body ?? "" }),
      ]),
    ),
  );
}

function overallState(data) {
  const invalidOpen = data.rollup.batches.some(
    (b) => b.verdict === "invalid" && b.status !== "rejected",
  );
  if (invalidOpen) return ["bad", "Invalid batch detected"];
  const halted = data.chain.some((c) => c.network === "testnet" && c.tip?.halted);
  if (halted) return ["warn", "Base chain halted"];
  const stale = Math.floor(Date.now() / 1000) - data.generatedAt > 120;
  if (stale) return ["warn", "Data is stale"];
  return ["ok", "On duty"];
}

async function refresh() {
  try {
    const response = await fetch("/api/overview", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    renderTiles(data.rollup.summary, data.rollup);
    renderBatches(data.rollup);
    renderChain(data.chain);
    renderFeed("alerts", "alerts-empty", data.alerts);
    renderFeed("events", "events-empty", data.chainEvents);
    setState(...overallState(data));
    $("updated").textContent =
      ` Updated ${new Date(data.generatedAt * 1000).toLocaleTimeString()}.`;
  } catch {
    setState("warn", "Cannot reach the status service");
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
