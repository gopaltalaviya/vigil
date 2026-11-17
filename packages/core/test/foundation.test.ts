import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { QledgerLedger } from "@qorechain/rdk";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  IntegrityError,
  Store,
  StoreError,
  bytesEqual,
  createLogger,
  fromHex,
  loadConfig,
  normalizeHex,
  redactUrl,
  restoreLedger,
  serializeLedger,
  toHex,
} from "../src/index.js";

describe("config", () => {
  it("applies safe defaults for the public testnet", () => {
    const config = loadConfig({ ROLLUP_ID: "vigil-1" });
    expect(config.mode).toBe("shared");
    expect(config.chainId).toBe("qorechain-diana");
    expect(config.restUrl).toBe("https://api-testnet.qore.host");
    expect(config.secrets.mnemonic).toBeUndefined();
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("treats empty strings as unset", () => {
    const config = loadConfig({ ROLLUP_ID: "vigil-1", QORE_MNEMONIC: "", ALERT_WEBHOOK_URL: " " });
    expect(config.secrets.mnemonic).toBeUndefined();
    expect(config.alerts.webhookUrl).toBeUndefined();
  });

  it("names the invalid variables without echoing their values", () => {
    const attempt = () =>
      loadConfig({
        ROLLUP_ID: "Not A Rollup",
        QORE_REST_URL: "ftp://example.org",
        QORE_PQC_SEED_HEX: "do-not-print-me",
        HTTP_TIMEOUT_MS: "5",
      });
    expect(attempt).toThrow(ConfigError);
    try {
      attempt();
    } catch (error) {
      const text = JSON.stringify([(error as ConfigError).message, (error as ConfigError).details]);
      expect(text).toContain("ROLLUP_ID");
      expect(text).toContain("QORE_REST_URL");
      expect(text).toContain("QORE_PQC_SEED_HEX");
      expect(text).toContain("HTTP_TIMEOUT_MS");
      expect(text).not.toContain("do-not-print-me");
      expect(text).not.toContain("Not A Rollup");
    }
  });

  it("requires a rollup id", () => {
    expect(() => loadConfig({})).toThrow(/ROLLUP_ID/);
  });
});

describe("logger", () => {
  it("redacts secret fields at the top level and one level down", () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const log = createLogger({ service: "test", destination });
    const config = loadConfig({
      ROLLUP_ID: "vigil-1",
      QORE_MNEMONIC: "alpha beta gamma",
      TELEGRAM_BOT_TOKEN: "123:token",
    });
    log.info({ config, mnemonic: "alpha beta gamma", wallet: { secretKey: "aa" } }, "started");

    const output = lines.join("");
    expect(output).toContain('"service":"test"');
    expect(output).toContain("[redacted]");
    expect(output).not.toContain("alpha beta gamma");
    expect(output).not.toContain("123:token");
    expect(output).not.toContain('"secretKey":"aa"');
  });
});

describe("hex and url helpers", () => {
  it("round-trips bytes and normalises prefixes and case", () => {
    expect(toHex(fromHex("0xAbCd"))).toBe("abcd");
    expect(normalizeHex("ABCD")).toBe(normalizeHex("0xabcd"));
    expect(fromHex("")).toHaveLength(0);
  });

  it("rejects malformed hex", () => {
    expect(() => fromHex("abc")).toThrow(IntegrityError);
    expect(() => fromHex("zz")).toThrow(IntegrityError);
  });

  it("compares byte strings by content", () => {
    expect(bytesEqual(fromHex("0102"), fromHex("0102"))).toBe(true);
    expect(bytesEqual(fromHex("0102"), fromHex("0103"))).toBe(false);
    expect(bytesEqual(fromHex("01"), fromHex("0102"))).toBe(false);
  });

  it("drops query strings and credentials from logged URLs", () => {
    expect(redactUrl("https://user:pw@host.example/path?token=abc")).toBe(
      "https://host.example/path",
    );
    expect(redactUrl("https://api.example/bot123:secret/sendMessage")).toBe(
      "https://api.example/bot[redacted]/sendMessage",
    );
    expect(redactUrl("not a url")).toBe("<invalid url>");
  });
});

describe("store", () => {
  const entry = (sequence: number) => ({
    sequence,
    height: 100 + sequence,
    poster: "qor1poster",
    payload: new Uint8Array([sequence, 2, 3]),
    acc: "aa".repeat(32),
  });
  const batch = {
    batchIndex: 0,
    stateRoot: "11".repeat(32),
    prevStateRoot: "00".repeat(32),
    dataHash: "22".repeat(32),
    withdrawalsRoot: "",
    inboxStart: 0,
    inboxEnd: 2,
    txCount: 2,
    status: "submitted",
    submittedAt: 10,
    submittedTime: 1_000,
    finalizedAt: 0,
  };

  it("persists across reopen and reports its schema version", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigil-store-"));
    try {
      const path = join(dir, "nested", "vigil.sqlite");
      const first = Store.open(path);
      first.appendInboxEntries("r1", [entry(1), entry(2)]);
      first.close();

      const second = Store.open(path);
      expect(second.schemaVersion).toBe(1);
      expect(second.inboxRange("r1", 0, 2).map((e) => e.sequence)).toEqual([1, 2]);
      expect(second.inboxEntry("r1", 2)?.payload).toEqual(new Uint8Array([2, 2, 3]));
      expect(second.inboxEntry("r1", 3)).toBeUndefined();
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects out-of-order appends and rolls the whole write back", () => {
    const store = Store.open(":memory:");
    expect(() => {
      store.appendInboxEntries("r1", [entry(1), entry(3)]);
    }).toThrow(StoreError);
    expect(store.lastInboxEntry("r1")).toBeUndefined();
  });

  it("keeps inboxes of different rollups apart", () => {
    const store = Store.open(":memory:");
    store.appendInboxEntries("r1", [entry(1)]);
    store.appendInboxEntries("r2", [entry(1)]);
    expect(store.lastInboxEntry("r1")?.sequence).toBe(1);
    expect(store.inboxRange("r3", 0, 9)).toEqual([]);
  });

  it("tracks a batch through status changes and keeps competing batches at one index", () => {
    const store = Store.open(":memory:");
    store.upsertBatch("r1", batch);
    store.upsertBatch("r1", { ...batch, status: "finalized", finalizedAt: 99 });
    store.upsertBatch("r1", { ...batch, stateRoot: "33".repeat(32), submittedAt: 20 });

    const stored = store.batches("r1");
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ status: "finalized", finalizedAt: 99 });
    expect(stored[1]?.stateRoot).toBe("33".repeat(32));
  });

  it("stores and replaces verdicts", () => {
    const store = Store.open(":memory:");
    const verdict = {
      batchIndex: 0,
      stateRoot: batch.stateRoot,
      verdict: "invalid" as const,
      expectedStateRoot: "44".repeat(32),
      expectedWithdrawalsRoot: "",
      reasons: ["state_root"],
      checkedAt: 5,
    };
    store.saveVerdict("r1", verdict);
    expect(store.verdict("r1", 0, batch.stateRoot)).toEqual(verdict);
    store.saveVerdict("r1", { ...verdict, verdict: "valid", reasons: [] });
    expect(store.verdict("r1", 0, batch.stateRoot)?.verdict).toBe("valid");
    expect(store.verdict("r1", 1, batch.stateRoot)).toBeUndefined();
  });

  it("returns the newest snapshot at or before a position", () => {
    const store = Store.open(":memory:");
    store.saveSnapshot("r1", { inboxSequence: 4, stateRoot: "a", accounts: "{}" });
    store.saveSnapshot("r1", { inboxSequence: 9, stateRoot: "b", accounts: "{}" });
    expect(store.latestSnapshot("r1", 8)?.stateRoot).toBe("a");
    expect(store.latestSnapshot("r1", 9)?.stateRoot).toBe("b");
    expect(store.latestSnapshot("r1", 3)).toBeUndefined();
  });

  it("records each alert key once and tracks delivery", () => {
    const store = Store.open(":memory:");
    const alert = {
      key: "invalid:r1:0",
      severity: "critical" as const,
      title: "Invalid batch",
      body: "details",
      createdAt: 7,
    };
    const first = store.recordAlert(alert);
    expect(first?.id).toBe(1);
    expect(store.recordAlert(alert)).toBeUndefined();
    store.recordAlert({ ...alert, key: "stalled:r1:4", severity: "warning" });

    expect(store.undeliveredAlerts().map((a) => a.key)).toEqual(["invalid:r1:0", "stalled:r1:4"]);
    store.markAlertDelivered(1, 9);
    expect(store.undeliveredAlerts().map((a) => a.key)).toEqual(["stalled:r1:4"]);
    expect(store.recentAlerts(5)[1]).toMatchObject({ key: "invalid:r1:0", deliveredAt: 9 });
  });

  it("refuses a path it cannot open", () => {
    expect(() => Store.open(join(tmpdir(), "\0bad", "x.sqlite"))).toThrow(StoreError);
  });
});

describe("ledger snapshots", () => {
  it("restores an identical ledger", () => {
    const ledger = new QledgerLedger();
    ledger.set(fromHex("01".repeat(32)), 5_000_000n, 3n);
    ledger.set(fromHex("02".repeat(32)), 18_446_744_073_709_551_615n, 0n);
    const snapshot = serializeLedger(ledger);
    expect(toHex(restoreLedger(snapshot).root())).toBe(snapshot.stateRoot);
  });

  it("refuses a snapshot whose contents were changed", () => {
    const ledger = new QledgerLedger();
    ledger.set(fromHex("01".repeat(32)), 5n, 0n);
    const snapshot = serializeLedger(ledger);
    const tampered = { ...snapshot, accounts: snapshot.accounts.replace('"5"', '"6"') };
    expect(() => restoreLedger(tampered)).toThrow(/does not match its recorded state root/);
  });

  it("refuses malformed snapshots", () => {
    expect(() => restoreLedger({ stateRoot: "", accounts: "not json" })).toThrow(IntegrityError);
    expect(() => restoreLedger({ stateRoot: "", accounts: '{"version":2}' })).toThrow(
      IntegrityError,
    );
    expect(() =>
      restoreLedger({
        stateRoot: "",
        accounts: '{"version":1,"accounts":[{"id":"xyz","balance":"1","nonce":"0"}]}',
      }),
    ).toThrow(IntegrityError);
  });
});
