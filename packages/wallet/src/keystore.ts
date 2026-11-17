import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { qledgerKeypairFromSeed } from "@qorechain/rdk";
import { IntegrityError, fromHex, toHex } from "@vigil/core";
import { InputError } from "./amount.js";

/** An L2 account: an ML-DSA-44 key pair and the account id derived from its public key. */
export interface L2Account {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  accountId: Uint8Array;
}

interface KeystoreFile {
  version: 1;
  kdf: { name: "scrypt"; n: number; r: number; p: number; salt: string };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string; ciphertext: string };
  /** Public: lets tools show the account without the passphrase. */
  accountId: string;
}

const SCRYPT = { n: 2 ** 16, r: 8, p: 1 };
const SCRYPT_MAX_MEMORY = 256 * 1024 * 1024;
const MIN_PASSPHRASE_LENGTH = 12;

function deriveKey(passphrase: string, salt: Uint8Array, kdf: typeof SCRYPT): Buffer {
  return scryptSync(passphrase, salt, 32, {
    N: kdf.n,
    r: kdf.r,
    p: kdf.p,
    maxmem: SCRYPT_MAX_MEMORY,
  });
}

/**
 * Creates a new L2 account and stores its 32-byte seed encrypted on disk
 * (scrypt for the key, AES-256-GCM for the seed). Refuses to overwrite a file.
 */
export function createKeystore(path: string, passphrase: string): L2Account {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new InputError(
      `the keystore passphrase must be at least ${String(MIN_PASSPHRASE_LENGTH)} characters`,
    );
  }
  if (existsSync(path)) throw new InputError("a keystore already exists; it will not be replaced");

  const seed = randomBytes(32);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const account = qledgerKeypairFromSeed(seed);
  const accountId = toHex(account.accountId);

  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt, SCRYPT), iv);
  cipher.setAAD(Buffer.from(accountId, "hex"));
  const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
  seed.fill(0);

  const file: KeystoreFile = {
    version: 1,
    kdf: { name: "scrypt", ...SCRYPT, salt: toHex(salt) },
    cipher: {
      name: "aes-256-gcm",
      iv: toHex(iv),
      tag: toHex(cipher.getAuthTag()),
      ciphertext: toHex(ciphertext),
    },
    accountId,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return account;
}

/** Decrypts the keystore. A wrong passphrase or a modified file is reported, never guessed around. */
export function openKeystore(path: string, passphrase: string): L2Account {
  const file = readKeystoreFile(path);
  const key = deriveKey(passphrase, fromHex(file.kdf.salt), file.kdf);
  const decipher = createDecipheriv("aes-256-gcm", key, fromHex(file.cipher.iv));
  decipher.setAAD(Buffer.from(file.accountId, "hex"));
  decipher.setAuthTag(fromHex(file.cipher.tag));
  let seed: Buffer;
  try {
    seed = Buffer.concat([decipher.update(fromHex(file.cipher.ciphertext)), decipher.final()]);
  } catch {
    throw new InputError("could not unlock the keystore: wrong passphrase or damaged file");
  }
  const account = qledgerKeypairFromSeed(seed);
  seed.fill(0);
  if (toHex(account.accountId) !== file.accountId) {
    throw new IntegrityError("the keystore's account id does not match its key");
  }
  return account;
}

/** The account id recorded in a keystore, readable without the passphrase. */
export function keystoreAccountId(path: string): string {
  return readKeystoreFile(path).accountId;
}

function readKeystoreFile(path: string): KeystoreFile {
  if (!existsSync(path)) {
    throw new InputError("no keystore found; create one with `vigil keygen`");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new IntegrityError("the keystore file is not valid JSON");
  }
  const file = parsed as Partial<KeystoreFile>;
  const hex = (value: unknown): boolean => typeof value === "string" && /^[0-9a-f]+$/.test(value);
  if (
    file.version !== 1 ||
    file.kdf?.name !== "scrypt" ||
    file.cipher?.name !== "aes-256-gcm" ||
    !Number.isInteger(file.kdf.n) ||
    file.kdf.n < 2 ** 14 ||
    file.kdf.n > 2 ** 20 ||
    file.kdf.r !== 8 ||
    file.kdf.p !== 1 ||
    file.kdf.salt.length < 32 ||
    file.cipher.iv.length !== 24 ||
    file.cipher.tag.length !== 32 ||
    file.cipher.ciphertext.length !== 64 ||
    !hex(file.kdf.salt) ||
    !hex(file.cipher.iv) ||
    !hex(file.cipher.tag) ||
    !hex(file.cipher.ciphertext) ||
    !hex(file.accountId) ||
    file.accountId?.length !== 64
  ) {
    throw new IntegrityError("the keystore file has an unexpected format");
  }
  return file as KeystoreFile;
}
