# SNAP Relayer

Production-oriented Express relayer for SNAP private withdrawals.

## Purpose

The relayer submits `withdraw_zk_relayed` transactions on behalf of the recipient. The relayer pays the transaction fee from its own wallet and receives a configurable fee, so the recipient wallet never appears on-chain as the fee payer.

## Security Model

Phase 9's signed request envelope was not sufficient on its own. A fresh Ed25519 session key proves only that someone signed the request bytes; it does not prove note ownership.

The current model is:

- the signed envelope provides transport integrity and replay-window protection
- the relayer verifies the withdrawal proof off-chain before submission
- the signature is bound to the exact `proof/root/nullifier/recipient/fee/timestamp` tuple
- the relayer also rejects unknown roots, already-used nullifiers, malformed payloads, and expired signatures before sending a transaction

The relayer does not learn a stable caller identity across requests. It only sees a one-time session public key plus the proof-bound withdrawal payload.

## Transaction Lifecycle

Persisted request states:

- `pending`: accepted and waiting for submission
- `submitted`: sent to Solana with a tracked signature and `lastValidBlockHeight`
- `confirmed`: confirmed on-chain
- `failed`: retried until the configured limit, then abandoned
- `expired`: request payload in the database is missing or unusable

The relayer polls signature status after submission. It does not mark a request confirmed just because `sendRawTransaction` succeeded. If a signature never lands and the blockhash expires, the relayer rebuilds and resubmits with a fresh blockhash.

## Persistence And Rate Limits

- Relay requests are stored in SQLite.
- Strict nullifier dedup is enforced by a unique index on `nullifier_hash`.
- Per-IP and global rate limits are derived from the persisted request table, so they survive restart.

Deployment limitation:

- the default store is SQLite, so serious multi-replica deployments need a shared SQLite volume or a different backend
- this repo does not ship a Redis/Postgres rate-limit backend yet

## Environment

- `SOLANA_RPC_URL`: Solana RPC URL, default `https://api.devnet.solana.com`
- `SOLANA_CLUSTER`: `localnet`, `devnet`, or `mainnet-beta`, default `devnet`
- `RELAYER_KEYPAIR_PATH`: path to the relayer keypair JSON, default `relayer-keypair.json`
- `SNAP_POOL_ADDRESS`: pool this relayer serves, default `8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT`
- `SNAP_PROGRAM_ID`: program id override, default live SNAP devnet program id
- `RELAYER_FEE_BPS`: fee in basis points, default `50`
- `MIN_FEE_LAMPORTS`: minimum SOL fee floor in lamports, default `10000`
- `MAX_REQUESTS_PER_MINUTE_PER_IP`: per-IP limit, default `10`
- `MAX_REQUESTS_PER_MINUTE_GLOBAL`: global limit, default `100`
- `MAX_RETRIES`: maximum retry count after the initial submission, default `3`
- `RETRY_BACKOFF_MS`: comma-separated retry backoffs, default `2000,8000,30000`
- `RELAYER_PORT` or `PORT`: HTTP port, default `3000`
- `RELAYER_HOST`: listen host, default `127.0.0.1`
- `RELAYER_DB_PATH`: SQLite database path, default `snap-relayer.sqlite`

## Run

```bash
cd relayer
npm install
RELAYER_KEYPAIR_PATH=../relayer-keypair.json npm run start
```

## API

`POST /relay`

```json
{
  "payload": {
    "pool": "base58 pool address",
    "proof": "hex-encoded proof bytes",
    "root": "hex-encoded root",
    "nullifierHash": "hex-encoded nullifier hash",
    "recipient": "base58 recipient address",
    "fee": 500000
  },
  "signature": "base58-ed25519-signature",
  "sessionPubkey": "base58-ephemeral-public-key",
  "timestamp": 1710000000000
}
```

`GET /info`

Returns pool, fee settings, network, program id, relayer address, and relayer balance.

`GET /health`

Returns relayer uptime and package version.

`GET /stats`

Returns 24-hour totals for received, confirmed, failed, and earned fees.

`GET /metrics`

Returns Prometheus exposition text with relay counters, fee totals, proof verification latency, confirmation latency, and relayer balance.
