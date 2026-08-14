#!/bin/bash
set -e
cd "$(dirname "$0")"

PTAU_POWER=${PTAU_POWER:-15}
PTAU_FILE="build/ptau/pot${PTAU_POWER}_final.ptau"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_${PTAU_POWER}.ptau"

echo "== 1. Compile the circuit =="
circom audit.circom --r1cs --wasm --sym -l ../node_modules -o build

echo ""
echo "== 2. Constraint-count self-check =="
snarkjs r1cs info build/audit.r1cs | tee build/r1cs_info.txt
CONSTRAINTS=$(grep -i "non-linear constraints" build/r1cs_info.txt | grep -o '[0-9]\+' | tail -1)
CAPACITY=$((2 ** PTAU_POWER))
echo "non-linear constraints: ${CONSTRAINTS} / ptau capacity 2^${PTAU_POWER} = ${CAPACITY}"
if [ "$CONSTRAINTS" -ge "$CAPACITY" ]; then
  echo ""
  echo "!! Constraint count exceeds ptau capacity. Re-run with a larger ptau:"
  echo "   PTAU_POWER=$((PTAU_POWER + 1)) ./build.sh"
  exit 1
fi

echo ""
echo "== 3. Download Powers of Tau (Hermez ceremony output) =="
mkdir -p build/ptau
if [ ! -f "$PTAU_FILE" ]; then
  curl -L -o "$PTAU_FILE" "$PTAU_URL"
fi

echo ""
echo "== 4. Groth16 phase 2 setup =="
snarkjs groth16 setup build/audit.r1cs "$PTAU_FILE" build/audit_0000.zkey
snarkjs zkey contribute build/audit_0000.zkey build/audit_final.zkey \
  --name="auditproof-1st-contribution" -v -e="$(head -c 64 /dev/urandom | base64)"
snarkjs zkey export verificationkey build/audit_final.zkey build/verification_key.json

echo ""
echo "== 5. Export Solidity Verifier contract =="
mkdir -p ../contracts
snarkjs zkey export solidityverifier build/audit_final.zkey ../contracts/Verifier.sol

echo ""
echo "== Done. Artifacts: =="
echo "  circuits/build/audit.r1cs"
echo "  circuits/build/audit_js/audit.wasm"
echo "  circuits/build/audit_final.zkey"
echo "  circuits/build/verification_key.json"
echo "  contracts/Verifier.sol"
echo ""
echo "Next: npm run genkeys && npm run day2:demo"