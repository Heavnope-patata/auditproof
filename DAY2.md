# Day 2 deliverable: witness, proof, and chain layers

Day 2 implements the complete source pipeline. Generated keys, circuit build output, proofs, and `contracts/Verifier.sol` are intentionally excluded by `.gitignore`, so a fresh checkout must generate them before the real demo can run.

## 1. What is implemented

| Module | Source | What it does |
|---|---|---|
| Three witness services | `witness-services/{custodian,oracle,sanctions}/` | Separate process, private key, and private data file for each witness |
| Shared encoding | `witness-services/common/crypto.js` | Trade hash, context hash, long-text hash, signatures, and local signature checks |
| Key generation | `scripts/genkeys.js` | Generates three keypairs and `witness-services/pubkeys.json` |
| Prover | `prover/generate-proof.ts` | Loads/compiles policy, requests attestations, builds circuit input, and runs `snarkjs` |
| Off-chain verifier | `prover/verify-proof.js` | Verifies the Groth16 proof, displays public signals, and reports identity/replay checks |
| Public-index check | `prover/inspect-public.js` | Helps detect drift between circuit public signals and contract indices |
| Contracts | `contracts/TradeExecutor.sol`, `contracts/MockAsset.sol` | Records a verdict first, then separately allows or rejects execution |
| Scenarios | `prover/scenarios/*.json` | One compliant case, three policy violations, and one commitment-consistency test |
| Demo runner | `scripts/run-day2-demo.sh` | Starts witnesses, runs five scenarios, and invokes off-chain verification |

## 2. Security changes that matter

### 2.1 Attestations are bound to one policy, trade, and commitment

The signed message is:

```text
context = Poseidon(Poseidon(policyHash, tradeHash), thoughtCommit)
message = Poseidon(result, context)
```

Changing the verdict, policy hash, trade hash, or reasoning commitment invalidates the signature constraint. This prevents a PASS signature obtained for one context from being replayed in another.

### 2.2 Witness identities are pinned

Because witness public keys are public circuit inputs, proof validity alone does not establish who signed. `TradeExecutor` therefore stores the six public-key coordinates at deployment and compares them with `pubSignals[4..9]`. The off-chain verifier compares the same signals with `witness-services/pubkeys.json`.

Important: the JSON registry is demo infrastructure, not a production trust registry. A production deployment needs an authenticated registry and key-rotation process.

### 2.3 Long text uses a chunked Poseidon hash

Policy JSON and reasoning text are longer than one field element. `hashLongString()` absorbs 31-byte blocks with Poseidon and includes the byte length at the end. Short identifiers still use `strToField()`, which rejects inputs longer than 31 bytes.

### 2.4 The reasoning feature is a consistency commitment

The circuit proves that the private `thoughtDigest` supplied to the circuit matches the public `thoughtCommit` for this trade, and the witnesses sign that same commitment. It detects a mismatch between the committed text and the text later presented for verification.

It does **not** prove that the text is the model's true internal chain of thought, and the current prototype does not independently prove that the commitment was created before the agent learned a verdict. Present this as tamper-evident reasoning consistency, not mind-reading or proof of honesty.

## 3. Why recording and execution are separate

| Function | Behaviour |
|---|---|
| `submitComplianceProof()` | Verifies the proof and records either verdict; invalid proofs or mismatched policy/keys still revert |
| `executeTrade()` | Executes only a previously recorded compliant trade; otherwise reverts |
| `getAuditRecord()` | Returns the stored record without exposing witness-private datasets |

If non-compliance were detected inside the same transaction that records the result, a revert would also roll back the event and storage write. The two-step design preserves a record of valid proofs whose verdict is `0`.

## 4. Scenario expectations

| Scenario | Proof generation | Chain result |
|---|---|---|
| `compliant` | Succeeds with `isCompliant=1` | Record succeeds; execution transfers 100 APDA in the demo |
| `violation-oversize` | Succeeds with `isCompliant=0` | Record succeeds; execution reverts |
| `violation-sanctioned` | Succeeds with `isCompliant=0` | Record succeeds; execution reverts |
| `violation-offhours` | Succeeds with `isCompliant=0` | Record succeeds; execution reverts |
| `attack-forged-thought` | Fails because the two supplied reasoning representations are inconsistent | Nothing can be submitted |

The last scenario is a negative consistency test. It demonstrates that two different reasoning values cannot satisfy one commitment; it does not prove that a malicious agent supplied its genuine internal reasoning.

## 5. Clean-machine acceptance checklist

### Prerequisites

- Node.js 20 LTS or 22
- `circom` 2.1.x on `PATH`
- `snarkjs` 0.7.x on `PATH` (`snarkjs` is not listed in `package.json`)
- Bash and `curl`; on Windows, run the Bash scripts from WSL or Git Bash

Run from the repository root:

```bash
npm ci
npm run genkeys
npm run build-circuit
```

`npm run build-circuit` is preferable to `./circuits/build.sh`: archives created on Windows may not preserve the executable bit. The build must create all of the following:

```text
circuits/build/audit.r1cs
circuits/build/audit_js/audit.wasm
circuits/build/audit_final.zkey
circuits/build/verification_key.json
contracts/Verifier.sol
```

If the constraint count exceeds the default `pot15` capacity, rerun from Bash with:

```bash
PTAU_POWER=16 npm run build-circuit
```

Run the proof scenarios:

```bash
npm run day2:demo
node prover/inspect-public.js prover/out/compliant
```

Acceptance criteria:

- The first four scenarios generate proofs.
- Every `verify-proof.js` semantic check shown in the log says `PASS`.
- `attack-forged-thought` fails and is labelled as an expected failure.
- The inspect script reports the ten public signals in the contract's expected order.

Do not rely only on the shell script's final exit code: the current runner continues after individual scenario failures, and some semantic verifier failures are printed rather than returned as a non-zero process exit.

Run the chain demo in two additional terminals:

```bash
# Terminal A
npm run chain:node

# Terminal B
npm run chain:demo
```

Before presenting the chain demo, confirm that `contracts/Verifier.sol` exists. Otherwise `deploy_and_demo.js` falls back to `Groth16VerifierFake`, which is suitable for contract-flow testing but is not evidence of real ZK verification.

Expected chain result: the compliant scenario executes; the three violation scenarios remain recorded but cannot execute; `On-chain audit entries` is `4`.

## 6. Known limitations to disclose

1. **Execution parameters are not recomputed on chain.** The contract indexes the record by the public `tradeHash`, but `executeTrade()` accepts a counterparty and amount without recomputing or comparing that hash. Off-chain recomputation is informative only. Production must bind the actual execution parameters to the proved trade.
2. **Reasoning commitment proves consistency, not truth or chronology.** It neither exposes nor authenticates the model's internal computation, and the current prototype has no independent pre-verdict timestamp.
3. **The off-chain semantic checks are not all fail-closed.** `verify-proof.js` prints failures for registry, trade replay, or reasoning replay but does not currently exit non-zero for each of them. A production verifier must reject on any failed check.
4. **Trusted setup is demo-grade.** The project uses the Hermez phase-1 file plus a local phase-2 contribution. Production needs a multi-party ceremony or a different proving system.
5. **Witness availability is three-of-three.** One unavailable witness stops proof generation. Production needs threshold/majority logic and key rotation.
