import {
  addressFromPublicKey,
  deriveCanonicalPqKey,
  deriveClassicalKey,
  parseSiwqMessage,
  pqKeyFromSeed,
  signSiwq,
  type SiwqSignature,
} from "@qorechain/qoresign";
import { InputError } from "./amount.js";

/**
 * Signs a Sign In With QoreChain message from the operator console with the
 * account's own keys: the secp256k1 key from the seed phrase, and the ML-DSA-87
 * key from `QORE_PQC_SEED_HEX` when set, else the canonical key of the
 * account. Refuses a message for any other account.
 */
export function signLogin(input: { message: string; mnemonic: string; pqcSeedHex?: string }): {
  message: string;
  signature: SiwqSignature;
} {
  const message = input.message.replace(/\r\n/g, "\n").trim();
  let fields;
  try {
    fields = parseSiwqMessage(message);
  } catch {
    throw new InputError("that is not a sign-in message; copy it from the console");
  }
  const classicalKey = deriveClassicalKey({ mnemonic: input.mnemonic });
  const own = addressFromPublicKey(classicalKey.publicKey, classicalKey.type).bech32;
  if (fields.address !== own) {
    throw new InputError(`the message is for ${fields.address}, not for this account (${own})`);
  }
  const seed = input.pqcSeedHex?.trim();
  const pqKey =
    seed !== undefined && seed !== ""
      ? pqKeyFromSeed(Uint8Array.from(Buffer.from(seed.replace(/^0x/, ""), "hex")))
      : deriveCanonicalPqKey({ mnemonic: input.mnemonic, address: own });
  return { message, signature: signSiwq({ message, classicalKey, pqKey }) };
}
