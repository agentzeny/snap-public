# Changelog

## 0.1.0 — Mainnet Limited Release

### Added
- Mainnet deployment on Solana mainnet-beta
- Three shielded pools: 0.1 SOL, 1 USDC, 10 USDC
- Mainnet deployment, pool creation, seeding, and verification scripts
- Mainnet relayer launcher and dashboard
- Protocol fee (0.25%) on all fee-capable pool withdrawals
- Mutable treasury with update_treasury instruction

### Security
- Limited release. Not audited. Not for large amounts.
- See FINDINGS.md and docs/THREAT_MODEL.md for full risk assessment.

## 0.1.0-beta.1

### Added

- Core shielded pool program with deposit and ZK withdrawal
- Relayed withdrawal with atomic fee splitting
- On-chain Groth16 verification within Solana compute limits
- Incremental Poseidon Merkle root updates with 30-root history validation
- Dynamic commitment and nullifier storage with account realloc
- `snap-solana-sdk` npm package with note serialization, proof generation, and relayer support
- Solana Agent Kit v2 plugin with `snap_create_pool`, `snap_deposit`, `snap_withdraw`, and `snap_withdraw_private`
- Demo relayer service with configurable fees
- circom ZK circuit with Poseidon hashing and Merkle inclusion proofs
- Developer quickstart, troubleshooting guide, and runnable onboarding examples

### Security

- This is a devnet beta for review and testing. Not audited.
- See `FINDINGS.md` for the current security analysis and known gaps.
