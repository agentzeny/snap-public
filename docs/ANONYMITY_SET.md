# SNAP Anonymity Set Strategy

> Status: guidance for the SNAP pre-audit pilot. Pool caps, acceptable anonymity thresholds, and launch claims should stay conservative until after audit and a stronger ceremony.

## The Cold Start Problem

Privacy pools have a bootstrapping problem: they don't provide meaningful
privacy until enough people use them, but people won't use them until
they provide meaningful privacy.

## Minimum Viable Anonymity Set

For SNAP's fixed-denomination pools, the anonymity set size equals the
number of unspent deposits. With `k` unspent deposits, an observer trying
to link a withdrawal to a deposit has a `1/k` chance of guessing correctly.

Target thresholds:

- `k < 10`: Minimal privacy. Transaction timing alone is often enough to deanonymize users.
- `k = 10-50`: Moderate privacy. Viable for low-stakes agent payments.
- `k = 50-200`: Strong privacy. Meaningful for most production agent use cases.
- `k > 200`: Excellent privacy. Approaching institutional-grade cover traffic.

## Bootstrapping Strategies

### Strategy 1: Deposit Incentive Program

Fund an initial deposit pool from project treasury. Create 50-100
deposits from distinct wallets to establish a base anonymity set.
At the current devnet 0.1 SOL denomination, `50 x 0.1 SOL = 5 SOL`.

### Strategy 2: Agent Framework Partnerships

Partner with agent framework teams such as SendAI, ElizaOS, OpenClaw,
and MCP-native platforms so SNAP becomes a default payment rail.
Each integrated agent that deposits grows the anonymity set organically.

### Strategy 3: Timing Obfuscation

Use random delays before deposits and withdrawals so transaction time is
not tightly coupled to intent time. Phase 9 adds optional SDK timing
obfuscation using `crypto.getRandomValues()` so operators can configure
`maxDepositDelayMs` and `maxWithdrawDelayMs` without relying on weak RNG.

Recommended production defaults:

- deposits: `5000-30000ms`
- withdrawals: `5000-30000ms`

### Strategy 4: Cross-Pool Routing

Allow agents to deposit in one denomination and withdraw equivalent
value from another, for example `10 x 0.1 SOL` in and `1 x 1 SOL` out.
This mixes anonymity sets across pools, but it requires protocol work
that does not exist in the current release.

## Operational Guidance

- Avoid making privacy claims when the active anonymity set is below `10`.
- Monitor the active set continuously with `npx tsx scripts/anonymity-check.ts [pool]`.
- Prefer relayed withdrawals over direct withdrawals so the recipient does not appear as the fee payer.
- Run the pool monitor so rapid deposit bursts, withdrawal bursts, and liquidity drops are visible early.

## Recommended Launch Plan

1. Seed the pool with project-funded deposits until `k >= 25`.
2. Turn on timing obfuscation in SDK clients before public beta traffic.
3. Launch framework integrations in parallel so new agent ecosystems contribute organic flow.
4. Publish active anonymity-set metrics publicly so operators and users know the current privacy envelope.
