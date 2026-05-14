# Funded Devnet Canary

This checklist is the operator path for rerunning the live funded relayer canary and the bounded devnet soak checks added in Phase 11.

## Preflight

1. Confirm the RPC and wallet:

```bash
solana config get
solana balance --url devnet
```

2. Confirm the target pool and program:

- Program ID: `9uePoqdgaXpqFLQM2ED1GGQrwSEiqe3r6tW1AfsnrrbS`
- Pool: `8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT`

3. Recommended payer minimums:

- funded canary with `SNAP_CANARY_RECIPIENT_MODE=ephemeral`: at least `0.15 SOL`
- low-cost devnet soak with `SNAP_SOAK_RECIPIENT_MODE=payer` and `2` iterations: at least `0.25 SOL`
- if you switch soak recipient mode to `ephemeral`, treat the full deposit amount per iteration as unrecovered spend

## Funded Canary Command

This command performs one live deposit and one live relayed withdrawal, captures endpoint payloads, records balances, checks duplicate nullifier rejection, and writes a JSON artifact.

```bash
SNAP_CANARY_OUTPUT_PATH=.phase11-artifacts/devnet-canary.json \
npx tsx scripts/devnet-relayer-canary.ts
```

Optional low-cost mode:

```bash
SNAP_CANARY_RECIPIENT_MODE=payer \
SNAP_CANARY_OUTPUT_PATH=.phase11-artifacts/devnet-canary-low-cost.json \
npx tsx scripts/devnet-relayer-canary.ts
```

## Bounded Devnet Soak Command

This keeps spend bounded by:

- refusing devnet mode unless `SNAP_SOAK_ALLOW_DEVNET=1`
- enforcing `SNAP_SOAK_MAX_TOTAL_LAMPORTS`
- defaulting to `recipientMode=payer`
- refunding the temporary relayer top-up back to the payer at the end

Recommended low-cost devnet soak:

```bash
SNAP_SOAK_ALLOW_DEVNET=1 \
SNAP_SOAK_CLUSTER=devnet \
SNAP_SOAK_ITERATIONS=2 \
SNAP_SOAK_DELAY_MS=2000 \
SNAP_SOAK_MAX_TOTAL_LAMPORTS=200000000 \
SNAP_SOAK_RECIPIENT_MODE=payer \
SNAP_SOAK_OUTPUT_PATH=.phase11-artifacts/devnet-soak.json \
npx tsx scripts/relayer-soak.ts
```

## Localnet Soak Command

Run this only after a local validator is running and the current program build is deployed:

```bash
SNAP_SOAK_CLUSTER=localnet \
SNAP_SOAK_ITERATIONS=5 \
SNAP_SOAK_DELAY_MS=250 \
SNAP_SOAK_OUTPUT_PATH=.phase11-artifacts/localnet-soak.json \
npx tsx scripts/relayer-soak.ts
```

If `SNAP_SOAK_POOL_ADDRESS` is omitted on localnet, the script creates a fresh pool automatically.

## Post-Run Checks

For the funded canary artifact, confirm:

- `/health`, `/info`, `/stats`, and `/metrics` returned `200`
- `depositSignature` and `withdrawSignature` are both present
- `relayRecord.status` is `confirmed`
- `duplicateNullifierResponse.status` is `409`
- `monitorEvents` include `deposit`, `withdrawal`, and `balance_change`

For the soak artifact, confirm:

- `summary.successCount` matches the expected iteration count
- `summary.failureCount` is `0` or any failures are understood and documented
- `summary.retryCount` is within tolerance
- `balances.payer.delta` stays within the planned budget envelope

## Budget Notes

- The funded canary defaults to `recipientMode=ephemeral` because it is the cleanest live canary for a real relayed withdrawal.
- The soak harness defaults to `recipientMode=payer` because that keeps net devnet spend close to transaction fees only.
- The scripts top up the temporary relayer key only to the configured target and drain the remaining balance back to the payer before exit.
