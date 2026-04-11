# SNAP Trusted Setup Ceremony Record

## Ceremony Type
Single-contributor Groth16 ceremony for the SNAP withdraw circuit (depth-20).

## Status
**Pre-audit pilot ceremony.** This is NOT a multi-party ceremony.
A multi-party ceremony with public transcripts is planned before
removing the "pilot" label and increasing pool denomination caps.

## Date
2026-04-09T23:39:16.866Z

## Circuit
- File: circuits/withdraw_20.circom
- Depth: 20
- Constraint count: 11313

## Powers of Tau
- Source: powersOfTau28_hez_final_15.ptau
- Mirror: storage.googleapis.com/zkevm/ptau/

## Artifact Hashes (SHA-256)
| Artifact | Hash |
|----------|------|
| withdraw_20_final.zkey | 4cd39f492015d017a98eeb9ebd78a5f5998dae4b42498bb967e8c2c25c525a4c |
| verification_key_20.json | 8f5998f3be2dace69ff792c8ff6056131965fe9754c6a2c0aadd49df2718eedd |
| withdraw_20.wasm | cd0cfa0d9d1b3ef0c2136a6cf64496e348345f631409a021079666fdb5bedb31 |
| withdraw_20.r1cs | 7399cd357f91421e357c2a15c0a303d09f2516015c434eeadfcdd5a8948e5527 |

## Process
1. Circuit compiled with circom 2.2.3
2. Initial zkey generated from r1cs + ptau
3. Single contribution with operator-provided entropy
4. Verification key exported
5. zkey verified against r1cs and ptau
6. Intermediate zkey (withdraw_20_0000.zkey) securely deleted
7. Verifying key constants generated for the Rust program

## Honest Assessment
- This ceremony has one contributor
- There is no independently auditable evidence that toxic waste was destroyed
- If toxic waste was retained, proofs can be forged and pools drained
- For a capped pilot with small denominations, this risk is bounded
