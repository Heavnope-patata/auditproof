const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCENARIO_DIR = path.join(ROOT, "prover", "scenarios");
const OUT_ROOT = path.join(ROOT, "prover", "out");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const WITNESSES = [
  { key: "custodian", label: "Institution A - Portfolio Custodian", checks: "Trade amount <= portfolio NAV x limit cap", hides: "Portfolio NAV, custody account, limit calculation internals", port: 3001 },
  { key: "oracle", label: "Institution B - Market Data Oracle", checks: "Trade timestamp inside trading hours and not a holiday", hides: "Trading-day calendar, market data feeds", port: 3002 },
  { key: "sanctions", label: "Institution C - Sanctions List Provider", checks: "Counterparty is not on any sanctions list", hides: "The full list, list version, individual matches", port: 3003 },
];

app.get("/api/scenarios", (_req, res) => {
  const files = fs.readdirSync(SCENARIO_DIR).filter((f) => f.endsWith(".json"));
  const scenarios = files.map((f) => {
    const s = JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, f), "utf-8"));
    return {
      id: path.basename(f, ".json"),
      label: s.label || f,
      isAttack: Boolean(s.publiclyClaimedThoughtTrace),
      trade: s.trade,
      policy: s.compiledPolicy || null,
      policyText: s.policyText || null,
      thought: s.agentThoughtTrace,
    };
  });
  const order = (x) => (x.id === "compliant" ? 0 : x.isAttack ? 2 : 1);
  scenarios.sort((a, b) => order(a) - order(b));
  res.json({ scenarios, witnesses: WITNESSES });
});

app.get("/api/status", async (_req, res) => {
  const witnesses = await Promise.all(
    WITNESSES.map(async (w) => {
      try {
        const r = await fetch(`http://localhost:${w.port}/health`, {
          signal: AbortSignal.timeout(1500),
        });
        return { ...w, up: r.ok };
      } catch {
        return { ...w, up: false };
      }
    })
  );
  res.json({
    witnesses,
    circuitBuilt:
      fs.existsSync(path.join(ROOT, "circuits", "build", "audit_final.zkey")) &&
      fs.existsSync(path.join(ROOT, "circuits", "build", "audit_js", "audit.wasm")),
    verifierExported: fs.existsSync(path.join(ROOT, "contracts", "Verifier.sol")),
  });
});

function streamProcess(res, cmd, args, tag) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: process.env });
    let buffer = "";

    const pump = (chunk, stream) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        send(res, "log", { tag, stream, line });
      }
    };

    child.stdout.on("data", (c) => pump(c, "out"));
    child.stderr.on("data", (c) => pump(c, "err"));
    child.on("error", (e) => {
      send(res, "log", { tag, stream: "err", line: `Could not start ${cmd}: ${e.message}` });
      resolve(1);
    });
    child.on("close", (code) => {
      if (buffer) send(res, "log", { tag, stream: "out", line: buffer });
      resolve(code === null ? 1 : code);
    });
  });
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function readIfExists(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

app.get("/api/run", async (req, res) => {
  const id = String(req.query.scenario || "");
  const scenarioPath = path.join(SCENARIO_DIR, `${id}.json`);
  if (!id.match(/^[a-z0-9-]+$/) || !fs.existsSync(scenarioPath)) {
    return res.status(400).json({ error: "Unknown scenario" });
  }
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf-8"));
  const outDir = path.join(OUT_ROOT, id);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  send(res, "stage", { stage: "policy", state: "running" });
  send(res, "stage", { stage: "policy", state: "done", policy: scenario.compiledPolicy });

  send(res, "stage", { stage: "witness", state: "running" });
  send(res, "stage", { stage: "prove", state: "pending" });

  const proveCode = await streamProcess(
    res,
    "npx",
    ["ts-node", "prover/generate-proof.ts", scenarioPath, outDir],
    "prove"
  );

  const input = readIfExists(path.join(outDir, "input.json"));
  const record = readIfExists(path.join(outDir, "audit_record.json"));
  const publicSignals = readIfExists(path.join(outDir, "public.json"));

  const verdicts = record ? record.witnessVerdicts : null;
  send(res, "stage", {
    stage: "witness",
    state: verdicts ? "done" : "failed",
    verdicts,
    tradeHash: record ? record.tradeHash : null,
  });

  const isAttack = Boolean(scenario.publiclyClaimedThoughtTrace);
  const proofOk = proveCode === 0 && Boolean(publicSignals);

  send(res, "stage", {
    stage: "prove",
    state: proofOk ? "done" : "failed",
    expectedFailure: isAttack,
    publicSignals,
    hasCircuit: fs.existsSync(path.join(ROOT, "circuits", "build", "audit_final.zkey")),
  });

  if (proofOk) {
    send(res, "stage", { stage: "verify", state: "running" });
    const verifyCode = await streamProcess(
      res,
      "node",
      ["prover/verify-proof.js", outDir],
      "verify"
    );
    send(res, "stage", { stage: "verify", state: verifyCode === 0 ? "done" : "failed" });
  } else {
    send(res, "stage", { stage: "verify", state: "skipped" });
  }

  const isCompliant = publicSignals ? publicSignals[0] === "1" : null;
  send(res, "result", {
    scenario: id,
    label: scenario.label,
    isAttack,
    proofGenerated: proofOk,
    isCompliant,
    verdicts,
    record,
    publicSignals,
    inputKeys: input ? Object.keys(input) : [],
  });
  send(res, "done", {});
  res.end();
});

const PORT = process.env.UI_PORT || 4000;
app.listen(PORT, () => {
  console.log(`AuditProof demo UI: http://localhost:${PORT}`);
  console.log("Reminder: run npm run genkeys, circuits/build.sh, and keep the three witnesses running.");
});