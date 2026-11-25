// "Verify on chain": the browser asks VigilReceipts itself, over QoreChain's public EVM
// endpoint, whether a settlement receipt is recorded. Nothing goes through this site's
// server, so the answer does not depend on trusting it. Works the same in the static mirror.

export const EVM_RPC = "https://evm-testnet.qore.host";

/** keccak256("isAnchorRecorded(address,(string,string,uint64,bytes32,bytes,uint64))")[0..4] */
const IS_ANCHOR_RECORDED = "831bc728";

const word = (hex) => hex.padStart(64, "0");
const uint = (value) => word(BigInt(value).toString(16));
const strip = (hex) => hex.replace(/^0x/, "").toLowerCase();

/** ABI encoding of dynamic bytes: length word, then the data padded to whole words. */
function dynamic(hex) {
  const data = strip(hex);
  const padded = data.padEnd(Math.ceil(data.length / 64) * 64, "0");
  return uint(data.length / 2) + padded;
}

const utf8Hex = (text) =>
  [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Calldata of `isAnchorRecorded(signer, receipt)`. `receipt` is the dynamic tuple
 * (chainId, layerId, layerHeight, stateRoot, validatorSetHash, txCount).
 */
export function encodeIsAnchorRecorded(call) {
  const chainId = dynamic(utf8Hex(call.chainId));
  const layerId = dynamic(utf8Hex(call.layerId));
  const vsh = dynamic(call.validatorSetHash);
  const head = 6 * 32;
  const offChain = head;
  const offLayer = offChain + chainId.length / 2;
  const offVsh = offLayer + layerId.length / 2;
  const tuple =
    uint(offChain) +
    uint(offLayer) +
    uint(call.layerHeight) +
    word(strip(call.stateRoot)) +
    uint(offVsh) +
    uint(call.txCount) +
    chainId +
    layerId +
    vsh;
  return `0x${IS_ANCHOR_RECORDED}${word(strip(call.signer))}${uint(64)}${tuple}`;
}

/** The same call with one hex digit of the state root changed (the last one). */
export function withOneDigitChanged(call) {
  const root = strip(call.stateRoot);
  const last = root.at(-1);
  const changed = last === "0" ? "1" : "0";
  return { ...call, stateRoot: `0x${root.slice(0, -1)}${changed}` };
}

/** Sends `eth_call` to the public EVM endpoint; resolves to the contract's boolean answer. */
export async function askContract(contract, call, fetchImpl = fetch) {
  const response = await fetchImpl(EVM_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: contract, data: encodeIsAnchorRecorded(call) }, "latest"],
    }),
  });
  if (!response.ok) throw new Error(`the EVM endpoint answered HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message ?? "the call failed");
  if (typeof body.result !== "string" || !/^0x[0-9a-f]{64}$/i.test(body.result)) {
    throw new Error("unexpected answer from the contract");
  }
  return BigInt(body.result) === 1n;
}

/**
 * Answers by panel id. Pages re-render while the chain moves, so a panel built again for the
 * same receipt shows the answer (or the pending question) its visitor already asked for.
 */
const answers = new Map();

/** A small panel: a button that asks the contract, and a toggle that changes one digit first. */
export function verifyPanel({ el, pill }, contract, call) {
  const id = `tamper-${call.layerId}-${call.layerHeight}`;
  const result = el("p", { className: "onchain-result", "aria-live": "polite" });
  const toggle = el("input", { type: "checkbox", id, className: "onchain-tamper" });
  const sent = el("code", { className: "onchain-root mono" });
  const button = el("button", {
    type: "button",
    className: "button onchain-verify",
    text: "Verify on chain",
  });
  const show = (entry) => {
    toggle.checked = entry.tamper;
    sent.textContent = entry.sent;
    if (entry.outcome === undefined) {
      button.disabled = true;
      result.replaceChildren(document.createTextNode("Asking VigilReceipts…"));
      delete result.dataset.answer;
      return;
    }
    button.disabled = false;
    if (entry.outcome.error !== undefined) {
      result.replaceChildren(pill("wait", "Could not ask the chain"), ` ${entry.outcome.error}`);
      result.dataset.answer = "error";
      return;
    }
    const recorded = entry.outcome.recorded;
    result.replaceChildren(
      recorded
        ? pill("good", "Recorded on chain")
        : pill("bad", "Not recorded: no receipt matches these fields"),
      document.createTextNode(
        ` isAnchorRecorded returned ${recorded}, answered by ${new URL(EVM_RPC).host}.`,
      ),
    );
    result.dataset.answer = String(recorded);
  };
  // Show the latest state of this panel's question on whichever copy of the panel is on the page.
  const follow = (entry) => {
    if (entry.outcome === undefined) {
      entry.done.then(() => {
        if (answers.get(id) === entry && result.isConnected) show(entry);
      });
    }
    show(entry);
  };
  const run = () => {
    const asked = toggle.checked ? withOneDigitChanged(call) : call;
    const entry = {
      tamper: toggle.checked,
      sent: `state root sent: ${strip(asked.stateRoot).slice(0, 10)}…${strip(asked.stateRoot).slice(-6)}`,
      outcome: undefined,
    };
    entry.done = askContract(contract, asked).then(
      (recorded) => {
        entry.outcome = { recorded };
      },
      (error) => {
        entry.outcome = { error: error.message };
      },
    );
    answers.set(id, entry);
    follow(entry);
  };
  button.addEventListener("click", run);
  toggle.addEventListener("change", () => {
    answers.delete(id);
    sent.textContent = "";
    result.replaceChildren();
    delete result.dataset.answer;
  });
  const earlier = answers.get(id);
  if (earlier !== undefined) follow(earlier);
  return el("div", { className: "onchain" }, [
    el("p", {
      className: "muted",
      text: `Your browser calls isAnchorRecorded on VigilReceipts (${contract.slice(0, 8)}…${contract.slice(-6)}) directly, through QoreChain's public EVM endpoint.`,
    }),
    el("div", { className: "onchain-actions" }, [
      button,
      el("label", { for: id }, [toggle, document.createTextNode(" Change one digit")]),
    ]),
    sent,
    result,
  ]);
}
