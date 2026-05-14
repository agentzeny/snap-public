# SNAP Threat Model

> Status: threat-model notes for the SNAP limited release. The residual risks described here should be assumed active until audit and broader governance hardening are complete.

## Scope And Trust Assumptions

SNAP protects note ownership with Groth16 proofs over Poseidon commitments and Merkle inclusion. The main assets at risk are:

- pool principal held in the SOL or SPL vault PDA
- unlinkability between depositors and recipients
- relayer liveness for private withdrawals
- the integrity of off-chain note records and viewing-key recovery data

The highest-trust components are:

- the Groth16 proving and verifying keys in `build/`
- the on-chain verifier dispatch in `withdraw_zk*`
- the relayer service's request authentication and SQLite deduplication
- operator custody of spending keys, viewing keys, and any upgrade authority

## Attack: Anonymity Set Deanonymization

### Timing correlation

Every deposit instruction (`deposit`, `deposit_v2`, `deposit_spl`) advances `next_index` and updates the root history immediately. Every withdrawal instruction (`withdraw_zk`, `withdraw_zk_v2`, `withdraw_zk_spl`, and relayed variants) consumes a nullifier immediately. An observer who watches pool writes can still correlate deposit and withdrawal timing even when the proof is valid and unlinkable at the note layer.

The relayer helps by removing the recipient as the fee payer, but it does not remove timing leakage. The SDK's timing jitter (`maxDepositDelayMs`, `maxWithdrawDelayMs`, implemented in `sdk-package/src/snap-client.ts`) reduces simple "deposit at T, withdraw at T+5s" linkage, but it only adds noise. It does not change the fact that the active anonymity set is the set of unspent commitments visible in the pool.

Residual risk:

- if the pool has fewer than roughly 10 live notes, timing alone may be enough to narrow candidates aggressively
- bursty agent traffic with deterministic schedules remains easy to cluster
- relayer submissions still reveal when a private withdrawal was attempted, even if the recipient is hidden behind the relayer

### Amount correlation

Within one pool, fixed denomination is a feature: every note in that pool has the same `deposit_amount`, so the proof path does not leak value. That removes the most obvious amount-based linkage for single notes.

The remaining leak is pattern-level:

- agents can still deposit multiple notes in sequence and withdraw multiple notes in sequence
- different pool denominations still create a cross-pool fingerprint
- relayed withdrawals reveal the net split between recipient and relayer fee on-chain, which can identify a relayer configuration

Mitigations today:

- fixed-denomination pools
- optional relayer path
- operator-controlled timing jitter

Residual risk:

- there is no cross-pool mixing
- there is no automatic batch randomization
- repeated `N x denomination` patterns are still graphable

### Graph analysis

SNAP prevents direct note linkage, not behavioral linkage. If one agent ecosystem always deposits shortly before another always withdraws, repeated observations can build a high-confidence relationship graph. This is especially true when the same relayer, the same pool, and the same timing envelope are reused.

Relevant protocol details:

- the circuit binds `recipient` as a public input, so the proof is recipient-specific
- the relayer request signature binds `pool`, `recipient`, `root`, `nullifierHash`, `proof`, `fee`, and `timestamp`
- viewing keys allow an operator to audit their own fleet, but they do not hide repeated business flows from statistical observers

Mitigations today:

- viewing keys for selective internal disclosure
- timing obfuscation in the SDK
- fixed denominations

Residual risk:

- no built-in decoy traffic
- no built-in cover deposits
- no protocol-level protection against long-horizon behavioral clustering

## Attack: Pool Draining

### Proving-parameter compromise

This is the highest-severity protocol risk. If the operator that generated `withdraw_final.zkey` or `withdraw_20_final.zkey` retained toxic waste, they could forge proofs that satisfy the on-chain verifier without knowing a legitimate note witness.

If that happens, the following instructions become drainable:

- `withdraw_zk`
- `withdraw_zk_relayed`
- `withdraw_zk_v2`
- `withdraw_zk_relayed_v2`
- `withdraw_zk_spl`
- `withdraw_zk_relayed_spl`

Those instructions correctly enforce root membership, recipient binding, and nullifier uniqueness given an honest proof system. They cannot defend against a forged proof accepted by compromised proving parameters.

Mitigation required before mainnet:

- replace the current zkey generation flow with a public multi-party parameter-generation process and transcripts, or
- move to a proof system without per-circuit toxic waste

Residual risk until then:

- total pool loss is possible

### Circuit bug exploitation

The withdraw circuits enforce exactly four core statements:

- `Poseidon(secret, nullifier)` defines the leaf
- `Poseidon(nullifier)` defines the public nullifier hash
- the Merkle path reconstructs the public root
- the public recipient is bound into the proof

Phase 13 adversarial testing exercised commitment forgery, wrong nullifier, wrong path, wrong root, cross-pool reuse, recipient substitution, depth mismatch, overflow attempts, and duplicate-withdraw attempts. No test produced a fraudulent spend of someone else's note.

What the circuit does not currently enforce by itself:

- `secret != 0`
- `nullifier != 0`

The on-chain program now rejects the public nullifier hash corresponding to `nullifier = 0`, which closes the spend path for that malformed note class. A `secret = 0` note is still accepted if all other constraints are valid. That is not currently a soundness break because the note is still bound to a unique commitment and nullifier, but it is a residual edge case rather than an intended domain restriction.

Residual risk:

- an unknown constraint bug could still exist outside the tested attack surface
- the phase reduced risk materially, but it is not a substitute for a formal audit

### On-chain program bug

The on-chain program is the second line of defense after the circuit. Its critical checks are:

- `ensure_root_known(...)` for root history validation
- recipient binding in relayed legacy withdraws
- nullifier uniqueness through either `used_nullifiers` or PDA-backed `NullifierRecord`
- account constraints in `WithdrawZkV2`, `WithdrawZkSpl`, and relayed variants
- fee bounds in relayed withdraws
- asset-type and token-mint constraints for SPL pools

Phase 13 found three real validation bugs and fixed them:

- pool initialization accepted `deposit_amount = 0`
- pool initialization accepted `deposit_amount > Number.MAX_SAFE_INTEGER`, including `u64::MAX`
- deposit and withdraw paths accepted malformed zero-value note components that should have been rejected at the program boundary

These were not pool-drain primitives by themselves, but they were real input-validation gaps. The fixes now reject:

- invalid deposit denominations at `initialize`, `initialize_v2`, and `initialize_spl`
- all-zero commitments at `deposit`, `deposit_v2`, and `deposit_spl`
- the public nullifier hash for `nullifier = 0` across ZK withdraw paths

Residual risk:

- any future account-constraint regression could still bypass intended invariants
- upgradeable deployments remain vulnerable to governance or key compromise even if the current code is sound

## Attack: Relayer Exploitation

### Front-running

A malicious relayer can see the full signed withdrawal request before broadcasting it. The main front-running defense is that the proof is recipient-bound:

- the circuit binds `recipient` as a public input
- the relayer request signature binds the exact payload
- changing the recipient, proof, root, fee, or pool breaks request signature verification before the request is processed

If the relayer simply replays the same request itself, the request still pays the intended recipient because the recipient is already fixed. If it submits the request twice, SQLite deduplication and on-chain nullifier use prevent a second spend.

Residual risk:

- the relayer still learns the recipient and timing of the withdrawal
- a malicious relayer can censor or delay rather than steal

### Fee extraction

The relayer cannot arbitrarily change the fee after the user signs:

- the signed payload includes `fee`
- the service recomputes the expected fee from pool state and configured fee basis points
- the on-chain relayed withdraw instructions reject `fee >= deposit_amount`

The remaining risk is user-side trust:

- a malicious interface could persuade the user to sign a high but still valid fee
- a malicious relayer can advertise an unattractive fee policy and rely on inattentive clients

Mitigations today:

- the SDK signs the exact fee the client chose
- the relayer exposes fee info via `/info`
- the service rejects signed-fee mismatches

Residual risk:

- there is no protocol-level fee market or commitment to a bounded fee schedule across relayers

### Denial of service

The relayer is a liveness layer, not a trustless execution layer. It can always refuse service, go offline, or drop requests after accepting them. Current mitigations are useful but incomplete:

- request freshness checks reject stale or far-future signed payloads
- per-IP and global rate limiting limit abuse
- SQLite dedup prevents duplicate nullifier submission races
- the retry manager attempts confirmation and resubmission workflows
- large-body requests are blocked by Express body size limits before normal proof parsing

Residual risk:

- a relayer can still accept requests and never provide service
- a relayer outage forces clients to switch relayers or fall back to direct withdrawal
- centralized relayer infrastructure remains an operational choke point

## Attack: Regulatory

### OFAC sanctions

Pool accounts, vault PDAs, nullifier-record PDAs, and relayer infrastructure are all publicly identifiable on Solana. If those addresses are sanctioned, exchanges and counterparties may refuse to touch funds that interacted with them even if the protocol itself provides selective disclosure.

Technical mitigations are limited:

- viewing keys let operators explain their own activity
- relayers can separate the recipient from fee payment
- fixed-denomination pools reduce direct amount leakage

Those are compliance aids, not sanctions resistance. They do not stop asset screening or blanket policy decisions by exchanges, RPC providers, or counterparties.

### Law enforcement seizure

If the deployed program remains upgradeable, whoever controls the upgrade authority can ship a malicious program version that bypasses current invariants, freezes withdrawals, or drains vaults. That risk sits outside the Anchor instruction set because it exists at the loader/governance layer.

Off-chain data is also exposed to seizure risk:

- relayer SQLite state reveals request timing and status
- operator-held note journals and viewing keys can expose private business flows

Mitigations:

- transfer upgrade authority to a multisig before mainnet, or burn it after audit
- treat relayer databases and viewing-key material as sensitive operational secrets
- separate production relayer operators from note-owning operators when possible

Residual risk:

- burning the upgrade authority improves immutability but removes the emergency-fix path
- keeping the authority preserves fixability but creates a governance compromise target
