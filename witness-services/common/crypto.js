const { buildEddsa, buildPoseidon } = require("circomlibjs");

let _eddsa = null;
let _poseidon = null;
let _F = null;

async function initCrypto() {
  if (!_eddsa) _eddsa = await buildEddsa();
  if (!_poseidon) _poseidon = await buildPoseidon();
  _F = _poseidon.F;
  return { eddsa: _eddsa, poseidon: _poseidon, F: _F };
}

const MAX_BYTES_PER_FIELD = 31;

function strToField(str, F) {
  const bytes = Buffer.from(String(str), "utf-8");
  if (bytes.length > MAX_BYTES_PER_FIELD) {
    throw new Error(
      `strToField only encodes short identifiers (<=${MAX_BYTES_PER_FIELD} bytes). Got ${bytes.length} bytes. ` +
        `Use hashLongString() for longer text.`
    );
  }
  let acc = 0n;
  for (const b of bytes) {
    acc = acc * 256n + BigInt(b);
  }
  return acc % F.p;
}

async function hashLongString(str) {
  const { poseidon, F } = await initCrypto();
  const bytes = Buffer.from(String(str), "utf-8");
  let acc = F.e(0);
  for (let i = 0; i < bytes.length; i += MAX_BYTES_PER_FIELD) {
    const block = bytes.subarray(i, i + MAX_BYTES_PER_FIELD);
    let blockVal = 0n;
    for (const b of block) blockVal = blockVal * 256n + BigInt(b);
    acc = poseidon([acc, F.e(blockVal)]);
  }
  acc = poseidon([acc, F.e(BigInt(bytes.length))]);
  return F.toString(acc);
}

async function computeTradeHash(trade) {
  const { poseidon, F } = await initCrypto();
  const agentIdF = strToField(trade.agentId, F);
  const counterpartyF = strToField(trade.counterpartyId, F);
  const amountCents = BigInt(Math.round(Number(trade.tradeAmountUsd) * 100));
  const ts = BigInt(trade.tradeTimestampUtcSeconds);
  return F.toString(poseidon([agentIdF, amountCents, counterpartyF, ts]));
}

async function computeContext(policyHash, tradeHash, thoughtCommit) {
  const { poseidon, F } = await initCrypto();
  if (thoughtCommit === undefined || thoughtCommit === null) {
    throw new Error("computeContext requires thoughtCommit (reasoning binding)");
  }
  const base = poseidon([F.e(policyHash), F.e(tradeHash)]);
  return F.toString(poseidon([base, F.e(thoughtCommit)]));
}

async function signAttestation(privKeyBuf, resultBit, ctx) {
  const { eddsa, poseidon, F } = await initCrypto();
  if (resultBit !== 0 && resultBit !== 1) {
    throw new Error(`resultBit must be 0 or 1, got: ${resultBit}`);
  }
  const msg = poseidon([F.e(resultBit), F.e(ctx)]);
  const signature = eddsa.signPoseidon(privKeyBuf, msg);
  const pubKey = eddsa.prv2pub(privKeyBuf);

  return {
    result: resultBit,
    context: String(ctx),
    message: F.toString(msg),
    signature: {
      R8: [F.toString(signature.R8[0]), F.toString(signature.R8[1])],
      S: signature.S.toString(),
    },
    pubKey: [F.toString(pubKey[0]), F.toString(pubKey[1])],
  };
}

async function verifyAttestation(attestation) {
  const { eddsa, F } = await initCrypto();
  const msg = F.e(attestation.message);
  const sig = {
    R8: [F.e(attestation.signature.R8[0]), F.e(attestation.signature.R8[1])],
    S: BigInt(attestation.signature.S),
  };
  const pub = [F.e(attestation.pubKey[0]), F.e(attestation.pubKey[1])];
  return eddsa.verifyPoseidon(msg, sig, pub);
}

function loadPrivKey(envVarName) {
  const hex = process.env[envVarName];
  if (!hex || hex.length !== 64) {
    throw new Error(
      `Environment variable ${envVarName} is not set or has the wrong length (need 64 hex chars = 32 bytes). ` +
        `Run npm run genkeys first.`
    );
  }
  return Buffer.from(hex, "hex");
}

function stableStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

module.exports = {
  initCrypto,
  strToField,
  hashLongString,
  computeTradeHash,
  computeContext,
  signAttestation,
  verifyAttestation,
  loadPrivKey,
  stableStringify,
};