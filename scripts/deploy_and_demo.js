const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "prover", "out");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function toCalldata(proof) {
  return {
    a: [proof.pi_a[0], proof.pi_a[1]],
    b: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    c: [proof.pi_c[0], proof.pi_c[1]],
  };
}

function loadScenarios() {
  if (!fs.existsSync(OUT_DIR)) return [];
  return fs
    .readdirSync(OUT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(OUT_DIR, d.name))
    .filter(
      (dir) =>
        fs.existsSync(path.join(dir, "proof.json")) &&
        fs.existsSync(path.join(dir, "public.json"))
    )
    .map((dir) => ({
      name: path.basename(dir),
      proof: readJson(path.join(dir, "proof.json")),
      publicSignals: readJson(path.join(dir, "public.json")),
      record: fs.existsSync(path.join(dir, "audit_record.json"))
        ? readJson(path.join(dir, "audit_record.json"))
        : null,
    }));
}

async function main() {
  const scenarios = loadScenarios();
  if (scenarios.length === 0) {
    console.error(
      `No scenarios with proof.json under ${OUT_DIR}. Run bash scripts/run-day2-demo.sh first.`
    );
    process.exit(1);
  }
  console.log(`Found ${scenarios.length} proven scenarios: ${scenarios.map((s) => s.name).join(", ")}\n`);

  const [agent, counterparty] = await hre.ethers.getSigners();

  if (!fs.existsSync(path.join(ROOT, "contracts", "Verifier.sol"))) {
    console.warn(
      "contracts/Verifier.sol not found (run circuits/build.sh to generate it). " +
        "Using Groth16VerifierFake for this session -- deploy will NOT be production-valid."
    );
  }
  // Use the real snarkjs-generated Verifier when available; fall back to the test fake
  const verifierName = fs.existsSync(path.join(ROOT, "contracts", "Verifier.sol"))
    ? "Groth16Verifier"
    : "Groth16VerifierFake";
  const Verifier = await hre.ethers.getContractFactory(verifierName);
  const verifier = await Verifier.deploy();
  await verifier.waitForDeployment();
  console.log("Verifier      :", await verifier.getAddress());

  const MockAsset = await hre.ethers.getContractFactory("MockAsset");
  const asset = await MockAsset.deploy(hre.ethers.parseUnits("1000000", 18));
  await asset.waitForDeployment();
  console.log("MockAsset     :", await asset.getAddress());

  const registry = readJson(path.join(ROOT, "witness-services", "pubkeys.json")).witnesses;
  const witnessKeys = [
    ...registry.custodian.pubKey,
    ...registry.oracle.pubKey,
    ...registry.sanctions.pubKey,
  ];
  const policyHash = scenarios[0].publicSignals[1];

  const TradeExecutor = await hre.ethers.getContractFactory("TradeExecutor");
  const executor = await TradeExecutor.deploy(
    await verifier.getAddress(),
    await asset.getAddress(),
    policyHash,
    witnessKeys
  );
  await executor.waitForDeployment();
  console.log("TradeExecutor :", await executor.getAddress());
  console.log("Registered policy hash:", policyHash);
  console.log("Registered witness keys: custodian / oracle / sanctions\n");

  await (
    await asset.approve(await executor.getAddress(), hre.ethers.parseUnits("1000000", 18))
  ).wait();

  const amount = hre.ethers.parseUnits("100", 18);

  for (const s of scenarios) {
    console.log("-".repeat(72));
    console.log(`Scenario: ${s.name}`);
    if (s.record?.label) console.log(`      ${s.record.label}`);

    const { a, b, c } = toCalldata(s.proof);
    const tradeHash = s.publicSignals[2];

    const submitTx = await executor.submitComplianceProof(a, b, c, s.publicSignals);
    const submitReceipt = await submitTx.wait();
    const compliant = s.publicSignals[0] === "1";
    console.log(
      `  Recorded: tx=${submitReceipt.hash.slice(0, 18)}... isCompliant=${s.publicSignals[0]}` +
        ` (gas ${submitReceipt.gasUsed})`
    );

    const balBefore = await asset.balanceOf(counterparty.address);
    try {
      const execTx = await executor.executeTrade(tradeHash, counterparty.address, amount);
      const execReceipt = await execTx.wait();
      console.log(`  Executed: success, tx=${execReceipt.hash.slice(0, 18)}...`);
    } catch (err) {
      console.log(`  Executed: rejected on chain -> ${err.reason || err.shortMessage || err.message}`);
      console.log(`        ${compliant ? "Unexpected failure" : "Expected: real EVM revert, no asset movement"}`);
    }
    const balAfter = await asset.balanceOf(counterparty.address);
    console.log(`  Counterparty balance change: ${hre.ethers.formatUnits(balAfter - balBefore, 18)} APDA`);

    const rec = await executor.getAuditRecord(tradeHash);
    console.log(
      `  Regulator query getAuditRecord(${String(tradeHash).slice(0, 12)}...): ` +
        `exists=${rec[0]} compliant=${rec[1]} executed=${rec[2]} thoughtCommit=${String(rec[4]).slice(0, 12)}...`
    );
  }

  console.log("-".repeat(72));
  console.log(`\nOn-chain audit entries: ${await executor.auditCount()}`);
  console.log(
    "Note that blocked trades also leave an on-chain record -- that is why recording and execution are split."
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});