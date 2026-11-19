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
npm run evidence -- baseSepolia   # re-read every recorded tx from the chain into docs/guard/
npm run verify -- baseSepolia GuardVault <address> [creationTx]   # Sourcify
npm run web       # builds the status site into web-dist/, with every deployment in deployments/
```

| Contract | Chain | Role |
| --- | --- | --- |
| `GuardVault` | Base Sepolia [`0xb30c…5d4b`](https://sepolia.basescan.org/address/0xb30ccddd31c4e14186801d74ea45a905b7305d4b) | Holds the agent's funds; the agent may only propose payments, which the rules pay or refuse (refusals are events, not reverts). Payee changes are timelocked. Accepts freeze and quarantine callbacks from its guardian only, through the chain's callback proxy. |
| `GuardReactive` | Reactive Lasna | Subscribes to vault events on every watched chain and requests callbacks. |

Testnet keys (deployer, agent) live in `~/.antibody-guard/` on the machine that runs the scripts,
never in the repository. `deployments/*.json` holds only addresses and transaction hashes.
