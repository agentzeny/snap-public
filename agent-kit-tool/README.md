# SNAP Solana Agent Kit Tool

Solana Agent Kit v2 plugin that gives agents private SNAP payment actions.

## Quick Start

```ts
import { Keypair } from "@solana/web3.js";
import { KeypairWallet, SolanaAgentKit, createLangchainTools } from "solana-agent-kit";
import SNAPPlugin from "@snap-protocol/agent-kit-tool";

const wallet = new KeypairWallet(Keypair.generate());
const agent = new SolanaAgentKit(wallet, "http://127.0.0.1:8899", {}).use(SNAPPlugin);

const tools = createLangchainTools(agent, agent.actions);
```

## Actions

- `snap_create_pool`
- `snap_deposit`
- `snap_withdraw`

## Example Conversation

```text
Human: Send 0.1 SOL privately to Agent B
Agent: I'll deposit into the shielded pool and generate a secret note.
       [calls snap_deposit]
       Done. Here's the encrypted note to share with Agent B: {note}

       Important: This note must be shared through a private channel.
       Anyone who has this note can withdraw the funds.

---

Agent B receives the note through an encrypted channel.

Agent B: I received a SNAP note. Let me withdraw.
         [calls snap_withdraw]
         Successfully withdrew 0.1 SOL. The withdrawal cannot be
         linked to the original deposit on-chain.
```

## Notes

- `snap_deposit` returns a serialized SNAP note. Keep it off-chain and private.
- `snap_withdraw` uses the agent wallet as both the withdrawal recipient and fee payer.
- The plugin wraps `@snap-protocol/sdk`, so all proof generation and Merkle reconstruction stay internal.
