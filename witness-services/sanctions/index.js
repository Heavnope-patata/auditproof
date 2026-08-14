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

const { sanctionedEntities } = require("./data.json");

const app = express();
app.use(express.json());

const PRIVKEY = loadPrivKey("SANCTIONS_PRIVKEY");
const PORT = process.env.PORT || 3003;

app.post("/evaluate", async (req, res) => {
  try {
    const { policyHash, thoughtCommit, compiledPolicy, trade } = req.body;
    if (!policyHash || !thoughtCommit || !compiledPolicy || !trade || typeof trade.counterpartyId !== "string") {
      return res.status(400).json({ error: "Missing policyHash / thoughtCommit / compiledPolicy / trade.counterpartyId" });
    }

    const expectedHash = await hashLongString(stableStringify(compiledPolicy));
    if (policyHash !== expectedHash) {
      return res.status(400).json({
        error: "policyHash does not match hash of compiledPolicy. Refusing to evaluate.",
      });
    }

    const isSanctioned = sanctionedEntities.some(
      (e) => e.id === trade.counterpartyId
    );
    const compliant = !isSanctioned;

    const tradeHash = await computeTradeHash(trade);
    const ctx = await computeContext(policyHash, tradeHash, thoughtCommit);

    const attestation = await signAttestation(PRIVKEY, compliant ? 1 : 0, ctx);
    if (!(await verifyAttestation(attestation))) {
      throw new Error("Local signature self-check failed, refusing to return");
    }

    console.log(
      `[sanctions] counterparty=${trade.counterpartyId} -> ` +
        `${compliant ? "PASS (not on list)" : "FAIL (sanctions hit)"}`
    );

    res.json({ ...attestation, tradeHash, witness: "sanctions" });
  } catch (err) {
    console.error("[sanctions] evaluate error:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok", service: "sanctions" }));

app.listen(PORT, () => {
  console.log(`[sanctions] witness service listening on :${PORT}`);
});