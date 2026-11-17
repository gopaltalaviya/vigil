import { QledgerLedger } from "@qorechain/rdk";
import { IntegrityError } from "./errors.js";
import { fromHex, toHex } from "./hex.js";

interface SnapshotAccount {
  id: string;
  balance: string;
  nonce: string;
}

interface SnapshotDocument {
  version: 1;
  accounts: SnapshotAccount[];
}

/** Serialises every account of a ledger to JSON text and returns its state root. */
export function serializeLedger(ledger: QledgerLedger): { stateRoot: string; accounts: string } {
  const document: SnapshotDocument = {
    version: 1,
    accounts: ledger.accounts().map((account) => ({
      id: toHex(account.id),
      balance: account.balance.toString(),
      nonce: account.nonce.toString(),
    })),
  };
  return { stateRoot: toHex(ledger.root()), accounts: JSON.stringify(document) };
}

/**
 * Rebuilds a ledger from a snapshot and refuses it unless the recomputed
 * state root equals the root recorded with the snapshot.
 */
export function restoreLedger(snapshot: { stateRoot: string; accounts: string }): QledgerLedger {
  let document: unknown;
  try {
    document = JSON.parse(snapshot.accounts);
  } catch (error) {
    throw new IntegrityError("ledger snapshot is not valid JSON", {
      cause: error instanceof Error ? error.message : "unknown",
    });
  }
  if (!isSnapshotDocument(document)) {
    throw new IntegrityError("ledger snapshot has an unexpected shape");
  }
  const ledger = new QledgerLedger();
  for (const account of document.accounts) {
    ledger.set(fromHex(account.id), BigInt(account.balance), BigInt(account.nonce));
  }
  const actual = toHex(ledger.root());
  if (actual !== snapshot.stateRoot) {
    throw new IntegrityError("ledger snapshot does not match its recorded state root", {
      expected: snapshot.stateRoot,
      actual,
    });
  }
  return ledger;
}

function isSnapshotDocument(value: unknown): value is SnapshotDocument {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { version?: unknown; accounts?: unknown };
  if (candidate.version !== 1 || !Array.isArray(candidate.accounts)) return false;
  return candidate.accounts.every((account: unknown) => {
    if (typeof account !== "object" || account === null) return false;
    const a = account as Record<string, unknown>;
    return (
      typeof a.id === "string" &&
      /^[0-9a-f]{64}$/.test(a.id) &&
      typeof a.balance === "string" &&
      /^\d+$/.test(a.balance) &&
      typeof a.nonce === "string" &&
      /^\d+$/.test(a.nonce)
    );
  });
}
