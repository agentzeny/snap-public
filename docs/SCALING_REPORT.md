# SNAP Scaling Report

> Status: limited-release scaling evidence. These measurements are useful for capped-rollout planning, but they are not a substitute for production benchmarking on shared infrastructure.

## Scope

This report now distinguishes between:

- Phase 12A baseline measurements and failure cliffs
- Phase 12B diagnostic confirmation of the real cliff cause
- Phase 12B post-fix localnet measurements from:
  - `stress-results/concurrent-clients.json`
  - `stress-results/pool-growth.json`
  - `stress-results/spl-scaling.json`
  - `stress-results/relayer-throughput.json`
  - `stress-results/pool-growth-diagnostics.json`

Environment:

- Solana local validator on `http://127.0.0.1:8899`
- current V2 program binary with paged commitment storage deployed locally
- depth-10 SOL pool for concurrent-client testing
- depth-20 SOL/SPL pools for growth and relayer testing

## Executive Summary

Phase 12A found that local validator lock contention was not SNAP's first wall. The real problem was monolithic pool growth: SOL withdrawals first failed at `450` deposits, SOL deposits at `513`, and SPL deposits at `257`, even though the pool account was still only `9.9 KB` to `18.1 KB`.

Phase 12B confirmed the root cause. The first failing transactions all reported `memory allocation failed, out of memory`, with only `29k` to `60k` compute units consumed out of a `1.4M` budget. The limiting factor was not compute and not the 10 MB account-size cap. It was heap pressure from repeatedly deserializing and growing one append-only commitment vector. SPL failed earlier because the same growing pool state was handled inside the heavier token-deposit path.

Phase 12B then replaced monolithic commitment growth with fixed-size commitment pages. After that change:

- SOL reached `2000` deposits and still withdrew successfully
- SPL reached `1000` deposits and still withdrew successfully
- the pool metadata account stayed flat at `1704` bytes across all measured checkpoints
- relayer overload under default limits changed from downstream `502`s to clean `429` rejections with `Retry-After: 60`
- the repo gained a reliable validator-backed entrypoint: `bash scripts/test-localnet.sh`

Proof generation is still the dominant end-to-end bottleneck. The storage cliff is fixed, but throughput claims should still be framed around proof latency rather than raw transaction submission speed.

## 1. Phase 12A vs Phase 12B

| Area | Phase 12A baseline | Phase 12B post-fix |
|---|---|---|
| Direct SOL contention through `N=20` | `0%` | `0%` |
| Direct SOL deposit TPS at `N=20` | `42.83` | `38.77` |
| Direct SOL withdraw TPS at `N=20` | `41.09` | `56.20` |
| End-to-end effective throughput at `N=20` | `3.59 ops/s` | `3.47 ops/s` |
| Proof batch wall clock at `N=20` | `9.1s` | `9.48s` |
| SOL hard withdrawal failure | `450` deposits | not reached through `2000` |
| SOL hard deposit failure | `513` deposits | not reached through `2000` |
| SPL hard deposit failure | `257` deposits | not reached through `1000` |
| Relayer default burst at `N=20` | `15` HTTP `200`, `5` HTTP `502`, `0` HTTP `429` | `10` HTTP `200`, `10` HTTP `429`, `0` HTTP `502` |
| Reliable localnet suite entrypoint | ad hoc direct Mocha invocation | `bash scripts/test-localnet.sh` |

The concurrency picture is largely unchanged: local validator still does not show measurable lock contention through `N=20`. The important Phase 12B win is not higher TPS. It is removal of the low-hundreds pool-growth cliff and correction of relayer overload behavior.

## 2. Diagnosed Failure Cliff

`stress-results/pool-growth-diagnostics.json` captured the first failing transactions from the Phase 12A cliff window.

| First failing path | Deposit count | Pool bytes | Compute units | What failed |
|---|---:|---:|---:|---|
| SOL withdrawal | `450` | `16104` | `59778` | `WithdrawZkV2` failed with `memory allocation failed, out of memory` |
| SOL deposit | `513` | `18088` | `36708` | `DepositV2` failed with `memory allocation failed, out of memory` |
| SPL deposit | `257` | `9896` | `29883` | `DepositSpl` failed with `memory allocation failed, out of memory` |

The main conclusions are direct:

1. The first cliff is an account-handling / heap-allocation failure, not a gradual compute ceiling.
2. The wall appears while the pool account is still tiny relative to Solana's account-size ceiling.
3. SPL fails earlier for the same fundamental reason, but on a heavier instruction path.

Evidence:

- every first-failure log contains `memory allocation failed, out of memory`
- the failures consumed only a small fraction of the requested compute budget
- the SPL failing deposit had already completed the token transfer CPI successfully before the program panicked

Inference:

- the old design's real problem was repeated deserialize / mutate / reserialize pressure on a growing `Vec<[u8; 32]>`
- `DepositSpl` hit that wall earlier because it carried the same growing pool state plus extra token-account handling, so the heap/stack envelope was tighter than plain SOL deposit

## 3. Post-Fix Growth Curve

Phase 12B replaced append-only inline commitments with fixed-size `CommitmentPage` accounts. The metadata account for the pool now stays flat while storage grows in pages.

### SOL growth checkpoints

| Deposits | Pool bytes | Page count | Total storage bytes | Deposit CU | Withdraw CU | Withdraw status |
|---|---:|---:|---:|---:|---:|---|
| `10` | `1704` | `1` | `3288` | `53334` | `110098` | success |
| `50` | `1704` | `2` | `4872` | `53325` | `110169` | success |
| `100` | `1704` | `3` | `6456` | `54825` | `108599` | success |
| `500` | `1704` | `11` | `19128` | `59298` | `108669` | success |
| `1000` | `1704` | `21` | `34968` | `54797` | `108599` | success |
| `2000` | `1704` | `42` | `68232` | `53288` | `108669` | success |

### SPL growth checkpoints

| Deposits | Pool bytes | Page count | Total storage bytes | Deposit CU | Withdraw CU | Withdraw status |
|---|---:|---:|---:|---:|---:|---|
| `10` | `1704` | `1` | `3288` | `61265` | `115042` | success |
| `100` | `1704` | `3` | `6456` | `61256` | `116543` | success |
| `500` | `1704` | `11` | `19128` | `61229` | `115113` | success |
| `1000` | `1704` | `21` | `34968` | `59728` | `115043` | success |

The important shape changed completely:

- pool metadata account size is now flat
- storage growth is linear in page accounts
- withdrawal correctness held at every measured checkpoint
- both Phase 12B minimum targets were achieved without changing the ZK circuits

## 4. Concurrency And Proof Cost

### Direct SOL concurrency summary

| Concurrency | Deposit TPS | Withdraw TPS | Contention | p95 Latency |
|---|---:|---:|---:|---:|
| `1` | `5.32` | `7.08` | `0%` | `584ms` |
| `3` | `5.68` | `12.87` | `0%` | `529ms` |
| `5` | `9.81` | `11.93` | `0%` | `528ms` |
| `10` | `18.98` | `23.34` | `0%` | `527ms` |
| `20` | `38.77` | `56.20` | `0%` | `643ms` |

At `N=20`, proof generation still dominated the end-to-end wall clock:

- average proof batch wall clock: `9478ms`
- average deposit wall clock: `516ms`
- average withdraw wall clock: `428ms`
- effective end-to-end throughput: `3.47 ops/s`

That is the remaining system bottleneck after the storage fix.

## 5. SPL Comparison

### SPL concurrent summary

| Concurrency | SPL Deposit TPS | SPL Withdraw TPS | Contention |
|---|---:|---:|---:|
| `1` | `1.74` | `4.10` | `0%` |
| `5` | `8.76` | `9.87` | `0%` |
| `10` | `17.17` | `24.13` | `0%` |

Measured ATA creation overhead:

- first withdrawal to a fresh recipient: `310ms`, `136731 CU`
- second withdrawal after ATA exists: `285ms`, `117986 CU`
- incremental ATA cost: `25ms`, `18745 CU`

Relayed SPL withdrawal sample:

- request latency: `1461ms`
- submission latency: `172ms`
- confirmation latency: `1250ms`
- compute units: `168782`
- recipient ATA created: yes
- relayer ATA created: yes

## 6. Relayer Overload Behavior

### Post-fix relayer summary

| Mode | Concurrency | HTTP 200 | HTTP 429 | Request TPS | Avg submit | Avg confirm |
|---|---:|---:|---:|---:|---:|---:|
| raw | `1` | `1/1` | `0` | `0.76` | `169ms` | `1111ms` |
| raw | `5` | `5/5` | `0` | `4.13` | `142ms` | `1028ms` |
| raw | `10` | `10/10` | `0` | `7.55` | `107ms` | `870ms` |
| raw | `20` | `20/20` | `0` | `12.25` | `210ms` | `1068ms` |
| default | `1` | `1/1` | `0` | `0.96` | `17ms` | `1021ms` |
| default | `5` | `5/5` | `0` | `4.09` | `84ms` | `1088ms` |
| default | `10` | `10/10` | `0` | `7.77` | `120ms` | `1133ms` |
| default | `20` | `10/20` | `10` | `7.28` | `135ms` | `1168ms` |

The key Phase 12B success case is the last row:

- default-limit `N=20` overload now rejects exactly half the burst at the limiter
- all rejected responses returned HTTP `429`
- every limited response carried `Retry-After: 60`
- the old downstream `502` overload mode is gone from the default-limit burst scenario

## 7. Reliable Localnet Validation Path

The repo now has one explicit validator-backed command path that works in this environment:

- `bash scripts/test-localnet.sh`

Optional stress rerun:

- `bash scripts/test-localnet.sh --with-stress`

Package aliases:

- `npm run test:localnet`
- `npm run test:localnet:stress`

Verified regression outcome:

- `bash scripts/test-localnet.sh` completed with `28 passing`

This replaces the broken `anchor test --skip-build --skip-deploy --skip-local-validator --provider.cluster localnet` path, which still reported `0 passing` in this repo.

## 8. Remaining Risks

1. Proof generation is still the first end-to-end throughput bottleneck.
2. Local validator still does not model real shared-cluster contention; `0%` contention through `N=20` is a localnet result, not a devnet/mainnet guarantee.
3. Storage now scales linearly in page accounts and rent instead of failing early, but larger future targets will still need page-count, rent, and account-fetch considerations.
4. Commitment-page capacity is intentionally conservative to stay within current SBF stack limits. If much larger per-page layouts are desired later, that tradeoff should be revisited carefully.
