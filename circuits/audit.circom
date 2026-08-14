pragma circom 2.0.0;

include "circomlib/circuits/eddsaposeidon.circom";
include "circomlib/circuits/poseidon.circom";

template AuditProof() {
    signal input policyHash;
    signal input tradeHash;
    signal input thoughtCommit;
    signal input custodianPubKey[2];
    signal input oraclePubKey[2];
    signal input sanctionsPubKey[2];

    signal input custodianResult;
    signal input custodianSigR8[2];
    signal input custodianSigS;

    signal input oracleResult;
    signal input oracleSigR8[2];
    signal input oracleSigS;

    signal input sanctionsResult;
    signal input sanctionsSigR8[2];
    signal input sanctionsSigS;

    signal input thoughtDigest;

    custodianResult * (custodianResult - 1) === 0;
    oracleResult * (oracleResult - 1) === 0;
    sanctionsResult * (sanctionsResult - 1) === 0;

    component ctx = Poseidon(2);
    ctx.inputs[0] <== policyHash;
    ctx.inputs[1] <== tradeHash;

    // Reasoning commitment participates in the context: all three institutional signatures
    // simultaneously endorse "this trade + this reasoning". The agent must fix its reasoning
    // before it learns any compliance verdict; changing it afterwards invalidates all three signatures.
    component ctxFull = Poseidon(2);
    ctxFull.inputs[0] <== ctx.out;
    ctxFull.inputs[1] <== thoughtCommit;

    component msgCustodian = Poseidon(2);
    msgCustodian.inputs[0] <== custodianResult;
    msgCustodian.inputs[1] <== ctxFull.out;

    component msgOracle = Poseidon(2);
    msgOracle.inputs[0] <== oracleResult;
    msgOracle.inputs[1] <== ctxFull.out;

    component msgSanctions = Poseidon(2);
    msgSanctions.inputs[0] <== sanctionsResult;
    msgSanctions.inputs[1] <== ctxFull.out;

    component vCustodian = EdDSAPoseidonVerifier();
    vCustodian.enabled <== 1;
    vCustodian.Ax  <== custodianPubKey[0];
    vCustodian.Ay  <== custodianPubKey[1];
    vCustodian.R8x <== custodianSigR8[0];
    vCustodian.R8y <== custodianSigR8[1];
    vCustodian.S   <== custodianSigS;
    vCustodian.M   <== msgCustodian.out;

    component vOracle = EdDSAPoseidonVerifier();
    vOracle.enabled <== 1;
    vOracle.Ax  <== oraclePubKey[0];
    vOracle.Ay  <== oraclePubKey[1];
    vOracle.R8x <== oracleSigR8[0];
    vOracle.R8y <== oracleSigR8[1];
    vOracle.S   <== oracleSigS;
    vOracle.M   <== msgOracle.out;

    component vSanctions = EdDSAPoseidonVerifier();
    vSanctions.enabled <== 1;
    vSanctions.Ax  <== sanctionsPubKey[0];
    vSanctions.Ay  <== sanctionsPubKey[1];
    vSanctions.R8x <== sanctionsSigR8[0];
    vSanctions.R8y <== sanctionsSigR8[1];
    vSanctions.S   <== sanctionsSigS;
    vSanctions.M   <== msgSanctions.out;

    component tc = Poseidon(2);
    tc.inputs[0] <== thoughtDigest;
    tc.inputs[1] <== tradeHash;
    tc.out === thoughtCommit;

    signal andAB;
    andAB <== custodianResult * oracleResult;

    signal output isCompliant;
    isCompliant <== andAB * sanctionsResult;
}

component main {public [
    policyHash,
    tradeHash,
    thoughtCommit,
    custodianPubKey,
    oraclePubKey,
    sanctionsPubKey
]} = AuditProof();
