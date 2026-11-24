// The Rollups page: independent audits of other teams' rollups. Read-only and
// alert-only. Vigil never challenges a rollup it does not operate.

const STATUS = {
  clean: ["good", "All batches match"],
  fraud_found: ["bad", "Provable fraud"],
  not_judgeable: ["plain", "Not judgeable"],
  error: ["wait", "Could not read"],
};

export function rollupsView({ el, pill, api, ago, short }) {
  const finding = (audit, item) =>
    el("li", {}, [
      el("strong", { text: `Batch ${item.batchIndex}` }),
      document.createTextNode(
        ` (${item.status}): ${item.reasons.join(", ")}. ` +
          (item.proven
            ? "The chain's own fraud check, run locally, confirms it."
            : "Differs from re-execution; the fraud check does not confirm it."),
      ),
      el("div", {
        className: "mono muted",
        text: item.reasons.includes("withdrawals_root")
          ? `withdrawals root: claimed ${short(item.claimedWithdrawalsRoot)}, re-executed ${short(item.expectedWithdrawalsRoot)}`
          : `state root: claimed ${short(item.claimedStateRoot)}, re-executed ${short(item.expectedStateRoot)}`,
      }),
    ]);

  const row = (audit) => {
    const [tone, label] = STATUS[audit.status] ?? ["plain", audit.status];
    return el("article", { className: `proof-card status-${audit.status}` }, [
      el("div", { className: "proof-top" }, [pill(tone, label)]),
      el("h2", { className: "mono", text: audit.rollupId }),
      el("p", {
        className: "muted",
        text:
          `${audit.vm}, ${audit.settlement}, ${audit.chainStatus}. ` +
          (audit.status === "clean" || audit.status === "fraud_found"
            ? `${audit.matched} of ${audit.batches} batches match re-execution. `
            : `${audit.reason}. `) +
          `Checked ${ago(audit.checkedAt)}.`,
      }),
      audit.findings.length > 0
        ? el(
            "ul",
            {},
            audit.findings.map((item) => finding(audit, item)),
          )
        : null,
    ]);
  };

  return {
    title: "Rollups",
    load: () => api("/api/rollups"),
    render(data) {
      return el("div", {}, [
        el("h1", { text: "Other rollups" }),
        el("p", {
          text: "This watchtower re-executes every qledger-v1 rollup on the testnet from its first batch. It only reports what it finds: it holds no bond for these rollups and has no code path that challenges them.",
        }),
        data.audits.length === 0
          ? el("p", { className: "empty", text: "No audit has finished yet." })
          : el("div", { className: "proof-grid" }, data.audits.map(row)),
      ]);
    },
  };
}
