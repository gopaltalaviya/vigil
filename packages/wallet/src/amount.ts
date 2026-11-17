import { VigilError } from "@vigil/core";

const DECIMALS = 6;
const UNIT = 10n ** BigInt(DECIMALS);
/** Amounts on the ledger are unsigned 64-bit integers of uqor. */
const MAX_UQOR = 2n ** 64n - 1n;

/** The user typed something that is not a usable amount, address or option. */
export class InputError extends VigilError {
  constructor(message: string) {
    super("CONFIG_INVALID", message);
  }
}

/** Parses a decimal QOR amount such as `1.5` into uqor, exactly, without floating point. */
export function parseQor(text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (match === null) {
    throw new InputError(`"${text}" is not an amount in QOR (up to 6 decimal places)`);
  }
  const whole = BigInt(match[1] ?? "0");
  const fraction = BigInt((match[2] ?? "").padEnd(DECIMALS, "0"));
  const uqor = whole * UNIT + fraction;
  if (uqor === 0n) throw new InputError("the amount must be greater than zero");
  if (uqor > MAX_UQOR) throw new InputError("the amount is too large");
  return uqor;
}

/** Renders uqor as a QOR decimal without trailing zeros. */
export function formatQor(uqor: bigint): string {
  const whole = uqor / UNIT;
  const fraction = (uqor % UNIT).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole.toString()}.${fraction}`;
}
