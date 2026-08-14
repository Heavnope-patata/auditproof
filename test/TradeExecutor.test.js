const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TradeExecutor", function () {
  let deployer, agent, attacker;
  let mockAsset, verifier, executor;
  let validProof, validPubSignals;
  let witnessKeys;

  async function deployContracts() {
    [deployer, agent, attacker] = await ethers.getSigners();

    const Asset = await ethers.getContractFactory("MockAsset");
    mockAsset = await Asset.deploy(ethers.parseEther("1000000"));
    await mockAsset.waitForDeployment();

    // Give agent tokens and approve the executor in one step
    await mockAsset.transfer(agent, ethers.parseEther("100000"));
    const VF = await ethers.getContractFactory("Groth16VerifierFake");
    verifier = await VF.deploy();
    await verifier.waitForDeployment();

    // Six field-element witness public keys pinned at deployment
    witnessKeys = [1n, 2n, 3n, 4n, 5n, 6n];

    const Executor = await ethers.getContractFactory("TradeExecutor");
    executor = await Executor.deploy(
      await verifier.getAddress(),
      await mockAsset.getAddress(),
      12345n,
      witnessKeys
    );
    await executor.waitForDeployment();

    // Agent approves executor to pull tokens
    await mockAsset.connect(agent).approve(await executor.getAddress(), ethers.parseEther("100000"));

    // Valid proof structure -- Groth16VerifierFake accepts any non-empty calldata
    validProof = {
      pA: [1n, 2n],
      pB: [[1n, 2n], [3n, 4n]],
      pC: [1n, 2n],
    };
    // pubSignals: [isCompliant=1, policyHash=12345, tradeHash=99999, thoughtCommit, ...witnessKeys(6)]
    validPubSignals = [1n, 12345n, 99999n, 11111n, 1n, 2n, 3n, 4n, 5n, 6n];

    return { executor, verifier, mockAsset };
  }

  beforeEach(async () => {
    ({ executor, verifier, mockAsset } = await loadFixture(deployContracts));
    // Reset verifier to accepting state before each test
    if (await verifier.rejectAll()) await verifier.setRejectAll(false);
  });

  // ---------------------------------------------------------------------------
  // submitComplianceProof
  // ---------------------------------------------------------------------------
  describe("submitComplianceProof", function () {
    it("rejects an invalid proof", async function () {
      await verifier.setRejectAll(true);
      await expect(
        executor.connect(agent).submitComplianceProof(
          validProof.pA, validProof.pB, validProof.pC, validPubSignals
        )
      ).to.be.revertedWith("AuditProof: invalid proof");
    });

    it("rejects a proof with the wrong policy hash", async function () {
      const wrongSignals = [...validPubSignals];
      wrongSignals[1] = 99999n; // policyHash mismatch
      await expect(
        executor.connect(agent).submitComplianceProof(
          validProof.pA, validProof.pB, validProof.pC, wrongSignals
        )
      ).to.be.revertedWith("AuditProof: policy hash mismatch");
    });

    it("rejects a proof signed with an unregistered witness key", async function () {
      const wrongSignals = [...validPubSignals];
      wrongSignals[4] = 99999n; // first custodian key byte changed
      await expect(
        executor.connect(agent).submitComplianceProof(
          validProof.pA, validProof.pB, validProof.pC, wrongSignals
        )
      ).to.be.revertedWith("AuditProof: unregistered witness key");
    });

    it("rejects a duplicate tradeHash", async function () {
      await executor.connect(agent).submitComplianceProof(
        validProof.pA, validProof.pB, validProof.pC, validPubSignals
      );
      // Same tradeHash, different thoughtCommit (both fail at recordedAt check)
      const dupSignals = [1n, 12345n, 99999n, 22222n, 1n, 2n, 3n, 4n, 5n, 6n];
      await expect(
        executor.connect(agent).submitComplianceProof(
          validProof.pA, validProof.pB, validProof.pC, dupSignals
        )
      ).to.be.revertedWith("AuditProof: trade already recorded");
    });

    it("records a compliant trade and emits ComplianceRecorded", async function () {
      const tx = await executor.connect(agent).submitComplianceProof(
        validProof.pA, validProof.pB, validProof.pC, validPubSignals
      );
      await expect(tx).to.emit(executor, "ComplianceRecorded");
    });

    it("records a non-compliant trade (verdict 0) without reverting", async function () {
      const nonCompliantSignals = [0n, 12345n, 88888n, 22222n, 1n, 2n, 3n, 4n, 5n, 6n];
      const tx = await executor.connect(agent).submitComplianceProof(
        validProof.pA, validProof.pB, validProof.pC, nonCompliantSignals
      );
      await expect(tx).to.emit(executor, "TradeBlocked");
    });
  });

  // ---------------------------------------------------------------------------
  // executeTrade
  // ---------------------------------------------------------------------------
  describe("executeTrade", function () {
    beforeEach(async () => {
      // Re-submit compliance proof (beforeEach in describe scope does NOT re-run parent beforeEach)
      await executor.connect(agent).submitComplianceProof(
        validProof.pA, validProof.pB, validProof.pC, validPubSignals
      );
    });

    it("reverts if no compliance record exists", async function () {
      // Deploy a fresh executor with no records
      const VF = await ethers.getContractFactory("Groth16VerifierFake");
      const freshVerifier = await VF.deploy();
      const Exec = await ethers.getContractFactory("TradeExecutor");
      const freshExecutor = await Exec.deploy(
        await freshVerifier.getAddress(),
        await mockAsset.getAddress(),
        0n,
        [1n, 2n, 3n, 4n, 5n, 6n]
      );
      await expect(
        freshExecutor.connect(agent).executeTrade(99999n, deployer, 1000n)
      ).to.be.revertedWith("AuditProof: no compliance record for this trade");
    });

    it("reverts if caller is not the attesting agent", async function () {
      await expect(
        executor.connect(attacker).executeTrade(99999n, deployer, 1000n)
      ).to.be.revertedWith("AuditProof: caller is not the attesting agent");
    });

    it("reverts on a non-compliant trade", async function () {
      const nonCompliantSignals = [0n, 12345n, 77777n, 33333n, 1n, 2n, 3n, 4n, 5n, 6n];
      await executor.connect(attacker).submitComplianceProof(
        validProof.pA, validProof.pB, validProof.pC, nonCompliantSignals
      );
      await expect(
        executor.connect(attacker).executeTrade(77777n, deployer, 1000n)
      ).to.be.revertedWith("AuditProof: trade violates compliance policy");
    });

    it("reverts if trade already executed", async function () {
      await executor.connect(agent).executeTrade(99999n, deployer, 1000n);
      await expect(
        executor.connect(agent).executeTrade(99999n, deployer, 1000n)
      ).to.be.revertedWith("AuditProof: trade already executed");
    });

    it("executes a compliant trade and emits TradeExecuted", async function () {
      const tx = await executor.connect(agent).executeTrade(99999n, deployer, 1000n);
      await expect(tx).to.emit(executor, "TradeExecuted");
    });
  });

  // ---------------------------------------------------------------------------
  // getAuditRecord
  // ---------------------------------------------------------------------------
  describe("getAuditRecord", function () {
    it("returns exists=false for an unknown tradeHash", async function () {
      const rec = await executor.getAuditRecord(0n);
      expect(rec[0]).to.equal(false);
    });

    it("returns correct fields after a compliant submission", async function () {
      await executor.connect(agent).submitComplianceProof(
        validProof.pA, validProof.pB, validProof.pC, validPubSignals
      );
      const rec = await executor.getAuditRecord(99999n);
      expect(rec[0]).to.equal(true);   // exists
      expect(rec[1]).to.equal(true);  // compliant
      expect(rec[2]).to.equal(false); // executed
      expect(rec[3]).to.equal(12345n); // policyHash
    });
  });

  // ---------------------------------------------------------------------------
  // registerPolicy
  // ---------------------------------------------------------------------------
  describe("registerPolicy", function () {
    it("allows the compliance officer to update the policy hash", async function () {
      const newHash = 99999n;
      const tx = await executor.connect(deployer).registerPolicy(newHash);
      const receipt = await tx.wait();
      const evt = receipt.logs.find((l) => l.fragment?.name === "PolicyRegistered");
      expect(evt).to.not.be.undefined;
      expect(evt.args[0]).to.equal(newHash);
      expect(evt.args[1]).to.equal(deployer.address);
    });

    it("reverts if a non-officer tries to register a policy", async function () {
      await expect(
        executor.connect(agent).registerPolicy(99999n)
      ).to.be.revertedWith("AuditProof: not compliance officer");
    });
  });
});
