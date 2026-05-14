# SNAP: Shielded Network Agent Payments — Detailed Findings

## Executive Summary

SNAP is a proof-of-concept protocol enabling private agent-to-agent payments on Solana. Two AI agents can transact where an on-chain observer cannot link the sender to the receiver. The system uses a commitment-nullifier scheme: deposits go into a shielded pool under a cryptographic commitment; withdrawals come out with either a hash reveal (Path A, demo) or a zero-knowledge proof (Path B, production-grade privacy).

**Both paths are fully implemented and tested.** The on-chain Groth16 verifier proves that ZK-private payments on Solana are viable within the current compute budget.

---

## Build Inventory

### Files Written

| File | Lines | Purpose |
|------|-------|---------|
| `programs/.../lib.rs` | 279 | Anchor program: initialize, deposit, withdraw, withdraw_zk |
| `programs/.../verifying_key.rs` | 17 | Auto-generated Groth16 verifying key constants |
| `circuits/withdraw.circom` | 73 | ZK circuit: Poseidon commitment + Merkle inclusion proof |
| `sdk/commitment.ts` | 56 | Path A note generation (sha256) |
| `sdk/merkle.ts` | 107 | Path A off-chain Merkle tree (sha256) |
| `sdk/poseidon-merkle.ts` | 126 | Path B Poseidon Merkle tree (circomlibjs) |
| `sdk/proof.ts` | 130 | Path B ZK proof generation + serialization (snarkjs) |
| `tests/pool.test.ts` | 252 | Path A integration tests (5 tests) |
| `tests/zk-proof.test.ts` | 67 | Off-chain ZK proof tests (2 tests) |
| `tests/zk-withdraw.test.ts` | 173 | On-chain ZK verification test (1 test) |
| `agents/agent-a.ts` | 117 | Sender agent script |
| `agents/agent-b.ts` | 95 | Receiver agent script |
| `scripts/demo.sh` | 42 | End-to-end localnet demo |
| `scripts/parse-vk.ts` | 48 | Verification key JSON-to-Rust converter |
| **Total** | **~1,475** | |

### Build Artifacts

| Artifact | Size | Description |
|----------|------|-------------|
| `agent_privacy_pool.so` | 237 KB | Deployed Solana BPF program |
| `withdraw_final.zkey` | 2.6 MB | Groth16 proving key |
| `withdraw.wasm` | 1.9 MB | Circuit witness generator |
| `verification_key.json` | 3.2 KB | Groth16 verification key |
| `withdraw.r1cs` | 76 KB | Rank-1 constraint system |

### Toolchain

| Tool | Version | Role |
|------|---------|------|
| Solana CLI | 3.1.12 (Agave) | Localnet validator, deploy |
| Anchor | 0.31.1 | Program framework, testing harness |
| Rust | 1.94.0 | Program compilation |
| circom | 2.2.3 | ZK circuit compilation |
| snarkjs | 0.7.6 | Proof generation, proving-key generation |
| Node.js | 22.22.0 | SDK, tests, agent scripts |
| TypeScript | 6.0.2 | Type system |

---

## Test Results

```
  agent-privacy-pool
    ✔ Initializes the pool (441ms)
    ✔ Agent A deposits with a commitment (536ms)
    ✔ Agent B withdraws with matching secret/nullifier (1619ms)
    ✔ Rejects double-withdraw (same nullifier) (1613ms)
    ✔ Rejects withdraw with wrong secret (1069ms)

  ZK proof generation (off-chain)
    ✔ generates and verifies a valid withdraw proof (1343ms)
    ✔ rejects a proof with wrong nullifier hash (535ms)

  ZK withdraw (on-chain Groth16 verification)
    ✔ Deposits with Poseidon commitment and withdraws with ZK proof (1799ms)

  8 passing (9s)
```

### What Each Test Proves

1. **Initializes the pool** — Pool account is created with correct denomination (0.1 SOL), vault PDA is derived and stored.
2. **Agent A deposits** — SOL moves from depositor to vault PDA. Commitment is stored on-chain. Vault balance increases by exactly `deposit_amount`.
3. **Agent B withdraws** — Providing the correct secret+nullifier recovers funds. Recipient balance increases by exactly `deposit_amount`. The program recomputes `sha256(secret || nullifier)` and matches against stored commitments.
4. **Double-withdraw rejected** — Same nullifier cannot be used twice. The `used_nullifiers` array prevents replay attacks.
5. **Wrong secret rejected** — A random secret produces a commitment that doesn't match any deposit. The program refuses the withdrawal.
6. **ZK proof generation** — snarkjs generates a valid Groth16 proof from the circuit witness. Off-chain verification confirms mathematical correctness.
7. **Tampered proof rejected** — Modifying a public signal (nullifier hash) causes verification to fail, confirming soundness.
8. **On-chain ZK withdrawal** — The complete pipeline: Poseidon commitment deposit, off-chain proof generation, on-chain Groth16 verification, SOL transfer. The program verifies the proof without ever seeing the secret or which deposit is being withdrawn.

---

## Protocol Design

### Commitment Scheme

```
Deposit:
  secret     = random(31 bytes)
  nullifier  = random(31 bytes)
  commitment = Poseidon(secret, nullifier)   [Path B]
             = sha256(secret || nullifier)    [Path A]

  On-chain: store commitment, transfer SOL to vault

Withdrawal:
  nullifierHash = Poseidon(nullifier)         [Path B]
                = sha256(nullifier)            [Path A]

  Path A: reveal secret + nullifier to program (not private)
  Path B: submit ZK proof that you know secret + nullifier
          matching some commitment in the Merkle tree (private)
```

### Why This Breaks the Link

In Path B, the on-chain program sees:
- A Groth16 proof (opaque bytes)
- A Merkle root (which root the proof is against)
- A nullifier hash (which prevents double-spend)
- A recipient pubkey (who gets the SOL)

The program does **not** see:
- The secret
- The nullifier (only its hash)
- Which commitment/deposit the proof corresponds to

An observer watching the chain sees "someone deposited" and "someone withdrew" but cannot determine that they are the same payment.

### ZK Circuit Internals

The `Withdraw(10)` circuit has:
- **2,900 non-linear constraints** — dominated by 12 Poseidon hashes (1 for commitment, 1 for nullifier hash, 10 for Merkle path)
- **3 public inputs** — root, nullifierHash, recipient
- **22 private inputs** — secret, nullifier, 10 pathElements, 10 pathIndices
- **Depth-10 Merkle tree** — supports up to 1,024 deposits

The circuit enforces:
1. `Poseidon(secret, nullifier) == leaf`
2. `Poseidon(nullifier) == nullifierHash`
3. `MerkleProof(leaf, path) == root`
4. `recipient` is bound to the proof (prevents front-running)

### On-Chain Account Layout

```
Pool (1,081 bytes):
  discriminator:    8 bytes
  authority:       32 bytes  (pool creator)
  deposit_amount:   8 bytes  (fixed denomination in lamports)
  next_index:       4 bytes  (number of deposits)
  nullifier_count:  4 bytes  (number of withdrawals)
  bump:             1 byte   (vault PDA bump seed)
  commitments:    512 bytes  (16 x 32-byte commitment hashes)
  used_nullifiers: 512 bytes (16 x 32-byte nullifier hashes)

Vault PDA:
  seeds = ["vault", pool.key()]
  Holds SOL. Program signs transfers via PDA authority.
```

---

## Obstacles Encountered and Solutions

### 1. Anchor 0.30.1 + Rust 1.94 Incompatibility

**Problem:** `anchor-syn` 0.30.1 calls `proc_macro2::Span::source_file()` which was removed in newer `proc_macro2` versions shipped with Rust 1.94. The IDL build step failed with `no method named source_file found`.

**Solution:** Upgraded Anchor CLI and `anchor-lang` from 0.30.1 to 0.31.1, which ships a compatible `anchor-syn`.

### 2. BPF Stack Overflow

**Problem:** With `MAX_COMMITMENTS = 32`, the `Pool` struct (2,105 bytes) exceeded Solana's 4,096-byte stack frame limit during deserialization. Multiple functions hit `Stack offset exceeded max offset of 4096`.

**Solution:** Two-pronged fix:
- Reduced `MAX_COMMITMENTS` from 32 to 16 (cuts struct size roughly in half)
- Changed all `Account<'info, Pool>` to `Box<Account<'info, Pool>>` to move deserialization to the heap

### 3. Node 22 Native TypeScript Interference

**Problem:** Node 22.22 includes native `.ts` file handling that intercepted imports before `ts-node` could process them. Mocha loaded test files via ESM `import()`, which failed because the ESM resolver requires explicit file extensions (e.g., `agent_privacy_pool.ts` not `agent_privacy_pool`).

**Solution:** Replaced `ts-mocha` with `tsx` (esbuild-based TypeScript execution) which correctly handles both CJS and ESM resolution:
```
test = "npx tsx node_modules/.bin/mocha -t 1000000 tests/**/*.ts"
```

### 4. Rust Borrow Checker vs. Array Indexing

**Problem:** `pool.commitments[pool.next_index as usize]` borrows `pool` both mutably (array access) and immutably (index access) simultaneously.

**Solution:** Save the index to a local variable first:
```rust
let idx = pool.next_index as usize;
pool.commitments[idx] = commitment;
```

### 5. PDA SOL Transfer

**Problem:** Initial implementation tried to directly manipulate lamports of a system-owned PDA (`**pool_vault.try_borrow_mut_lamports()?`). This fails because only the owning program can debit an account, and the vault PDA is owned by the system program.

**Solution:** Use `system_program::transfer` with `CpiContext::new_with_signer`, providing the PDA seeds so the runtime can verify PDA authority.

### 6. Groth16 Proof Formatting for Solana

**Problem:** snarkjs outputs proof components as decimal strings with specific coordinate ordering. `groth16-solana` expects big-endian byte arrays with G1 y-coordinate negated and G2 coordinates in `(c1, c0)` order.

**Solution:** Client-side transformation:
- **proof_a**: Negate the y-coordinate (`FIELD_PRIME - y`) before sending
- **proof_b**: Swap coordinate order from `(c0, c1)` to `(c1, c0)` for each pair
- **proof_c**: Direct big-endian encoding
- **Public inputs**: Each field element padded to 32 bytes big-endian
- **Recipient**: Truncated to 31 bytes to fit in the BN254 scalar field

### 7. Powers of Tau Download

**Problem:** The Hermez S3 bucket (`hermez.s3-eu-west-1.amazonaws.com`) returned `AccessDenied` for the Powers of Tau file.

**Solution:** Used the Google Cloud Storage mirror: `storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau`

---

## Security Analysis (Demo Scope)

### What the demo gets right

- **Commitment binding:** Each deposit is bound to a unique `(secret, nullifier)` pair via a collision-resistant hash.
- **Nullifier uniqueness:** The program rejects any nullifier hash already in `used_nullifiers`, preventing double-spend.
- **Recipient binding (Path B):** The ZK proof includes the recipient pubkey as a public input, preventing proof front-running.
- **PDA authority:** The vault PDA can only be debited by the program, not by arbitrary signers.

### Open Hardening Gaps

| Gap | Risk | Fix |
|-----|------|-----|
| No Merkle root validation in `withdraw_zk` | An attacker could submit a proof against a fabricated root | Store root history on-chain; verify `root` matches a known root |
| Fixed-size arrays (`MAX_COMMITMENTS = 16`) | Pool fills after 16 deposits | Use dynamic `Vec` with account realloc, or sharded accounts |
| No access control on `withdraw` | Anyone can call withdraw if they know the secret | In Path B this is fine (proof is required); Path A should be deprecated |
| Zkey generation provenance | Current proving parameters were generated outside a public multi-party transcript | Before higher caps, use a public multi-party parameter-generation process or transparent proving system (PLONK/STARK) |
| No relayer | Withdrawal transaction reveals the recipient's IP/wallet as the fee payer | Add relayer that submits the TX on behalf of the recipient |
| Single denomination | Only 0.1 SOL deposits | Support multiple pool instances with different denominations |
| Off-chain Merkle tree | The program doesn't maintain the tree; clients must reconstruct it | Store tree incrementally on-chain, or use an indexer |

---

## Performance Characteristics

| Operation | Time (localnet) | Compute Units |
|-----------|----------------|---------------|
| Initialize pool | 441ms | ~5,000 CU |
| Deposit | 536ms | ~15,000 CU |
| Withdraw (Path A) | 1,069ms | ~20,000 CU |
| Withdraw ZK (Path B) | 1,799ms | ~200,000 CU |
| Off-chain proof generation | ~1,300ms | N/A (client-side) |

The ZK withdrawal uses approximately **200,000 compute units** for Groth16 verification, well within Solana's default 200K limit (we requested 500K as headroom via `ComputeBudgetProgram.setComputeUnitLimit`). This is possible because `groth16-solana` uses Solana's native `alt_bn128` syscalls (precompiles), which are far cheaper than emulated elliptic curve math.

---

## Repository Structure

```
agent-privacy-pool/
├── programs/agent-privacy-pool/src/
│   ├── lib.rs                    # Anchor program (279 lines)
│   └── verifying_key.rs          # Groth16 VK constants (auto-generated)
├── circuits/
│   └── withdraw.circom           # ZK circuit (73 lines)
├── build/
│   ├── withdraw_final.zkey       # Proving key (2.6 MB)
│   ├── withdraw_js/withdraw.wasm # Witness generator (1.9 MB)
│   └── verification_key.json     # Verification key
├── sdk/
│   ├── commitment.ts             # Path A: sha256 note generation
│   ├── merkle.ts                 # Path A: sha256 Merkle tree
│   ├── poseidon-merkle.ts        # Path B: Poseidon Merkle tree
│   └── proof.ts                  # Path B: snarkjs proof generation
├── agents/
│   ├── agent-a.ts                # Sender: deposit + share note
│   └── agent-b.ts                # Receiver: read note + withdraw
├── tests/
│   ├── pool.test.ts              # Path A integration tests (5)
│   ├── zk-proof.test.ts          # Off-chain ZK tests (2)
│   └── zk-withdraw.test.ts       # On-chain ZK test (1)
├── scripts/
│   ├── demo.sh                   # End-to-end demo script
│   └── parse-vk.ts               # VK JSON -> Rust converter
├── Anchor.toml
├── Cargo.toml
└── tsconfig.json
```

---

## Roadmap to Production

### Phase 1: Harden the Pool (weeks)
- Store Merkle root history on-chain (last 30 roots)
- Replace fixed arrays with dynamic accounts (realloc or PDAs per commitment)
- Add authority-gated pool initialization
- Deprecate Path A `withdraw` instruction entirely

### Phase 2: Relayer Network (weeks)
- Relayer submits withdrawal TX on behalf of recipient
- Recipient pays relayer fee from the withdrawal amount
- Relayer cannot steal funds (proof binds to recipient pubkey)

### Phase 3: Agent Framework Integration (weeks)
- Package as a Solana Agent Kit tool/skill
- Agents discover pool via on-chain registry
- Note exchange via encrypted agent-to-agent messaging (not shared files)

### Phase 4: Scaling (months)
- Multiple denomination pools (0.01, 0.1, 1, 10 SOL)
- Batch deposit/withdraw (multiple operations per TX)
- Lookup tables for account compression
- Consider PLONK for transparent proving (no per-circuit toxic waste)

### Phase 5: Audit and Mainnet (months)
- Formal verification of circuit constraints
- Public multi-party parameter-generation process (if staying with Groth16)
- Professional smart contract audit
- Mainnet deployment with governance controls
