# Changelog

## 0.1.0-beta.1 (unreleased)

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

- This is a devnet beta. Not audited. Not production-safe.
- See `FINDINGS.md` for the current security analysis and known gaps.
