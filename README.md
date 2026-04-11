# SNAP — Shield Network Agent Payments

Private agent-to-agent payments on Solana using zero-knowledge proofs.

> Status: SNAP is in a tightly capped pre-audit pilot phase. Do not treat the current codebase or docs as post-audit production guidance.

## What SNAP Does

SNAP lets AI agents pay each other without on-chain observers learning who paid whom. Deposits enter a shielded pool under a cryptographic commitment. Withdrawals leave the pool with a Groth16 proof that shows the recipient is entitled to the funds without revealing which deposit is being claimed.

## How It Works

1. **Agent A** deposits SOL plus a commitment into the pool.
2. **Agent A** sends a secret note to Agent B through a private channel.
3. **Agent B** reconstructs the Merkle path and generates a Groth16 proof.
4. **Agent B** withdraws SOL with `withdraw_zk` or `withdraw_zk_relayed`.
5. **Observers** can see the pool activity, but they cannot link the withdrawal to a specific deposit.

## Quick Start

Install the SDK and its peer dependencies:

```bash
npm install snap-solana-sdk @solana/web3.js @coral-xyz/anchor
```

Minimal private payment:

```typescript
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { SNAPClient } from "snap-solana-sdk";

async function main() {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const sender = Keypair.generate();
  const recipient = Keypair.generate();
  const pool = new PublicKey("8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT");

  const snapA = new SNAPClient(connection, sender);
  const snapB = new SNAPClient(connection, recipient);

  const note = await snapA.deposit(pool, 0.1);
  const serialized = SNAPClient.serializeNote(note);
  await snapB.withdraw(pool, SNAPClient.deserializeNote(serialized), recipient);
}

void main();
```

If you want a runnable walkthrough from this repo, use:

```bash
npx tsx examples/basic-payment.ts
npx tsx examples/agent-to-agent.ts
npx tsx examples/relayed-withdrawal.ts
```

## Architecture

| Component | Description |
|-----------|-------------|
| Solana Program | Anchor program with `deposit`, `withdraw_zk`, and `withdraw_zk_relayed` |
| ZK Circuit | circom Groth16 circuit using Poseidon and a depth-10 Merkle tree |
| SDK | `snap-solana-sdk` for note handling, proof generation, and client API |
| Agent Kit Plugin | Solana Agent Kit v2 plugin with `snap_create_pool`, `snap_deposit`, `snap_withdraw`, and `snap_withdraw_private` |
| Relayer | Express service for gas-abstracted private withdrawals |

## Devnet

| Field | Value |
|-------|-------|
| Program ID | `AB4LhsmXkPQE97mHX2eLuX9AR43yzjWoNjCB6Bevi7M3` |
| Pool (0.1 SOL) | `8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT` |
| Network | Solana Devnet |

## Project Structure

```text
├── programs/           # Solana program (Rust/Anchor)
├── circuits/           # circom ZK circuit
├── sdk-package/        # snap-solana-sdk npm package
├── agent-kit-tool/     # Solana Agent Kit plugin
├── relayer/            # Express relay service
├── agents/             # Demo agent scripts
├── examples/           # Minimal end-to-end examples
├── scripts/            # Deployment and quickstart scripts
├── docs/               # Troubleshooting, circuit, and compliance docs
└── tests/              # Integration tests
```

## Development

```bash
# Build the Solana program
anchor build

# Run validator-backed tests
PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH" anchor test --skip-build

# Build and test the SDK package
cd sdk-package && npm install && npm run build && npm test
```

## Security

This is a pre-audit pilot. It is not audited and it is not production-safe. Known risks, protocol limits, and hardening work are documented in `FINDINGS.md`, `docs/CIRCUIT_SPEC.md`, `docs/COMPLIANCE.md`, and `docs/GOVERNANCE.md`.

## License

MIT
