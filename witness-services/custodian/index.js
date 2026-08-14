const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const {
  computeTradeHash,
  computeContext,
  signAttestation,
  verifyAttestation,
  loadPrivKey,
  stableStringify,
  hashLongString,
} = require("../common/crypto");

const portfolios = require("./data.json").portfolios;

const app = express();
app.use(express.json());

const PRIVKEY = loadPrivKey("CUSTODIAN_PRIVKEY");
const PORT = process.env.PORT || 3001;

app.post("/evaluate", async (req, res) => {
  try {
    const { policyHash, thoughtCommit, compiledPolicy, trade } = req.body;

    if (!policyHash || !thoughtCommit || !compiledPolicy || !trade) {
      return res
        .status(400)
        .json({ error: "Missing policyHash / thoughtCommit / compiledPolicy / trade" });
    }

    const expectedHash = await hashLongString(stableStringify(compiledPolicy));
    if (policyHash !== expectedHash) {
      return res.status(400).json({
        error: "policyHash does not match hash of compiledPolicy. Refusing to evaluate.",
      });
    }

    const portfolio = portfolios[trade.agentId];
    if (!portfolio) {
      return res.status(404).json({ error: `Unknown agent: ${trade.agentId}` });
    }

    const maxTradePctBps = compiledPolicy.max_trade_pct_of_portfolio_bps;
    const limitUsd = (portfolio.navUsd * maxTradePctBps) / 10000;
    const compliant = trade.tradeAmountUsd <= limitUsd;

    const tradeHash = await computeTradeHash(trade);
    const ctx = await computeContext(policyHash, tradeHash, thoughtCommit);

    const attestation = await signAttestation(PRIVKEY, compliant ? 1 : 0, ctx);
    if (!(await verifyAttestation(attestation))) {
      throw new Error("Local signature self-check failed, refusing to return");
    }

    console.log(
      `[custodian] agent=${trade.agentId} amount=${trade.tradeAmountUsd} limit=${limitUsd} -> ` +
        `${compliant ? "PASS" : "FAIL"}`
    );

    res.json({ ...attestation, tradeHash, witness: "custodian" });
  } catch (err) {
    console.error("[custodian] evaluate error:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok", service: "custodian" }));

app.listen(PORT, () => {
  console.log(`[custodian] witness service listening on :${PORT}`);
});