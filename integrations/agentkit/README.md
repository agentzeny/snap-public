# SNAP AgentKit Live Wiring

This is the live reference path for the AgentKit integration added in the repo. The automated tests still stub the framework shell, but the runtime calls below go through the real SNAP SDK surface.

## Runtime Assumptions

- the agent wallet controls the recipient address for `snapWithdraw` or `snapWithdrawPrivate`
- the relayer is already running and serving the target pool
- the wallet has enough SOL to deposit into the pool

## Minimal Wiring

```ts
import { createSNAPPlugin } from "../../agent-kit-tool/src";

const snapPlugin = createSNAPPlugin();

const deposit = await snapPlugin.methods.snapDeposit(
  agent,
  "8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT",
  0.1,
);

const relayed = await snapPlugin.methods.snapWithdrawPrivate(
  agent,
  "8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT",
  String(deposit.note),
  "http://127.0.0.1:3000",
);
```

## Recommended Devnet Inputs

- pool: `8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT`
- relayer URL: the live relayer base URL that serves that pool
- amount: `0.1`

## Live Vs Stubbed

- Live-capable path: `snapDeposit`, `snapWithdraw`, and `snapWithdrawPrivate` call the real SDK
- Stubbed test path: the framework shell around those calls is stubbed in automated tests to keep failures isolated to adapter behavior

Use the validator-backed relayer E2E suite and the Phase 11 canary/soak scripts for chain-level validation. Use this AgentKit path for operator and downstream integration wiring.
