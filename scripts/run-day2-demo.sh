#!/bin/bash
set -u
cd "$(dirname "$0")/.."

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

cleanup() {
  echo ""
  echo "Shutting down witnesses..."
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null; done
}
trap cleanup EXIT

if [ ! -f witness-services/custodian/.env ]; then
  echo "No keys yet. Run npm run genkeys first."
  exit 1
fi

echo "== Starting the three independent witness processes =="
PIDS=()
node witness-services/custodian/index.js  > /tmp/ap-custodian.log 2>&1 & PIDS+=($!)
node witness-services/oracle/index.js     > /tmp/ap-oracle.log    2>&1 & PIDS+=($!)
node witness-services/sanctions/index.js  > /tmp/ap-sanctions.log 2>&1 & PIDS+=($!)
sleep 2

for port in 3001 3002 3003; do
  if curl -sf "http://localhost:${port}/health" > /dev/null; then
    echo "  :${port} ok"
  else
    echo -e "  ${RED}:${port} not up${NC}, see /tmp/ap-*.log"
    exit 1
  fi
done

SCENARIOS=(compliant violation-oversize violation-sanctioned violation-offhours attack-forged-thought)

for s in "${SCENARIOS[@]}"; do
  echo ""
  echo "========================================================================"
  echo "Scenario: ${s}"
  echo "========================================================================"
  if npx ts-node prover/generate-proof.ts "prover/scenarios/${s}.json" "prover/out/${s}"; then
    if [ "$s" = "attack-forged-thought" ]; then
      echo -e "${RED}!! Attack scenario unexpectedly succeeded -- check the reasoning-binding constraint in the circuit${NC}"
    else
      echo -e "${GREEN}${s}: proof generated${NC}"
      node prover/verify-proof.js "prover/out/${s}" || true
    fi
  else
    if [ "$s" = "attack-forged-thought" ]; then
      echo -e "${GREEN}Expected failure: agent's public reasoning did not match the actual reasoning, circuit refused${NC}"
    else
      echo -e "${YELLOW}${s} failed, see error above${NC}"
    fi
  fi
done

echo ""
echo "Witness logs (private data only stays here, never enters HTTP responses)"
echo "------------------------------------------------------------------------"
tail -n 20 /tmp/ap-custodian.log /tmp/ap-oracle.log /tmp/ap-sanctions.log

echo ""
echo "Next, run the on-chain part:"
echo "  Terminal A: npx hardhat node"
echo "  Terminal B: npm run chain:demo"