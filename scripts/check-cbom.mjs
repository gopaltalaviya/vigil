#!/usr/bin/env node
/**
 * Checks a QoreScan CBOM (CycloneDX 1.6) of Vigil's contracts:
 *
 * - ML-DSA-87 is found in `src/ReceiptVerifier.sol` at both precompile calls,
 *   `pqcVerify` and `pqcKeyStatus`;
 * - no quantum-vulnerable algorithm is found in the contracts' own sources (`src/`).
 *
 *   node scripts/check-cbom.mjs docs/cbom.json
 *
 * Exits 1 with the reason on any failure.
 */
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "docs/cbom.json";
const cbom = JSON.parse(readFileSync(file, "utf8"));
const problems = [];

if (cbom.bomFormat !== "CycloneDX")
  problems.push(`not a CycloneDX document: ${String(cbom.bomFormat)}`);

const components = Array.isArray(cbom.components) ? cbom.components : [];
const occurrences = (component) => component.evidence?.occurrences ?? [];
const classification = (component) =>
  (component.properties ?? []).find((p) => p.name === "qorescan:classification")?.value;

const mldsa = components.find((c) => c.name === "ML-DSA-87");
for (const symbol of ["pqcVerify", "pqcKeyStatus"]) {
  const found =
    mldsa !== undefined &&
    occurrences(mldsa).some((o) => o.location === "src/ReceiptVerifier.sol" && o.symbol === symbol);
  if (!found) problems.push(`ML-DSA-87 ${symbol} not found in src/ReceiptVerifier.sol`);
}

for (const component of components.filter((c) => classification(c) === "quantum-vulnerable")) {
  for (const o of occurrences(component).filter((o) => String(o.location).startsWith("src/"))) {
    problems.push(
      `quantum-vulnerable ${String(component.name)} in ${String(o.location)}:${String(o.line)}`,
    );
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`FAIL  ${p}`);
  process.exit(1);
}
const lines = occurrences(mldsa)
  .filter((o) => o.location === "src/ReceiptVerifier.sol")
  .map((o) => `${String(o.symbol)} at line ${String(o.line)}`);
console.log(
  `ok  ${file}: ML-DSA-87 in src/ReceiptVerifier.sol (${lines.join(", ")}); no quantum-vulnerable algorithm in src/`,
);
