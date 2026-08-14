// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// A configurable stub verifier for unit testing TradeExecutor.
//
// Usage in tests:
//   const vf = await ethers.getContractFactory("Groth16VerifierFake");
//   const fake = await vf.deploy();
//   // Make it always reject (test invalid proof):
//   await fake.setRejectAll(true);
//   // Make it accept again:
//   await fake.setRejectAll(false);
//
// In real deployments this is replaced by the snarkjs-generated Verifier.sol
// from circuits/build.sh.
contract Groth16VerifierFake {
    bool public rejectAll = false;

    function setRejectAll(bool flag) external {
        rejectAll = flag;
    }

    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[10] calldata
    ) external view returns (bool) {
        return !rejectAll;
    }
}
