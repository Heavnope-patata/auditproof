# Day 3 deliverable: demo UI, presentation, and submission checklist

## 1. Know what each demo control proves

| Action | Real behaviour | Does not do |
|---|---|---|
| Live Policy Compiler | Calls Claude to turn a natural-language rule into schema-validated policy JSON | It does not generate the ZK proof by itself |
| UI **Run pipeline** | Uses the scenario's compiled policy, calls the three running witness services, runs `snarkjs`, and invokes `verify-proof.js` | It does not submit a transaction |
| UI **Play demo** | Plays an illustrative fallback animation with placeholder public signals | It is not cryptographic or on-chain evidence |
| `npm run chain:demo` | Deploys contracts to the separately running local Hardhat network, submits existing proofs, and attempts execution | It is not triggered by the UI |

Show the real Policy Compiler once before the UI demo. The downstream scenario keeps a precompiled copy of the same policy so an API or network delay cannot break proof generation on stage. This preserves the Claude-based innovation while keeping the ZK demo reliable.

Use **Run pipeline** when claiming that a proof was generated. Label **Play demo** as a visual backup. Use terminal output from `chain:demo` as the evidence for recording, execution, and reverts.

The privacy claim should also be precise:

> No witness-private source records are disclosed to the agent or the chain. Each witness returns only a signed verdict and context metadata.

The agent necessarily knows its own trade request, and the current demo stores the agent's reasoning in `audit_record.json`; do not claim that literally zero data exists outside the witness processes.

## 2. Reliable startup sequence

Complete the Day 2 build first:

```bash
npm ci
npm run genkeys
npm run build-circuit
npm run day2:demo
```

Before the presentation, configure `ANTHROPIC_API_KEY`. During the presentation, demonstrate one real compilation:

```bash
npm run compile-policy -- "A single trade must not exceed 5% of portfolio NAV; the counterparty must not be sanctioned; the trade must occur during global market hours."
```

Keep the returned policy JSON visible long enough to point out normalized units and `ambiguity_notes`, then move to the UI for the witness and ZK stages.

Then start the UI with four long-running terminals:

```bash
# Terminal 1
npm run witness:custodian

# Terminal 2
npm run witness:oracle

# Terminal 3
npm run witness:sanctions

# Terminal 4
npm run ui
# Open http://localhost:4000
```

Do not paste the three witness commands sequentially into one terminal: the first server stays in the foreground. On Windows, use WSL or Git Bash for `build-circuit` and `day2:demo`; use separate terminals for the services.

For the on-chain segment, keep a fifth terminal running `npm run chain:node`, then run `npm run chain:demo` from another terminal. Confirm that `contracts/Verifier.sol` exists so the demo does not fall back to `Groth16VerifierFake`.

## 3. Seven-minute finalist pitch

### 0:00-0:40 — Problem

An autonomous agent can place a real trade, but the data needed to audit it is split across parties that cannot disclose their full datasets. AuditProof lets those parties attest to their own facts and combines the attestations into one verifiable result.

### 0:40-1:20 — Why the obvious alternatives fail

Full disclosure leaks regulated or commercially sensitive data. Agent self-attestation leaves the auditee in control of the audit evidence. Explain why independent witnesses plus ZK are needed.

### 1:20-2:00 — Live Policy Compiler

Run `npm run compile-policy -- "..."` with the compliance rule. Point out that Claude converts the officer's rule into schema-validated JSON, normalizes percentages and time, and surfaces ambiguity instead of silently guessing.

Explain that the UI uses the saved result of this compilation so the remaining cryptographic demo does not depend on a second API call.

### 2:00-3:00 — Compliant proof

In the UI, choose `compliant` and click **Run pipeline**.

- Point to `ambiguity_notes` and connect it to the live compiler output just shown.
- Point out that each witness sees only the fields needed for its local check and returns a signed verdict.
- When the ten public signals appear, identify `isCompliant`, `policyHash`, `tradeHash`, `thoughtCommit`, and the six witness-key coordinates.
- Do not say that this UI action already wrote to the chain; it has completed the off-chain proof and verification stages.

### 3:00-3:50 — Policy violation

Run `violation-oversize`. A valid proof is still generated, but its public verdict is `0`. Explain that the contract's separate submit and execute functions allow a valid non-compliant verdict to be recorded while execution later reverts.

### 3:50-4:40 — Commitment consistency test

Run `attack-forged-thought`. The circuit refuses to generate a proof because the supplied reasoning digest does not match the published commitment.

Use the narrow claim: the commitment prevents two different reasoning texts from satisfying the same proof. It does not prove that the text is the model's genuine internal chain of thought, nor does this prototype independently prove a pre-verdict timestamp.

### 4:40-6:00 — On-chain evidence

Switch to the terminal and run:

```bash
npm run chain:demo
```

Show the successful compliant execution, the three rejected executions, unchanged balances for rejected trades, `getAuditRecord`, and the final audit count of four.

### 6:00-7:00 — Impact and close

Connect the prototype to a concrete first buyer and workflow. End with the exact value proposition: independently issued compliance verdicts can be verified without centralizing each institution's private source data.

## 4. Backup evidence checklist

Capture real output in advance and label it accurately:

1. UI **Run pipeline** on `compliant`, including witness cards, public signals, and verification output.
2. UI **Run pipeline** on `violation-oversize`, showing a valid proof with `isCompliant=0`.
3. The failed `attack-forged-thought` proof-generation log, labelled as a commitment-consistency test.
4. `snarkjs r1cs info circuits/build/audit.r1cs` output.
5. Full `npm run chain:demo` output: one execution, three reverts, and four audit records.
6. `verify-proof.js` output with every semantic line visibly marked `PASS`.

The **Play demo** animation may be included as an architecture explainer, but not as proof that the cryptographic or chain pipeline ran.

## 5. Stage 1 online-submission checklist

The [Devpost overview](https://ntu-cctf-snz-innovatex-2026.devpost.com/) and [official rules](https://ntu-cctf-snz-innovatex-2026.devpost.com/rules) currently contain a deadline inconsistency: the top banner shows **14 August 2026, 11:45 PM SGT**, while the requirements and rules text state **11:59 PM SGT**. Treat **11:45 PM SGT** as the safe operational cutoff and submit earlier if possible.

- [ ] Project title, short description, Track 2, and team type are complete.
- [ ] Problem, solution, key features, target users, and proposed technologies are explained in English.
- [ ] `docs/screenshot-ui.png` is attached as the required supporting file.
- [ ] Every team member's name and affiliation is listed; a primary contact email is provided.
- [ ] If entering as a Student Group, proof of current student status is supplied for every member.
- [ ] Sponsor tools, APIs, and infrastructure are disclosed where applicable.
- [ ] `witness-services/*/.env`, generated private keys, and other secrets are absent from the repository and submission files.
- [ ] Repository or live-demo links are included if ready; they are recommended, not mandatory for Stage 1.
- [ ] The written description matches the actual boundary between the Policy Compiler, UI proof flow, and chain demo.

A completed product is not required for Stage 1. Prioritize a clear, accurate submission and strong supporting material over packaging every generated proving artifact.

## 6. Stage 2 finalist preparation

If shortlisted for the on-site round, prepare a functional prototype, updated project description, implementation details, live presentation and Q&A, supporting visuals, and a repository/project link where available. At least one team representative must attend in person.

## 7. Judging-criteria mapping

| Dimension | Weight | Evidence to show |
|---|---:|---|
| Technical Quality | 30% | In-circuit signature verification, context binding, pinned keys, real proof output, contract tests, and real chain execution |
| Innovation | 20% | A single proof combines independent private-data verdicts with a trade-specific reasoning commitment |
| Real-World Impact | 25% | Clear first buyer, regulatory workflow, and path from demo witnesses to real data providers |
| Demo and Presentation | 15% | Reliable live run, accurate labels, concise failure-mode comparison, and backup recording |
| Track Relevance | 10% | AI-agent workflow plus verifiable on-chain enforcement and audit records |

The rules also mention sponsor integration where relevant, even though the public overview's weighted table totals 100% without a separate sponsor percentage. State sponsor usage accurately rather than forcing an integration.
