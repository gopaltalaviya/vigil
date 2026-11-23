import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { StoreError } from "./errors.js";

/** One inbox entry as archived locally, with the accumulator value after it. */
export interface StoredInboxEntry {
  sequence: number;
  height: number;
  poster: string;
  payload: Uint8Array;
  acc: string;
}

/** A batch as first seen on chain. A rejected batch and its replacement share an index. */
export interface StoredBatch {
  batchIndex: number;
  stateRoot: string;
  prevStateRoot: string;
  dataHash: string;
  withdrawalsRoot: string;
  inboxStart: number;
  inboxEnd: number;
  txCount: number;
  status: string;
  /** Height at which the batch was submitted. */
  submittedAt: number;
  /** Block time of the submission, Unix seconds; the challenge window starts here. */
  submittedTime: number;
  finalizedAt: number;
}

export type AlertSeverity = "info" | "warning" | "critical";

/** Something an operator should know about. `key` makes each condition alert only once. */
export interface StoredAlert {
  id: number;
  key: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  createdAt: number;
  deliveredAt: number | undefined;
}

/** One attempt to send a base-chain transaction. */
export interface StoredTx {
  id: number;
  label: string;
  status: "confirmed" | "failed" | "unconfirmed";
  hash: string | undefined;
  height: number | undefined;
  code: number | undefined;
  error: string | undefined;
  createdAt: number;
}

/** A withdrawal that has been paid out on the base chain. */
export interface StoredClaim {
  withdrawalIndex: number;
  batchIndex: number;
  txHash: string;
}

/** The latest answer of one monitored endpoint. */
export interface StoredSnapshotOfSource {
  network: string;
  source: string;
  hash: string;
  body: string;
  fetchedAt: number;
  /** When the content last changed. */
  changedAt: number;
  /** Whether the last fetch succeeded. */
  available: boolean;
}

/** Something the base-chain monitor observed. */
export interface StoredChainEvent {
  id: number;
  network: string;
  source: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  createdAt: number;
}

/** A settlement receipt recorded through the receipts contract. */
export interface StoredReceipt {
  batchIndex: number;
  /** State root the recorded anchor commits to; empty for records made before it was stored. */
  stateRoot: string;
  contract: string;
  txHash: string;
  recordedAt: number;
}

/**
 * Identity of one batch claim. A rejected batch and its replacement share an
 * index, and an honest batch and a forged one over the same entries can share
 * a state root, so nothing less than every committed field identifies a claim.
 */
export function claimId(batch: StoredBatch): string {
  return [
    batch.batchIndex,
    batch.prevStateRoot,
    batch.stateRoot,
    batch.withdrawalsRoot,
    batch.dataHash,
    batch.inboxStart,
    batch.inboxEnd,
    batch.submittedAt,
  ].join(":");
}

/** An upheld fraud proof, tied to the claim it rejected. */
export interface StoredFraudEvent {
  txHash: string;
  claimId: string;
  batchIndex: number;
  height: number;
  time: number;
  submitter: string;
  challenger: string;
  slashedUqor: string;
  rewardUqor: string;
  burnedUqor: string;
  /** Whether this watchtower had seen the claim before the chain rejected it. */
  seenLive: boolean;
}

/** Last sign of life of one service. */
export interface StoredHeartbeat {
  service: string;
  at: number;
  detail: string;
}

export type VerdictKind = "valid" | "invalid" | "undecidable";

/** The watchtower's judgement of one batch. */
export interface StoredVerdict {
  /** The claim this verdict is about; see `claimId`. */
  claimId: string;
  batchIndex: number;
  stateRoot: string;
  verdict: VerdictKind;
  expectedStateRoot: string;
  expectedWithdrawalsRoot: string;
  reasons: string[];
  checkedAt: number;
}

/** Serialised ledger state after a given inbox sequence. */
export interface StoredSnapshot {
  inboxSequence: number;
  stateRoot: string;
  accounts: string;
}

type Row = Record<string, SQLOutputValue>;

/** Ordered, append-only schema migrations. Never edit a published entry; add a new one. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE inbox_entries (
    rollup_id TEXT NOT NULL,
    sequence  INTEGER NOT NULL,
    height    INTEGER NOT NULL,
    poster    TEXT NOT NULL,
    payload   BLOB NOT NULL,
    acc       TEXT NOT NULL,
    PRIMARY KEY (rollup_id, sequence)
  ) STRICT;

  CREATE TABLE batches (
    rollup_id        TEXT NOT NULL,
    batch_index      INTEGER NOT NULL,
    state_root       TEXT NOT NULL,
    prev_state_root  TEXT NOT NULL,
    data_hash        TEXT NOT NULL,
    withdrawals_root TEXT NOT NULL,
    inbox_start      INTEGER NOT NULL,
    inbox_end        INTEGER NOT NULL,
    tx_count         INTEGER NOT NULL,
    status           TEXT NOT NULL,
    submitted_at     INTEGER NOT NULL,
    submitted_time   INTEGER NOT NULL,
    finalized_at     INTEGER NOT NULL,
    PRIMARY KEY (rollup_id, batch_index, state_root)
  ) STRICT;

  CREATE TABLE verdicts (
    rollup_id                 TEXT NOT NULL,
    batch_index               INTEGER NOT NULL,
    state_root                TEXT NOT NULL,
    verdict                   TEXT NOT NULL CHECK (verdict IN ('valid', 'invalid', 'undecidable')),
    expected_state_root       TEXT NOT NULL,
    expected_withdrawals_root TEXT NOT NULL,
    reasons                   TEXT NOT NULL,
    checked_at                INTEGER NOT NULL,
    PRIMARY KEY (rollup_id, batch_index, state_root)
  ) STRICT;

  CREATE TABLE snapshots (
    rollup_id      TEXT NOT NULL,
    inbox_sequence INTEGER NOT NULL,
    state_root     TEXT NOT NULL,
    accounts       TEXT NOT NULL,
    PRIMARY KEY (rollup_id, inbox_sequence)
  ) STRICT;

  CREATE TABLE alerts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    key          TEXT NOT NULL UNIQUE,
    severity     TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    title        TEXT NOT NULL,
    body         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    delivered_at INTEGER
  ) STRICT;

  CREATE TABLE tx_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    label      TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('confirmed', 'failed', 'unconfirmed')),
    hash       TEXT,
    height     INTEGER,
    code       INTEGER,
    error      TEXT,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE claims (
    rollup_id        TEXT NOT NULL,
    withdrawal_index INTEGER NOT NULL,
    batch_index      INTEGER NOT NULL,
    tx_hash          TEXT NOT NULL,
    PRIMARY KEY (rollup_id, withdrawal_index)
  ) STRICT;
  `,
  `
  CREATE TABLE monitor_snapshots (
    network    TEXT NOT NULL,
    source     TEXT NOT NULL,
    hash       TEXT NOT NULL,
    body       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    changed_at INTEGER NOT NULL,
    available  INTEGER NOT NULL,
    PRIMARY KEY (network, source)
  ) STRICT;

  CREATE TABLE chain_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    network    TEXT NOT NULL,
    source     TEXT NOT NULL,
    severity   TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    title      TEXT NOT NULL,
    detail     TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE receipts (
    rollup_id   TEXT NOT NULL,
    batch_index INTEGER NOT NULL,
    contract    TEXT NOT NULL,
    tx_hash     TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (rollup_id, batch_index, contract)
  ) STRICT;
  `,
  `
  CREATE TABLE batches_v3 (
    rollup_id        TEXT NOT NULL,
    claim_id         TEXT NOT NULL,
    batch_index      INTEGER NOT NULL,
    state_root       TEXT NOT NULL,
    prev_state_root  TEXT NOT NULL,
    data_hash        TEXT NOT NULL,
    withdrawals_root TEXT NOT NULL,
    inbox_start      INTEGER NOT NULL,
    inbox_end        INTEGER NOT NULL,
    tx_count         INTEGER NOT NULL,
    status           TEXT NOT NULL,
    submitted_at     INTEGER NOT NULL,
    submitted_time   INTEGER NOT NULL,
    finalized_at     INTEGER NOT NULL,
    PRIMARY KEY (rollup_id, claim_id)
  ) STRICT;

  INSERT INTO batches_v3
    SELECT rollup_id,
           batch_index || ':' || prev_state_root || ':' || state_root || ':' || withdrawals_root
             || ':' || data_hash || ':' || inbox_start || ':' || inbox_end || ':' || submitted_at,
           batch_index, state_root, prev_state_root, data_hash, withdrawals_root, inbox_start,
           inbox_end, tx_count, status, submitted_at, submitted_time, finalized_at
    FROM batches;
  DROP TABLE batches;
  ALTER TABLE batches_v3 RENAME TO batches;
  CREATE INDEX batches_by_index ON batches (rollup_id, batch_index, submitted_at);

  -- Verdicts were keyed too coarsely; every batch is judged again under its full identity.
  DROP TABLE verdicts;
  CREATE TABLE verdicts (
    rollup_id                 TEXT NOT NULL,
    claim_id                  TEXT NOT NULL,
    batch_index               INTEGER NOT NULL,
    state_root                TEXT NOT NULL,
    verdict                   TEXT NOT NULL CHECK (verdict IN ('valid', 'invalid', 'undecidable')),
    expected_state_root       TEXT NOT NULL,
    expected_withdrawals_root TEXT NOT NULL,
    reasons                   TEXT NOT NULL,
    checked_at                INTEGER NOT NULL,
    PRIMARY KEY (rollup_id, claim_id)
  ) STRICT;

  ALTER TABLE receipts ADD COLUMN state_root TEXT NOT NULL DEFAULT '';

  CREATE TABLE heartbeats (
    service TEXT PRIMARY KEY,
    at      INTEGER NOT NULL,
    detail  TEXT NOT NULL
  ) STRICT;
  `,
  `
  CREATE TABLE fraud_events (
    rollup_id    TEXT NOT NULL,
    tx_hash      TEXT NOT NULL,
    claim_id     TEXT NOT NULL,
    batch_index  INTEGER NOT NULL,
    height       INTEGER NOT NULL,
    time         INTEGER NOT NULL,
    submitter    TEXT NOT NULL,
    challenger   TEXT NOT NULL,
    slashed_uqor TEXT NOT NULL,
    reward_uqor  TEXT NOT NULL,
    burned_uqor  TEXT NOT NULL,
    seen_live    INTEGER NOT NULL,
    PRIMARY KEY (rollup_id, tx_hash, batch_index)
  ) STRICT;
  `,
];

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") throw new StoreError(`column ${key} is not text`);
  return value;
};

const int = (row: Row, key: string): number => {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new StoreError(`column ${key} is not a safe integer`);
  }
  return value;
};

const blob = (row: Row, key: string): Uint8Array => {
  const value = row[key];
  if (!(value instanceof Uint8Array)) throw new StoreError(`column ${key} is not a blob`);
  return new Uint8Array(value);
};

/**
 * Local SQLite database (WAL mode). All chain-derived state Vigil needs to
 * resume after a restart lives here; every multi-row write is one transaction.
 */
export class Store {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Opens (and creates or migrates) the database at `path`; `:memory:` for tests. */
  static open(path: string): Store {
    try {
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
      const db = new DatabaseSync(path);
      // The busy timeout comes first: several services open the same file at start-up, and
      // switching to WAL needs a lock another process may hold for a moment.
      db.exec("PRAGMA busy_timeout = 10000;");
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
      const store = new Store(db);
      store.migrate();
      return store;
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new StoreError("could not open the database", {}, { cause: error });
    }
  }

  close(): void {
    this.db.close();
  }

  /** Current schema version (number of migrations applied). */
  get schemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as Row | undefined;
    return row === undefined ? 0 : int(row, "user_version");
  }

  /** Runs `fn` inside a transaction; any throw rolls every write back. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // --- inbox archive -------------------------------------------------------

  /**
   * Appends entries in sequence order. Several services share one database and
   * may archive the same entries at the same moment, so an entry that is
   * already stored is accepted when it is identical and refused when it differs.
   */
  appendInboxEntries(rollupId: string, entries: readonly StoredInboxEntry[]): void {
    const insert = this.db.prepare(
      "INSERT INTO inbox_entries (rollup_id, sequence, height, poster, payload, acc) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.transaction(() => {
      let expected = (this.lastInboxEntry(rollupId)?.sequence ?? 0) + 1;
      for (const entry of entries) {
        if (entry.sequence < expected) {
          if (this.inboxEntry(rollupId, entry.sequence)?.acc !== entry.acc) {
            throw new StoreError("an inbox entry differs from the one already archived", {
              sequence: entry.sequence,
            });
          }
          continue;
        }
        if (entry.sequence !== expected) {
          throw new StoreError("inbox entries must be appended in sequence order", {
            expected,
            got: entry.sequence,
          });
        }
        insert.run(rollupId, entry.sequence, entry.height, entry.poster, entry.payload, entry.acc);
        expected += 1;
      }
    });
  }

  lastInboxEntry(rollupId: string): StoredInboxEntry | undefined {
    const row = this.get(
      "SELECT * FROM inbox_entries WHERE rollup_id = ? ORDER BY sequence DESC LIMIT 1",
      rollupId,
    );
    return row === undefined ? undefined : Store.toInboxEntry(row);
  }

  inboxEntry(rollupId: string, sequence: number): StoredInboxEntry | undefined {
    const row = this.get(
      "SELECT * FROM inbox_entries WHERE rollup_id = ? AND sequence = ?",
      rollupId,
      sequence,
    );
    return row === undefined ? undefined : Store.toInboxEntry(row);
  }

  /** Entries with `from < sequence <= to`, in order. */
  inboxRange(rollupId: string, from: number, to: number): StoredInboxEntry[] {
    return this.all(
      "SELECT * FROM inbox_entries WHERE rollup_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence",
      rollupId,
      from,
      to,
    ).map((row) => Store.toInboxEntry(row));
  }

  // --- batches and verdicts ------------------------------------------------

  /** Stores a batch claim, or updates the status of one already stored. */
  upsertBatch(rollupId: string, batch: StoredBatch): void {
    this.db
      .prepare(
        `INSERT INTO batches (rollup_id, claim_id, batch_index, state_root, prev_state_root,
           data_hash, withdrawals_root, inbox_start, inbox_end, tx_count, status, submitted_at,
           submitted_time, finalized_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (rollup_id, claim_id)
         DO UPDATE SET status = excluded.status, finalized_at = excluded.finalized_at`,
      )
      .run(
        rollupId,
        claimId(batch),
        batch.batchIndex,
        batch.stateRoot,
        batch.prevStateRoot,
        batch.dataHash,
        batch.withdrawalsRoot,
        batch.inboxStart,
        batch.inboxEnd,
        batch.txCount,
        batch.status,
        batch.submittedAt,
        batch.submittedTime,
        batch.finalizedAt,
      );
  }

  /**
   * Marks open claims the chain no longer lists as rejected. The chain keeps one
   * record per index, so a claim that vanished while still open was replaced.
   * Returns how many were marked.
   */
  supersedeMissing(rollupId: string, liveClaimIds: ReadonlySet<string>): number {
    const update = this.db.prepare(
      "UPDATE batches SET status = 'rejected' WHERE rollup_id = ? AND claim_id = ?",
    );
    let marked = 0;
    for (const batch of this.batches(rollupId)) {
      const open = batch.status === "submitted" || batch.status === "challenged";
      if (open && !liveClaimIds.has(claimId(batch))) {
        update.run(rollupId, claimId(batch));
        marked += 1;
      }
    }
    return marked;
  }

  /** Every claim ever seen for the rollup, in batch order, oldest claim first within an index. */
  batches(rollupId: string): StoredBatch[] {
    return this.all(
      "SELECT * FROM batches WHERE rollup_id = ? ORDER BY batch_index, submitted_at",
      rollupId,
    ).map((row) => ({
      batchIndex: int(row, "batch_index"),
      stateRoot: text(row, "state_root"),
      prevStateRoot: text(row, "prev_state_root"),
      dataHash: text(row, "data_hash"),
      withdrawalsRoot: text(row, "withdrawals_root"),
      inboxStart: int(row, "inbox_start"),
      inboxEnd: int(row, "inbox_end"),
      txCount: int(row, "tx_count"),
      status: text(row, "status"),
      submittedAt: int(row, "submitted_at"),
      submittedTime: int(row, "submitted_time"),
      finalizedAt: int(row, "finalized_at"),
    }));
  }

  saveVerdict(rollupId: string, verdict: StoredVerdict): void {
    this.db
      .prepare(
        `INSERT INTO verdicts (rollup_id, claim_id, batch_index, state_root, verdict,
           expected_state_root, expected_withdrawals_root, reasons, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (rollup_id, claim_id)
         DO UPDATE SET verdict = excluded.verdict,
           expected_state_root = excluded.expected_state_root,
           expected_withdrawals_root = excluded.expected_withdrawals_root,
           reasons = excluded.reasons, checked_at = excluded.checked_at`,
      )
      .run(
        rollupId,
        verdict.claimId,
        verdict.batchIndex,
        verdict.stateRoot,
        verdict.verdict,
        verdict.expectedStateRoot,
        verdict.expectedWithdrawalsRoot,
        JSON.stringify(verdict.reasons),
        verdict.checkedAt,
      );
  }

  /** The verdict on one claim; see `claimId`. */
  verdict(rollupId: string, claim: string): StoredVerdict | undefined {
    const row = this.get(
      "SELECT * FROM verdicts WHERE rollup_id = ? AND claim_id = ?",
      rollupId,
      claim,
    );
    if (row === undefined) return undefined;
    const kind = text(row, "verdict");
    if (kind !== "valid" && kind !== "invalid" && kind !== "undecidable") {
      throw new StoreError("unknown verdict value in the database");
    }
    return {
      claimId: text(row, "claim_id"),
      batchIndex: int(row, "batch_index"),
      stateRoot: text(row, "state_root"),
      verdict: kind,
      expectedStateRoot: text(row, "expected_state_root"),
      expectedWithdrawalsRoot: text(row, "expected_withdrawals_root"),
      reasons: JSON.parse(text(row, "reasons")) as string[],
      checkedAt: int(row, "checked_at"),
    };
  }

  // --- heartbeats ----------------------------------------------------------

  /** Records that `service` completed a unit of work at `at` (Unix seconds). */
  heartbeat(service: string, at: number, detail = ""): void {
    this.db
      .prepare(
        `INSERT INTO heartbeats (service, at, detail) VALUES (?, ?, ?)
         ON CONFLICT (service) DO UPDATE SET at = excluded.at, detail = excluded.detail`,
      )
      .run(service, at, detail);
  }

  heartbeats(): StoredHeartbeat[] {
    return this.all("SELECT * FROM heartbeats ORDER BY service").map((row) => ({
      service: text(row, "service"),
      at: int(row, "at"),
      detail: text(row, "detail"),
    }));
  }

  // --- ledger snapshots ----------------------------------------------------

  saveSnapshot(rollupId: string, snapshot: StoredSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO snapshots (rollup_id, inbox_sequence, state_root, accounts) VALUES (?, ?, ?, ?)
         ON CONFLICT (rollup_id, inbox_sequence)
         DO UPDATE SET state_root = excluded.state_root, accounts = excluded.accounts`,
      )
      .run(rollupId, snapshot.inboxSequence, snapshot.stateRoot, snapshot.accounts);
  }

  /** The newest snapshot taken at or before `maxInboxSequence`. */
  latestSnapshot(rollupId: string, maxInboxSequence: number): StoredSnapshot | undefined {
    const row = this.get(
      "SELECT * FROM snapshots WHERE rollup_id = ? AND inbox_sequence <= ? ORDER BY inbox_sequence DESC LIMIT 1",
      rollupId,
      maxInboxSequence,
    );
    if (row === undefined) return undefined;
    return {
      inboxSequence: int(row, "inbox_sequence"),
      stateRoot: text(row, "state_root"),
      accounts: text(row, "accounts"),
    };
  }

  // --- alerts -------------------------------------------------------------

  /** Stores an alert unless one with the same key exists. Returns the new alert, if any. */
  recordAlert(alert: Omit<StoredAlert, "id" | "deliveredAt">): StoredAlert | undefined {
    const result = this.db
      .prepare(
        `INSERT INTO alerts (key, severity, title, body, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (key) DO NOTHING`,
      )
      .run(alert.key, alert.severity, alert.title, alert.body, alert.createdAt);
    if (result.changes === 0) return undefined;
    return { ...alert, id: Number(result.lastInsertRowid), deliveredAt: undefined };
  }

  markAlertDelivered(id: number, deliveredAt: number): void {
    this.db.prepare("UPDATE alerts SET delivered_at = ? WHERE id = ?").run(deliveredAt, id);
  }

  /** Alerts that no sink has accepted yet, oldest first. */
  undeliveredAlerts(): StoredAlert[] {
    return this.all("SELECT * FROM alerts WHERE delivered_at IS NULL ORDER BY id").map((row) =>
      Store.toAlert(row),
    );
  }

  /** Most recent alerts, newest first. */
  recentAlerts(limit: number): StoredAlert[] {
    return this.all("SELECT * FROM alerts ORDER BY id DESC LIMIT ?", limit).map((row) =>
      Store.toAlert(row),
    );
  }

  // --- transaction log and claims -----------------------------------------

  logTx(tx: {
    label: string;
    status: StoredTx["status"];
    hash?: string;
    height?: number;
    code?: number;
    error?: string;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        "INSERT INTO tx_log (label, status, hash, height, code, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        tx.label,
        tx.status,
        tx.hash ?? null,
        tx.height ?? null,
        tx.code ?? null,
        tx.error ?? null,
        tx.createdAt,
      );
  }

  /** Most recent transaction attempts, newest first. */
  recentTxs(limit: number): StoredTx[] {
    return this.all("SELECT * FROM tx_log ORDER BY id DESC LIMIT ?", limit).map((row) => {
      const status = text(row, "status");
      if (status !== "confirmed" && status !== "failed" && status !== "unconfirmed") {
        throw new StoreError("unknown transaction status in the database");
      }
      const optionalText = (key: string): string | undefined => {
        const value = row[key];
        return typeof value === "string" ? value : undefined;
      };
      const optionalInt = (key: string): number | undefined => {
        const value = row[key];
        return typeof value === "number" ? value : undefined;
      };
      return {
        id: int(row, "id"),
        label: text(row, "label"),
        status,
        hash: optionalText("hash"),
        height: optionalInt("height"),
        code: optionalInt("code"),
        error: optionalText("error"),
        createdAt: int(row, "created_at"),
      };
    });
  }

  saveClaim(rollupId: string, claim: StoredClaim): void {
    this.db
      .prepare(
        `INSERT INTO claims (rollup_id, withdrawal_index, batch_index, tx_hash) VALUES (?, ?, ?, ?)
         ON CONFLICT (rollup_id, withdrawal_index)
         DO UPDATE SET tx_hash = excluded.tx_hash
         WHERE claims.tx_hash = '' AND excluded.tx_hash <> ''`,
      )
      .run(rollupId, claim.withdrawalIndex, claim.batchIndex, claim.txHash);
  }

  /** Every recorded payout, in withdrawal order. */
  claims(rollupId: string): StoredClaim[] {
    return this.all(
      "SELECT * FROM claims WHERE rollup_id = ? ORDER BY withdrawal_index",
      rollupId,
    ).map((row) => ({
      withdrawalIndex: int(row, "withdrawal_index"),
      batchIndex: int(row, "batch_index"),
      txHash: text(row, "tx_hash"),
    }));
  }

  // --- fraud history -------------------------------------------------------

  /** Records an upheld fraud proof. Returns false if it was already recorded. */
  saveFraudEvent(rollupId: string, event: StoredFraudEvent): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO fraud_events (rollup_id, tx_hash, claim_id, batch_index, height, time,
           submitter, challenger, slashed_uqor, reward_uqor, burned_uqor, seen_live)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (rollup_id, tx_hash, batch_index) DO NOTHING`,
      )
      .run(
        rollupId,
        event.txHash,
        event.claimId,
        event.batchIndex,
        event.height,
        event.time,
        event.submitter,
        event.challenger,
        event.slashedUqor,
        event.rewardUqor,
        event.burnedUqor,
        event.seenLive ? 1 : 0,
      );
    return result.changes > 0;
  }

  /** Upheld fraud proofs for a rollup, oldest first. */
  fraudEvents(rollupId: string): StoredFraudEvent[] {
    return this.all("SELECT * FROM fraud_events WHERE rollup_id = ? ORDER BY height", rollupId).map(
      (row) => ({
        txHash: text(row, "tx_hash"),
        claimId: text(row, "claim_id"),
        batchIndex: int(row, "batch_index"),
        height: int(row, "height"),
        time: int(row, "time"),
        submitter: text(row, "submitter"),
        challenger: text(row, "challenger"),
        slashedUqor: text(row, "slashed_uqor"),
        rewardUqor: text(row, "reward_uqor"),
        burnedUqor: text(row, "burned_uqor"),
        seenLive: int(row, "seen_live") === 1,
      }),
    );
  }

  claim(rollupId: string, withdrawalIndex: number): StoredClaim | undefined {
    const row = this.get(
      "SELECT * FROM claims WHERE rollup_id = ? AND withdrawal_index = ?",
      rollupId,
      withdrawalIndex,
    );
    if (row === undefined) return undefined;
    return {
      withdrawalIndex: int(row, "withdrawal_index"),
      batchIndex: int(row, "batch_index"),
      txHash: text(row, "tx_hash"),
    };
  }

  // --- base-chain monitor ---------------------------------------------------

  monitorSnapshot(network: string, source: string): StoredSnapshotOfSource | undefined {
    const row = this.get(
      "SELECT * FROM monitor_snapshots WHERE network = ? AND source = ?",
      network,
      source,
    );
    return row === undefined ? undefined : Store.toMonitorSnapshot(row);
  }

  monitorSnapshots(network: string): StoredSnapshotOfSource[] {
    return this.all(
      "SELECT * FROM monitor_snapshots WHERE network = ? ORDER BY source",
      network,
    ).map((row) => Store.toMonitorSnapshot(row));
  }

  saveMonitorSnapshot(snapshot: StoredSnapshotOfSource): void {
    this.db
      .prepare(
        `INSERT INTO monitor_snapshots (network, source, hash, body, fetched_at, changed_at, available)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (network, source)
         DO UPDATE SET hash = excluded.hash, body = excluded.body, fetched_at = excluded.fetched_at,
           changed_at = excluded.changed_at, available = excluded.available`,
      )
      .run(
        snapshot.network,
        snapshot.source,
        snapshot.hash,
        snapshot.body,
        snapshot.fetchedAt,
        snapshot.changedAt,
        snapshot.available ? 1 : 0,
      );
  }

  addChainEvent(event: Omit<StoredChainEvent, "id">): void {
    this.db
      .prepare(
        "INSERT INTO chain_events (network, source, severity, title, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(event.network, event.source, event.severity, event.title, event.detail, event.createdAt);
  }

  /** Most recent chain events, newest first. */
  recentChainEvents(limit: number): StoredChainEvent[] {
    return this.all("SELECT * FROM chain_events ORDER BY id DESC LIMIT ?", limit).map((row) => {
      const severity = text(row, "severity");
      if (severity !== "info" && severity !== "warning" && severity !== "critical") {
        throw new StoreError("unknown event severity in the database");
      }
      return {
        id: int(row, "id"),
        network: text(row, "network"),
        source: text(row, "source"),
        severity,
        title: text(row, "title"),
        detail: text(row, "detail"),
        createdAt: int(row, "created_at"),
      };
    });
  }

  // --- receipts and read models --------------------------------------------

  saveReceipt(rollupId: string, receipt: StoredReceipt): void {
    this.db
      .prepare(
        `INSERT INTO receipts (rollup_id, batch_index, contract, tx_hash, recorded_at, state_root)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (rollup_id, batch_index, contract)
         DO UPDATE SET state_root = excluded.state_root,
           tx_hash = CASE WHEN excluded.tx_hash = '' THEN receipts.tx_hash ELSE excluded.tx_hash END,
           recorded_at = excluded.recorded_at
         WHERE receipts.state_root <> excluded.state_root OR receipts.tx_hash = ''`,
      )
      .run(
        rollupId,
        receipt.batchIndex,
        receipt.contract,
        receipt.txHash,
        receipt.recordedAt,
        receipt.stateRoot,
      );
  }

  receipts(rollupId: string): StoredReceipt[] {
    return this.all(
      "SELECT * FROM receipts WHERE rollup_id = ? ORDER BY batch_index",
      rollupId,
    ).map((row) => ({
      batchIndex: int(row, "batch_index"),
      stateRoot: text(row, "state_root"),
      contract: text(row, "contract"),
      txHash: text(row, "tx_hash"),
      recordedAt: int(row, "recorded_at"),
    }));
  }

  /** Every stored verdict for a rollup, in batch order. */
  verdicts(rollupId: string): StoredVerdict[] {
    return this.batches(rollupId).flatMap((batch) => {
      const verdict = this.verdict(rollupId, claimId(batch));
      return verdict === undefined ? [] : [verdict];
    });
  }

  // --- internals -----------------------------------------------------------

  /**
   * Applies pending migrations. The version is read again inside the write
   * transaction, so several processes starting together apply each step once.
   */
  private migrate(): void {
    if (this.schemaVersion > MIGRATIONS.length) {
      throw new StoreError("the database was written by a newer version of Vigil", {
        databaseVersion: this.schemaVersion,
        supportedVersion: MIGRATIONS.length,
      });
    }
    while (this.schemaVersion < MIGRATIONS.length) {
      this.transaction(() => {
        const version = this.schemaVersion;
        const sql = MIGRATIONS[version];
        if (sql === undefined) return;
        this.db.exec(sql);
        this.db.exec(`PRAGMA user_version = ${String(version + 1)}`);
      });
    }
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params);
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params);
  }

  private static toMonitorSnapshot(row: Row): StoredSnapshotOfSource {
    return {
      network: text(row, "network"),
      source: text(row, "source"),
      hash: text(row, "hash"),
      body: text(row, "body"),
      fetchedAt: int(row, "fetched_at"),
      changedAt: int(row, "changed_at"),
      available: int(row, "available") === 1,
    };
  }

  private static toAlert(row: Row): StoredAlert {
    const severity = text(row, "severity");
    if (severity !== "info" && severity !== "warning" && severity !== "critical") {
      throw new StoreError("unknown alert severity in the database");
    }
    const delivered = row.delivered_at;
    return {
      id: int(row, "id"),
      key: text(row, "key"),
      severity,
      title: text(row, "title"),
      body: text(row, "body"),
      createdAt: int(row, "created_at"),
      deliveredAt: typeof delivered === "number" ? delivered : undefined,
    };
  }

  private static toInboxEntry(row: Row): StoredInboxEntry {
    return {
      sequence: int(row, "sequence"),
      height: int(row, "height"),
      poster: text(row, "poster"),
      payload: blob(row, "payload"),
      acc: text(row, "acc"),
    };
  }
}
