# RELAYER_RUNBOOK

> Status: relayer operations guidance for the SNAP pre-audit pilot. Treat any mainnet rollout as tightly capped until audit, broader governance hardening, and more production rehearsal are complete.

## Purpose

This document is the operator handoff for the SNAP relayer in Phase 10. It assumes the relayer is serving exactly one pool address and that the operator is responsible for the relayer wallet, the SQLite database, and the monitoring pipeline.

Phase 11 adds reusable operator assets:

- Prometheus alerts: [`ops/prometheus/snap-relayer-alerts.yml`](../ops/prometheus/snap-relayer-alerts.yml)
- Grafana dashboard seed: [`ops/grafana/snap-relayer-dashboard.json`](../ops/grafana/snap-relayer-dashboard.json)
- funded devnet canary + soak checklist: [`ops/FUNDED_DEVNET_CANARY.md`](../ops/FUNDED_DEVNET_CANARY.md)

## Deployment Prerequisites

- Node.js 22 or newer
- a funded relayer keypair JSON file
- access to the SNAP program ID and the pool address the relayer is allowed to serve
- a writable filesystem path for the SQLite database
- an RPC endpoint with stable `getLatestBlockhash`, `getSignatureStatuses`, and account reads
- enough SOL in the relayer wallet to pay transaction fees during bursts and retries

Recommended minimums before opening traffic:

- relayer wallet funded with at least `0.5 SOL` on devnet or a production-specific threshold on mainnet
- the configured pool already exists and accepts direct SDK deposits/withdrawals
- Prometheus scraping `/metrics`
- alerting wired for low relayer balance and growing pending queue

## Environment Variables

- `SOLANA_RPC_URL`
- `SOLANA_CLUSTER`
- `RELAYER_KEYPAIR_PATH`
- `SNAP_POOL_ADDRESS`
- `SNAP_PROGRAM_ID`
- `RELAYER_FEE_BPS`
- `MIN_FEE_LAMPORTS`
- `MAX_REQUESTS_PER_MINUTE_PER_IP`
- `MAX_REQUESTS_PER_MINUTE_GLOBAL`
- `MAX_RETRIES`
- `RETRY_BACKOFF_MS`
- `RELAYER_PORT`
- `RELAYER_HOST`
- `RELAYER_DB_PATH`

Example localnet startup:

```bash
cd relayer
SOLANA_CLUSTER=localnet \
SOLANA_RPC_URL=http://127.0.0.1:8899 \
SNAP_POOL_ADDRESS=<pool> \
RELAYER_KEYPAIR_PATH=../relayer-keypair.json \
RELAYER_DB_PATH=../.relayer/local.sqlite \
npm run start
```

## Health Checks

The relayer should answer all of these before it is considered healthy:

- `GET /health`
- `GET /info`
- `GET /stats`
- `GET /metrics`

The `/info` response should match the intended pool, program ID, and cluster. If `/info` shows the wrong pool, stop the relayer and correct the environment before accepting traffic.

## Canary And Soak Operations

Use the Phase 11 operator checklist in [`ops/FUNDED_DEVNET_CANARY.md`](../ops/FUNDED_DEVNET_CANARY.md) for:

- the live funded devnet canary
- the bounded devnet soak command
- the repeated localnet soak command

The canary and soak scripts now refund leftover temporary relayer balance back to the payer before exit. That makes reruns safer and keeps devnet top-up spend bounded.

## SQLite Backup And Restore

The relayer keeps request lifecycle state and rate-limit history in SQLite. Back up the database file and its WAL/SHM sidecars together.

Online backup procedure:

```bash
sqlite3 "$RELAYER_DB_PATH" ".backup '$RELAYER_DB_PATH.backup'"
cp "$RELAYER_DB_PATH-wal" "$RELAYER_DB_PATH.backup-wal" 2>/dev/null || true
cp "$RELAYER_DB_PATH-shm" "$RELAYER_DB_PATH.backup-shm" 2>/dev/null || true
```

Cold backup procedure:

1. Stop the relayer.
2. Copy `sqlite`, `-wal`, and `-shm` files.
3. Start the relayer again.

Restore procedure:

1. Stop the relayer.
2. Replace the database file and any sidecars with the backup set.
3. Start the relayer.
4. Check `/stats` and `/metrics` for expected pending/submitted counts.

Do not restore only the main database file while leaving old WAL sidecars in place.

## Monitoring And Alerting

Prometheus should scrape `/metrics`.

Minimum alerts:

- relayer wallet balance below operating threshold
- pending queue greater than zero for a sustained period
- failed requests increasing
- proof verification latency or confirmation latency spiking

The repo also ships `scripts/monitor.ts` for pool-level deposit, withdrawal, balance, and anomaly polling. Use it as a log-emitting sidecar if you need event-oriented alerting in addition to Prometheus.

Phase 11 alert examples are packaged in [`ops/prometheus/snap-relayer-alerts.yml`](../ops/prometheus/snap-relayer-alerts.yml). A small dashboard seed is packaged in [`ops/grafana/snap-relayer-dashboard.json`](../ops/grafana/snap-relayer-dashboard.json).

Suggested Prometheus scrape target:

```yaml
scrape_configs:
  - job_name: snap-relayer
    static_configs:
      - targets: ["127.0.0.1:3000"]
```

## Low SOL In Relayer Wallet

Symptoms:

- `/info` shows a low `relayerBalanceLamports`
- submissions start failing with fee-payer or insufficient-funds errors

Response:

1. Stop accepting new traffic if the balance is close to zero.
2. Fund the relayer wallet.
3. Confirm the new balance through `/info`.
4. Check whether any requests moved to `failed` because retries were exhausted.
5. Replay or manually re-submit failed requests if needed.

## Duplicate Withdrawals Spike

Symptoms:

- repeated `409` responses for duplicate nullifiers
- monitor anomalies showing nullifier-related failures

Response:

1. Check whether this is user retry noise or an abuse pattern.
2. Inspect the rate-limit settings and current IP distribution.
3. Confirm that the pool or store is not being pointed at by multiple incompatible relayer instances.
4. If abuse is active, tighten `MAX_REQUESTS_PER_MINUTE_PER_IP` and consider upstream filtering.

## Pending Queue Grows

Symptoms:

- `/metrics` shows pending requests increasing
- `/stats` confirmed count stalls

Response:

1. Check RPC health first.
2. Check relayer wallet balance.
3. Inspect whether signatures are stuck in `submitted` because confirmation is slow or the RPC is lagging.
4. Inspect the SQLite file for write errors or lock contention.
5. If the relayer was restarted, verify that the retry manager is running and draining persisted work.

If the queue keeps growing while the RPC is healthy, stop the relayer and inspect the database before traffic keeps piling up.

## Database Corruption Or Disk Failure

Symptoms:

- SQLite open errors
- malformed database errors
- repeated failures reading stored relay records

Response:

1. Stop the relayer immediately.
2. Preserve the broken database file for forensics.
3. Restore the latest known-good backup.
4. Start the relayer and confirm `/health`, `/stats`, and `/metrics`.
5. Compare restored pending/submitted rows against external request logs if available.

If no backup exists, the relayer can still start with a new empty database, but pending history, rate-limit history, and nullifier reservations from the old store will be lost. Treat that as a risk event and review duplicate-withdraw exposure before reopening traffic.

## Known Deployment Model Limitations

- The default persistence backend is SQLite.
- Per-IP and global rate limiting are restart-safe only because the relayer reads them from the SQLite request table.
- Strict nullifier dedup is local to the configured database file.
- Multiple relayer replicas are safe only if they share the same SQLite volume and write coordination. Cross-host active/active deployment is out of scope in this repo.
- Off-chain proof verification depends on the bundled verification keys matching the deployed circuit depth.

If you need horizontally scaled relayers across multiple hosts, replace the SQLite-backed control plane before treating the deployment as production-grade.
