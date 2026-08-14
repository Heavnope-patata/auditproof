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

const calendar = require("./data.json");

const app = express();
app.use(express.json());

const PRIVKEY = loadPrivKey("ORACLE_PRIVKEY");
const PORT = process.env.PORT || 3002;

app.post("/evaluate", async (req, res) => {
  try {
    const { policyHash, thoughtCommit, compiledPolicy, trade } = req.body;

    if (!policyHash || !thoughtCommit || !compiledPolicy || !trade) {
      return res.status(400).json({ error: "Missing policyHash / thoughtCommit / compiledPolicy / trade" });
    }

    const expectedHash = await hashLongString(stableStringify(compiledPolicy));
    if (policyHash !== expectedHash) {
      return res.status(400).json({
        error: "policyHash does not match hash of compiledPolicy. Refusing to evaluate.",
      });
    }

    const ts = Number(trade.tradeTimestampUtcSeconds);
    const secondsOfDay = ((ts % 86400) + 86400) % 86400;
    const dayKey = new Date(ts * 1000).toISOString().slice(0, 10);

    const { market_open_utc_seconds, market_close_utc_seconds } = compiledPolicy.trading_hours;
    const inWindow =
      secondsOfDay >= market_open_utc_seconds && secondsOfDay <= market_close_utc_seconds;
    const isHoliday = calendar.marketHolidaysUtc.includes(dayKey);
    const compliant = inWindow && !isHoliday;

    const tradeHash = await computeTradeHash(trade);
    const ctx = await computeContext(policyHash, tradeHash, thoughtCommit);

    const attestation = await signAttestation(PRIVKEY, compliant ? 1 : 0, ctx);
    if (!(await verifyAttestation(attestation))) {
      throw new Error("Local signature self-check failed, refusing to return");
    }

    console.log(
      `[oracle] date=${dayKey} secOfDay=${secondsOfDay} ` +
        `window=[${market_open_utc_seconds},${market_close_utc_seconds}] holiday=${isHoliday} -> ` +
        `${compliant ? "PASS" : "FAIL"}`
    );

    res.json({ ...attestation, tradeHash, witness: "oracle" });
  } catch (err) {
    console.error("[oracle] evaluate error:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok", service: "oracle" }));

app.listen(PORT, () => {
  console.log(`[oracle] witness service listening on :${PORT}`);
});