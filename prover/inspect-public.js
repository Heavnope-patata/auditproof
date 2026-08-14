const fs = require("fs");
const path = require("path");

const EXPECTED = [
  "isCompliant",
  "policyHash",
  "tradeHash",
  "thoughtCommit",
  "custodianPubKey[0]",
  "custodianPubKey[1]",
  "oraclePubKey[0]",
  "oraclePubKey[1]",
  "sanctionsPubKey[0]",
  "sanctionsPubKey[1]",
];

const outDir = process.argv[2] || path.join(__dirname, "out");
const input = JSON.parse(fs.readFileSync(path.join(outDir, "input.json"), "utf-8"));
const publicSignals = JSON.parse(fs.readFileSync(path.join(outDir, "public.json"), "utf-8"));

const known = new Map();
known.set(input.policyHash, "policyHash");
known.set(input.tradeHash, "tradeHash");
known.set(input.thoughtCommit, "thoughtCommit");
["custodian", "oracle", "sanctions"].forEach((w) => {
  const key = input[`${w}PubKey`];
  known.set(key[0], `${w}PubKey[0]`);
  known.set(key[1], `${w}PubKey[1]`);
});

console.log(`public signal count: ${publicSignals.length} (expected ${EXPECTED.length})\n`);

let mismatch = false;
publicSignals.forEach((v, i) => {
  const identified = known.get(v) ?? (i === 0 ? "isCompliant(output)" : "unrecognized");
  const expected = EXPECTED[i] ?? "-";
  const ok = identified === expected || (i === 0 && identified.startsWith("isCompliant"));
  if (!ok) mismatch = true;
  console.log(`  [${i}] actual=${identified.padEnd(20)} expected=${expected.padEnd(20)} ${ok ? "PASS" : "FAIL"}`);
});

console.log(
  mismatch
    ? "\nLayout MISMATCH with TradeExecutor.sol constants. Update the contract or the circuit before running on chain."
    : "\nLayout MATCHES TradeExecutor.sol constants."
);