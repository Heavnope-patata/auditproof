const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  initCrypto,
  hashLongString,
  computeTradeHash,
} = require("../witness-services/common/crypto");

const PUBLIC_SIGNAL_LAYOUT = [
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

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

async function main() {
  const outDir = process.argv[2] || path.join(__dirname, "out");
  const vkPath = path.join(__dirname, "..", "circuits", "build", "verification_key.json");
  const proofPath = path.join(outDir, "proof.json");
  const publicPath = path.join(outDir, "public.json");
  const recordPath = path.join(outDir, "audit_record.json");
  const registryPath = path.join(__dirname, "..", "witness-services", "pubkeys.json");

  for (const p of [vkPath, proofPath, publicPath]) {
    if (!fs.existsSync(p)) {
      console.error(`Missing ${p}. Run build.sh and npm run prove first.`);
      process.exit(1);
    }
  }

  console.log("Step 1: Verify the zero-knowledge proof itself");
  execFileSync("snarkjs", ["groth16", "verify", vkPath, publicPath, proofPath], {
    stdio: "inherit",
  });

  const publicSignals = readJson(publicPath);
  console.log("\nStep 2: Read the public signals");
  if (publicSignals.length !== PUBLIC_SIGNAL_LAYOUT.length) {
    console.warn(
      `Warning: public signal count is ${publicSignals.length}, expected ${PUBLIC_SIGNAL_LAYOUT.length}. ` +
        `Did the circuit's public list change? Run node prover/inspect-public.js to recheck indices.`
    );
  }
  publicSignals.forEach((v, i) => {
    console.log(`  [${i}] ${PUBLIC_SIGNAL_LAYOUT[i] ?? "?"} = ${v}`);
  });

  const isCompliant = publicSignals[0];
  console.log(
    `\nVerdict: isCompliant = ${isCompliant} -> ${isCompliant === "1" ? "compliant" : "non-compliant"}`
  );

  console.log("\nStep 3: Check the witness identities");
  if (fs.existsSync(registryPath)) {
    const registry = readJson(registryPath).witnesses;
    const expected = [
      ...registry.custodian.pubKey,
      ...registry.oracle.pubKey,
      ...registry.sanctions.pubKey,
    ];
    const actual = publicSignals.slice(4, 10);
    const match = expected.every((v, i) => v === actual[i]);
    console.log(
      match
        ? "  PASS: the three public keys in the proof match the public registry -- these signatures really came from those three institutions."
        : "  FAIL: the public keys do not match the registry. The agent may have forged its own keys to self-attest compliance. Reject this proof."
    );
  } else {
    console.log("  (No pubkeys.json found, skipped. In production the regulator holds this registry independently.)");
  }

  if (!fs.existsSync(recordPath)) {
    console.log("\n(No audit_record.json found, skipping reasoning replay.)");
    return;
  }

  console.log("\nStep 4: Post-hoc accountability -- replay the agent's stated reasoning");
  const record = readJson(recordPath);
  const { poseidon, F } = await initCrypto();

  const recomputedTradeHash = await computeTradeHash(record.trade);
  console.log(
    recomputedTradeHash === publicSignals[2]
      ? "  PASS: recomputing the trade hash from the recorded parameters matches the on-chain value -- this proof really corresponds to this trade."
      : "  FAIL: trade hash mismatch. The agent submitted different trade parameters than those used to generate the proof."
  );

  const digest = await hashLongString(record.agentThoughtTrace);
  const recomputedCommit = F.toString(poseidon([F.e(digest), F.e(recomputedTradeHash)]));
  console.log(
    recomputedCommit === publicSignals[3]
      ? "  PASS: the reasoning text the agent submitted later produces the same commitment that was published with the proof -- the post-hoc story matches the on-trade commitment."
      : "  FAIL: reasoning commitment mismatch. The agent invented a story after the fact that differs from the commitment it made when executing the trade."
  );
  console.log(`\nOriginal reasoning text the agent committed to at trade time:\n  ${record.agentThoughtTrace}`);
}

main().catch((err) => {
  console.error("Verification error:", err.message);
  process.exit(1);
});