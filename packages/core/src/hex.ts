import { IntegrityError } from "./errors.js";

const HEX = /^(?:[0-9a-f]{2})*$/;

/** Lower-case hex without a `0x` prefix. */
export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Parses hex with or without a `0x` prefix; rejects anything else. */
export function fromHex(value: string): Uint8Array {
  const stripped = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  const body = stripped.toLowerCase();
  if (!HEX.test(body)) {
    throw new IntegrityError("value is not valid hex", { length: value.length });
  }
  return new Uint8Array(Buffer.from(body, "hex"));
}

/** Normalises a hex string so two spellings of the same bytes compare equal. */
export function normalizeHex(value: string): string {
  return toHex(fromHex(value));
}

/** Compares two byte strings without stopping at the first difference. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
