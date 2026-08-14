import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

const {
  initCrypto,
  hashLongString,
  computeTradeHash,
  computeContext,
  verifyAttestation,
  stableStringify,
} = require("../witness-services/common/crypto");

const CUSTODIAN_URL = process.env.CUSTODIAN_URL || "http://localhost:3001/evaluate";
const ORACLE_URL = process.env.ORACLE_URL || "http://localhost:3002/evaluate";
const SANCTIONS_URL = process.env.SANCTIONS_URL || "http://localhost:3003/evaluate";

interface Trade {
  agentId: string;
  tradeAmountUsd: number;
  counterpartyId: string;
  tradeTimestampUtcSeconds: number;
}

interface Scenario {
  label?: string;
  trade: Trade;
  agentThoughtTrace: string;
  policyText?: string;
  compiledPolicy?: any;
  publiclyClaimedThoughtTrace?: string;
}

async function callWitness(url: string, body: Record<string, unknown>): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(
      `Cannot reach witness ${url}. Are the three witness services running? (npm run witness:all)\nOriginal error: ${
        (e as Error).message
      }`
    );
  }
  if (!res.ok) {
    throw new Error(`Witness error ${url}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function loadCompiledPolicy(scenario: Scenario) {
  if (scenario.compiledPolicy) {
    console.log("Using pre-compiled policy from scenario file (skipping Claude API call)");
    return scenario.compiledPolicy;
  }
  if (!scenario.policyText) {
    throw new Error("Scenario file must provide either compiledPolicy or policyText");
  }
  console.log("Calling Policy Compiler on natural-language policy...");
  const { compilePolicy } = require("../policy-compiler/compile");
  const compiled = await compilePolicy(scenario.policyText);
  console.log("Compilation complete:", JSON.stringify(compiled, null, 2));
  return compiled;
}

export async function buildCircuitInput(scenario: Scenario) {
  const { poseidon, F } = await initCrypto();

  const compiledPolicy = await loadCompiledPolicy(scenario);
  const policyHash = await hashLongString(stableStringify(compiledPolicy));

  const tradeHash = await computeTradeHash(scenario.trade);

  // Reasoning commitment must be computed BEFORE any compliance verdicts are obtained,
  // so the agent fixes its reasoning before it learns any outcome.
  // The three institutions sign ctxFull = Poseidon(Poseidon(policyHash, tradeHash), thoughtCommit),
  // binding the reasoning to the same context as the policy and trade.
  const thoughtDigest = await hashLongString(scenario.agentThoughtTrace);
  const publicTraceForCommit =
    scenario.publiclyClaimedThoughtTrace ?? scenario.agentThoughtTrace;
  const publicDigest = await hashLongString(publicTraceForCommit);
  const thoughtCommit = F.toString(
    poseidon([F.e(publicDigest), F.e(tradeHash)])
  );

  const ctx = await computeContext(policyHash, tradeHash, thoughtCommit);

  console.log("\nRequesting all three independent witnesses in parallel...");
  const [custodian, oracle, sanctions] = await Promise.all([
    callWitness(CUSTODIAN_URL, {
      policyHash,
      thoughtCommit,
      compiledPolicy,
      trade: scenario.trade,
    }),
    callWitness(ORACLE_URL, {
      policyHash,
      thoughtCommit,
      compiledPolicy,
      trade: scenario.trade,
    }),
    callWitness(SANCTIONS_URL, { policyHash, thoughtCommit, compiledPolicy, trade: scenario.trade }),
  ]);

  for (const w of [custodian, oracle, sanctions]) {
    if (w.tradeHash !== tradeHash) {
      throw new Error(
        `Witness ${w.witness} computed a different tradeHash from the local one. Both sides disagree on the trade parameters:\n` +
          `  local: ${tradeHash}\n  ${w.witness}: ${w.tradeHash}`
      );
    }
    if (w.context !== ctx) {
      throw new Error(`Witness ${w.witness} computed a different context hash from the local one`);
    }
    if (!(await verifyAttestation(w))) {
      throw new Error(`Witness ${w.witness} signature failed local verification`);
    }
  }
  console.log("All three signatures verified locally; tradeHash and context agree across all parties");

  if (scenario.publiclyClaimedThoughtTrace) {
    console.log(
      "\nAttack scenario: the agent submitted a different reasoning text to the circuit than it gave to the three witnesses. " +
        "The circuit's thoughtCommit constraint fails, so no proof can be generated -- the agent cannot submit anything at all."
    );
  }

  const circuitInput = {
    policyHash,
    tradeHash,
    thoughtCommit,
    custodianPubKey: custodian.pubKey,
    oraclePubKey: oracle.pubKey,
    sanctionsPubKey: sanctions.pubKey,
    custodianResult: String(custodian.result),
    custodianSigR8: custodian.signature.R8,
    custodianSigS: custodian.signature.S,
    oracleResult: String(oracle.result),
    oracleSigR8: oracle.signature.R8,
    oracleSigS: oracle.signature.S,
    sanctionsResult: String(sanctions.result),
    sanctionsSigR8: sanctions.signature.R8,
    sanctionsSigS: sanctions.signature.S,
    thoughtDigest,
  };

  return {
    circuitInput,
    compiledPolicy,
    policyHash,
    tradeHash,
    thoughtCommit,
    witnessResults: { custodian, oracle, sanctions },
  };
}

export async function generateProof(scenario: Scenario, outDir: string) {
  const built = await buildCircuitInput(scenario);
  const { circuitInput, compiledPolicy, witnessResults } = built;

  fs.mkdirSync(outDir, { recursive: true });
  const inputPath = path.join(outDir, "input.json");
  fs.writeFileSync(inputPath, JSON.stringify(circuitInput, null, 2));
  fs.writeFileSync(
    path.join(outDir, "compiled_policy.json"),
    JSON.stringify(compiledPolicy, null, 2)
  );

  fs.writeFileSync(
    path.join(outDir, "audit_record.json"),
    JSON.stringify(
      {
        label: scenario.label ?? "unnamed",
        generatedAt: new Date().toISOString(),
        policyHash: built.policyHash,
        tradeHash: built.tradeHash,
        thoughtCommit: built.thoughtCommit,
        trade: scenario.trade,
        agentThoughtTrace: scenario.agentThoughtTrace,
        witnessVerdicts: {
          custodian: witnessResults.custodian.result,
          oracle: witnessResults.oracle.result,
          sanctions: witnessResults.sanctions.result,
        },
      },
      null,
      2
    )
  );

  const verdicts = {
    custodian: witnessResults.custodian.result,
    oracle: witnessResults.oracle.result,
    sanctions: witnessResults.sanctions.result,
  };
  const allCompliant = Object.values(verdicts).every((v) => v === 1);
  console.log("\nWitness verdicts:", verdicts);
  console.log(
    allCompliant
      ? "Expected: proof generation succeeds, isCompliant = 1, on-chain trade executes."
      : "Expected: proof still generates, but isCompliant = 0, contract reverts. " +
          "(This is distinct from 'invalid signature -> proof refuses to generate at all', which the deck should explain.)"
  );

  const wasmPath = path.join(__dirname, "..", "circuits", "build", "audit_js", "audit.wasm");
  const zkeyPath = path.join(__dirname, "..", "circuits", "build", "audit_final.zkey");
  const proofPath = path.join(outDir, "proof.json");
  const publicPath = path.join(outDir, "public.json");

  if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath)) {
    console.log(
      `\nSkipping snarkjs: circuits/build.sh has not been run yet, ${wasmPath} or ${zkeyPath} is missing.`
    );
    console.log(`Witness input was written to: ${inputPath}`);
    return { inputPath, proofPath: null, publicPath: null };
  }

  console.log("\nCalling snarkjs to generate the proof...");
  try {
    execFileSync(
      "snarkjs",
      ["groth16", "fullprove", inputPath, wasmPath, zkeyPath, proofPath, publicPath],
      { stdio: "inherit" }
    );
  } catch (e) {
    console.error(
      "\nProof generation failed. If this is the attack-forged-thought scenario, this is the expected outcome -- " +
        "the circuit rejected an agent whose reasoning commitment did not match its actual reasoning."
    );
    throw e;
  }
  console.log(`\nproof: ${proofPath}`);
  console.log(`public signals: ${publicPath}`);
  return { inputPath, proofPath, publicPath };
}

if (require.main === module) {
  const scenarioPath = process.argv[2];
  if (!scenarioPath) {
    console.error("Usage: npm run prove -- prover/scenarios/compliant.json [output dir]");
    process.exit(1);
  }
  const outDir = process.argv[3] || path.join(__dirname, "out");
  const scenario: Scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf-8"));
  console.log(`Scenario: ${scenario.label ?? scenarioPath}\n`);

  generateProof(scenario, outDir).catch((err) => {
    console.error("\nFailed:", err.message);
    process.exit(1);
  });
}