# `snap-solana-sdk`

Shielded agent-to-agent payments on Solana with automatic Groth16 proof generation.

> Status: `snap-solana-sdk` is for the SNAP pre-audit pilot. It is not post-audit production software.

## Quick Start (Devnet)

SNAP is live on Solana devnet. Try it now:

```bash
npm install snap-solana-sdk @solana/web3.js @coral-xyz/anchor
```

```ts
import { SNAPClient } from "snap-solana-sdk";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";

const connection = new Connection(clusterApiUrl("devnet"));
const wallet = Keypair.generate();

const snap = new SNAPClient(connection, wallet, {
  maxDepositDelayMs: 10000,
  maxWithdrawDelayMs: 15000,
});

// Deposit into the shielded pool
const POOL = new PublicKey("8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT");
const note = await snap.deposit(POOL);

// Share `note` with the recipient off-chain
const serialized = SNAPClient.serializeNote(note);

// Recipient withdraws with ZK proof
const restored = SNAPClient.deserializeNote(serialized);
const recipientKeypair = Keypair.generate();
const recipientSnap = new SNAPClient(connection, recipientKeypair);
const tx = await recipientSnap.withdraw(POOL, restored, recipientKeypair);
```

### Devnet Details

| Field | Value |
|-------|-------|
| Program ID | `AB4LhsmXkPQE97mHX2eLuX9AR43yzjWoNjCB6Bevi7M3` |
| Pool (0.1 SOL) | `8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT` |
| Network | Solana Devnet |
| Explorer | [View Program](https://explorer.solana.com/address/AB4LhsmXkPQE97mHX2eLuX9AR43yzjWoNjCB6Bevi7M3?cluster=devnet) |

## Quick Start

```ts
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { SNAPClient } from "snap-solana-sdk";

const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const wallet = Wallet.local();
const snap = new SNAPClient(connection, wallet);

const pool = await snap.createPool(0.1);
const note = await snap.deposit(pool);
const serialized = SNAPClient.serializeNote(note);

// Send `serialized` to the recipient through a private channel.

const recipient = Keypair.generate();
const txSig = await snap.withdraw(pool, SNAPClient.deserializeNote(serialized), recipient);
console.log("Withdraw tx:", txSig);
```

## Public API

```ts
import { SNAPClient } from "snap-solana-sdk";

const snap = new SNAPClient(connection, wallet);

const note = await snap.deposit(poolAddress, 0.1);
const txSig = await snap.withdraw(poolAddress, note, recipientKeypair);
```

### Notes

- `deposit()` always uses the pool's fixed denomination. If you pass `amount`, it must match the pool denomination.
- `withdraw()` rebuilds the Poseidon Merkle tree, generates the witness, produces the Groth16 proof, formats it for Solana, and submits the transaction.
- `withdrawViaRelayer()` signs the relayer request with a one-time Ed25519 session key derived from the agent spending key or a Keypair-backed wallet seed. That signature is only the transport envelope: the relayer also verifies the proof off-chain and binds the signed request to the exact `proof/root/nullifier/recipient/fee/timestamp` tuple before it submits anything.
- `maxDepositDelayMs` and `maxWithdrawDelayMs` add cryptographically random timing jitter with `crypto.getRandomValues()` to reduce simple timing-correlation attacks.
- `serializeNote()` returns a JSON-safe string. Anyone with the note can withdraw the funds, so it must stay off-chain and private.

## Security Model

### Bearer Notes

**Anyone with the note can withdraw the funds.** A note contains the
`secret` and `nullifier` that generate the ZK proof. There is no
additional key-based authorization on-chain. Protect notes like
private keys.

### Viewing Keys

The viewing key can decrypt an agent's note history for audit purposes.
It cannot spend funds or recover the spending key. This supports the
selective-disclosure compliance model described in `docs/COMPLIANCE.md`.

### Spending Keys

The spending key seeds the agent's Solana wallet and signs relayer
request payloads. It does NOT control on-chain withdrawals. The
note controls that. This is a transport credential, not a protocol
authorization key.

## Assets

The package ships the proving artifacts in `assets/`:

- `withdraw.wasm`
- `withdraw_final.zkey`

They are loaded at runtime from the installed package directory.
