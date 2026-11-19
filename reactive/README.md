# Antibody Guard (Reactive Network)

A guarded vault for an AI agent's funds, and a reactive contract that watches it from
Reactive Network and acts on its own. Built for the Reactive Omni Buildathon; see
[`docs/guard/PLAN.md`](../docs/guard/PLAN.md) for the phases.

```sh
cd reactive
npm ci
npm run deps      # fetches reactive-lib-omni at a pinned commit into lib/ (not committed)
npm run build     # hardhat build
npm test          # Solidity tests
npm run deployer -- show   # testnet deployer address and balances
npm run phase1    # deploy GuardVault on Base Sepolia and run the payment demo (re-runnable)
npm run faucet -- baseSepolia 0.05   # turn test ETH into lREACT on Lasna
npm run phase2    # deploy GuardReactive on Lasna, make it the vault's guardian, run three live loops
npm run phase3    # v2 on Lasna and Base Sepolia (+ Ethereum Sepolia when funded): quarantine, veto, CRON payments, cross-chain lessons
npm run link-callbacks   # find each loop's callback transaction on the destination chain
npm run evidence -- baseSepolia   # (or lasna) re-read every recorded tx from the chain into docs/guard/
npm run verify -- baseSepolia GuardVault <address> [creationTx]   # Sourcify
npm run rmcp -- tools   # Reactive MCP tools (also in the repo .mcp.json); see docs/guard/reactive-mcp.md
npm run deposit -- 0.2   # add fee reserves for GuardReactive (depositTo)
npm run web       # builds the status site into web-dist/, with every deployment in deployments/
```

Version 2 (Phase 3) is the current one; version 1 stays deployed as the record of Phases 1 and 2.

| Contract | Chain | Role |
| --- | --- | --- |
| `GuardVault` v2 | Base Sepolia [`0x114e…c7d2`](https://sepolia.basescan.org/address/0x114e6c7e2cd7feeec8d75912cf762f1fc45dc7d2) | v1 plus recurring payments (paid on Reactive's CRON under the same rules), guardian veto of a pending payee change, and a quarantined address can never be activated as a payee. Every callback is idempotent. |
| `GuardReactive` v2 | Reactive Lasna [`0x7900…a282`](https://lasna.reactscan.net/address/0x7900d7765473eba75a816ccf58a481399036a282) | v1 plus lessons: an address quarantined on any watched vault is quarantined on all of them, a vault watched later is immunized with every lesson, a payee change towards a known attacker is vetoed, CRON (subscribed only while a schedule is active) pays due schedules, and lost callbacks can be retried by anyone after 10 minutes. |
| `GuardVault` v1 | Base Sepolia [`0xb30c…5d4b`](https://sepolia.basescan.org/address/0xb30ccddd31c4e14186801d74ea45a905b7305d4b) | Holds the agent's funds; the agent may only propose payments, which the rules pay or refuse (refusals are events, not reverts). Payee changes are timelocked. Accepts freeze and quarantine callbacks from its guardian only, through the chain's callback proxy. |
| `GuardReactive` v1 | Reactive Lasna [`0xb30c…5d4b`](https://lasna.reactscan.net/address/0xb30ccddd31c4e14186801d74ea45a905b7305d4b) | Subscribes to six events of each watched vault. Freezes the vault on a burst of proposals (more than 5 in 2 minutes) or on 3 refusals in 10 minutes; quarantines any address the agent tried to pay that is not a payee. Mirrors each vault's frozen flag and quarantine list from its events, so it never asks twice. |

Testnet keys (deployer, agent) live in `~/.antibody-guard/` on the machine that runs the scripts,
never in the repository. `deployments/*.json` holds only addresses and transaction hashes.

Both contracts happen to share the address `0xb30c…5d4b`: the same deployer created each as its
first contract, on two different chains (Base Sepolia and Lasna).
