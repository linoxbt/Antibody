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
npm run web       # builds the status site into web-dist/
```

| Contract | Chain | Role |
| --- | --- | --- |
| `GuardVault` | Base Sepolia (more later) | Holds the agent's funds; the agent may only propose payments. Accepts freeze and quarantine callbacks from `GuardReactive` only, through the chain's callback proxy. |
| `GuardReactive` | Reactive Lasna | Subscribes to vault events on every watched chain and requests callbacks. |
