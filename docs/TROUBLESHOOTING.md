# SNAP Troubleshooting

> Status: troubleshooting notes for the SNAP limited release. Operational fixes here do not change the review-stage security limitations documented elsewhere in the repo.

## Common Errors

### "Program failed to complete" / compute budget exceeded

SNAP ZK withdrawals need extra compute budget for Groth16 verification. The SDK adds this automatically. If you are building the instruction yourself, add a compute-budget pre-instruction before `withdraw_zk` or `withdraw_zk_relayed`:

```typescript
import { ComputeBudgetProgram } from "@solana/web3.js";

const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 });
```

### "InvalidRoot" error

Your proof was generated against a Merkle root that is no longer in the pool's 30-root history. Regenerate the proof from the current pool state and resubmit the withdrawal.

### "NullifierAlreadyUsed" error

That note has already been spent. Each note can only be withdrawn once.

### "Pool not found" / "Account not found"

The pool account is missing or the address is wrong. Verify the live devnet pool directly:

```bash
solana account 8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT --url devnet
```

### Devnet airdrop failing

The Solana devnet faucet is rate-limited. Wait 30 seconds between requests and try a smaller amount:

```bash
solana airdrop 1 YOUR_WALLET --url devnet
```

If the CLI faucet still fails, use https://faucet.solana.com and retry after the transaction confirms.

### Proof generation takes more than 10 seconds

The first withdrawal in a fresh process loads `withdraw.wasm` and `withdraw_final.zkey`, which is roughly 4.5 MB of proving artifacts. That warm-up is expected. Subsequent withdrawals in the same process are much faster.

### SDK import errors with Node 22

Node 22 includes native TypeScript handling that can conflict with older `ts-node` flows. If you hit ESM or strip-types issues, prefer `tsx`:

```bash
npx tsx your-script.ts
```

If you must use `node` directly, disable native strip-types handling:

```bash
node --no-experimental-strip-types your-script.ts
```

### Relayer request failing

If `withdrawViaRelayer()` cannot reach the relayer, start the demo service against devnet and allowlist the live pool:

```bash
cd relayer
npm install
SOLANA_RPC_URL=https://api.devnet.solana.com \
RELAYER_KEYPAIR_PATH=../relayer-keypair.json \
SUPPORTED_POOLS=8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT \
npm run start
```

The relayer keypair also needs devnet SOL to pay transaction fees.
