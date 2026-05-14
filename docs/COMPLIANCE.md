# SNAP Compliance Framework

> Status: limited-release posture note. This is operational guidance for a capped rollout, not a legal conclusion or a launch representation for an audited deployment.

> Disclaimer: This document is not legal advice. It is a technical posture note and must be reviewed by a crypto-specialized attorney before publication or reliance.

## How SNAP Differs From Tornado Cash

Tornado Cash was sanctioned by OFAC in August 2022 in a context where the protocol provided strong unlinkability without built-in selective disclosure tooling.

SNAP is aiming at a different model: privacy with accountable ownership.

## Selective Disclosure Via Viewing Keys

Every SNAP agent can be assigned a deterministic viewing key derived from an owner-controlled master seed.

That viewing key allows the owner to:

- read the encrypted note records associated with that agent
- reconstruct that agent's deposit and withdrawal history
- voluntarily disclose that history to an auditor, counterparty, or regulator

The viewing key cannot:

- spend funds
- recover the agent's spending key
- decrypt another agent's notes
- alter on-chain state

This matters because SNAP is not designed around total operator deniability. The owner retains a technical audit path over their own agent fleet.

## Regulatory Cooperation Model

SNAP supports selective disclosure rather than universal surveillance.

The intended operating model is:

- default state: external observers cannot directly link deposits and withdrawals
- owner audit: the human owner can inspect their own agents' private activity
- voluntary disclosure: the owner can share viewing material or reconstructed history with auditors
- subpoena response: where legally required, the owner can disclose the relevant viewing material for their own agents

That is closer to a private business ledger than to an irrevocably opaque mixer.

## What SNAP Cannot Do

SNAP cannot:

- force an owner to disclose a viewing key
- identify the counterparty's full history from one side alone
- freeze, reverse, or claw back confirmed transactions
- satisfy blanket chain-wide surveillance requests without cooperation from the relevant owner

The current implementation also stores encrypted note records off-chain. That means an owner's auditability depends on preserving those records alongside the on-chain pool state.

## Position On AML / KYC

SNAP is protocol infrastructure. It does not itself:

- custody funds for users
- onboard customers
- maintain omnibus accounts
- execute discretionary compliance review on behalf of operators

The protocol enforces transaction privacy at the note and proof layer. Any AML, KYC, sanctions screening, recordkeeping, or reporting obligations attach to the entities operating agents, wallets, relayers, interfaces, or businesses on top of the protocol.

## Practical Compliance Implications

From an architecture perspective, SNAP's strongest compliance feature is that an operator can prove facts about its own activity without exposing unrelated users.

That gives operators a concrete path to:

- preserve internal books and records
- answer transaction-history questions about their own agents
- support targeted disclosures instead of blanket public traceability

This is a technical differentiator, not a legal conclusion. The adequacy of that model depends on jurisdiction, facts, operator behavior, and future guidance.
