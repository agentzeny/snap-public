# SNAP Governance — Limited Release

> Status: governance posture for the SNAP limited release. This is intentionally simple while the protocol remains tightly capped.

## Upgrade Authority

The SNAP program's upgrade authority is held by the operator's deployer keypair.

### Key Management

The operator keypair serves as:

- Program upgrade authority
- Pool authority for fee-capable pools
- Initial deployer for capped mainnet pools

This key MUST be backed up in at least two physically separate locations.
Loss of this key means the program cannot be upgraded and pool treasury
addresses cannot be changed.

### Emergency Policy

If a critical vulnerability is discovered:

1. Deploy a patched program immediately using the operator key.
2. If active fund drain is possible, deploy a circuit breaker that pauses new deposits.
3. Notify known relayer operators.
4. Publish a security advisory.

### Future Governance

The single-key model is appropriate for a tightly capped release with small
denominations. Before increasing denomination caps or removing the
limited-release label, consider:

- Transferring upgrade authority to a multisig such as Squads
- Transferring pool authority to the same multisig
- Establishing a formal upgrade and change-management process

## Treasury Governance

Each fee-capable pool has a treasury address that receives protocol fees.
The treasury is updatable by the pool authority.

To change the treasury:

1. Run `snap.updateTreasury(poolAddress, newTreasuryPublicKey)` with the operator key.
2. Confirm the on-chain `TreasuryUpdated` event was emitted.
3. Verify the next fee-capable withdrawal pays the new treasury address.

## Pool Authority Capabilities

The pool authority can:

- Update the treasury address for a fee-capable pool

The pool authority cannot:

- Change the pool denomination
- Change the protocol fee BPS
- Withdraw funds without a valid ZK proof
- Rewrite the Merkle tree
- Override nullifier checks
