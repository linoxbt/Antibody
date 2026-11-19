# Antibody Guard (Reactive Network)

> **Antibody Guard now lives in its own repository: [linoxbt/Antibody-gaurd](https://github.com/linoxbt/Antibody-gaurd).**
> It is an immune system for AI agents, for their money and their memory. It adds `GuardMemory` (agent memory
> with provenance, guarded by the same GuardReactive), the public API (`/api/v1`, OpenAPI), the
> TypeScript SDK (`sdk/`) and the MCP server (`mcp/`, and hosted at `/mcp`). This folder is kept in step
> with it for the Railway service.

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
npm run bridge -- 0.0042   # test ETH from Base Sepolia to Ethereum Sepolia through Across (about 10 s)
npm run phase3-cross   # GuardReactive v3 replaces v2 and guards both vaults: lessons across chains
npm run phase4    # GuardReactive v4 + RiskOracle; the AI scorer and Steward run live (needs a model key, see below)
npm run typecheck # the scripts and the agent
npm run link-callbacks   # find each loop's callback transaction on the destination chain
npm run evidence -- baseSepolia   # (or lasna) re-read every recorded tx from the chain into docs/guard/
npm run verify -- baseSepolia GuardVault <address> [creationTx]   # Sourcify
npm run rmcp -- tools   # Reactive MCP tools (also in the repo .mcp.json); see docs/guard/reactive-mcp.md
npm run deposit -- 0.2   # add fee reserves for GuardReactive (depositTo)
npm run web       # builds the status site into web-dist/, with every deployment in deployments/
```

The current deployment is GuardVault v2 (Base Sepolia and Ethereum Sepolia) guarded by GuardReactive v5, which can watch up to 12 vaults (including visitors' own), with an AI risk scorer reporting to a RiskOracle; earlier versions stay deployed as the record of the earlier phases.

| Contract | Chain | Role |
| --- | --- | --- |
| `GuardReactive` v5 (current) | Reactive Lasna [`0x4d15…8440`](https://lasna.reactscan.net/address/0x4d15b3af1a723d158f63f61002577e9a8b998440) | v4 for many vaults: watches up to 12 GuardVaults across chains, keyed by (chain, vault), with a registrar role that may only watch, unwatch and immunize; imported v4's lessons ([Sourcify](https://repo.sourcify.dev/5318007/0x4d15b3af1a723d158f63f61002577e9a8b998440)) |
| `GuardReactive` v4 (retired) | Reactive Lasna [`0xc0f9…8814`](https://lasna.reactscan.net/address/0xc0f92c45a5147b408c0bcbeab7dacfb27eb78814) | v3 plus AI risk: it trusts a RiskOracle, and a report at or above 80 makes the address a known attacker, quarantined on every watched vault (the model can only restrict). Imported v3's lessons. |
| `RiskOracle` | Base Sepolia [`0xe067…322e`](https://sepolia.basescan.org/address/0xe067e2b0a06d6019442ec8371ee2ad407b2d322e) | where the AI scorer's reports go on-chain (score, evidence hash, reason); changes nothing by itself |
| `GuardReactive` v3 (retired) | Reactive Lasna [`0x5208…37c0`](https://lasna.reactscan.net/address/0x5208c022571739fbef6198959bd7af89effd37c0) | v2 with the callback gas limit set per destination chain (Ethereum Sepolia's proxy keeps 200k of the limit, Base Sepolia's 130k) and an owner withdraw. Retired after Phase 4 (its lREACT withdrawn). |
| `GuardVault` v2 | Ethereum Sepolia [`0xb30c…5d4b`](https://sepolia.etherscan.io/address/0xb30ccddd31c4e14186801d74ea45a905b7305d4b) | the same vault on a second chain |
| `GuardVault` v2 | Base Sepolia [`0x114e…c7d2`](https://sepolia.basescan.org/address/0x114e6c7e2cd7feeec8d75912cf762f1fc45dc7d2) | v1 plus recurring payments (paid on Reactive's CRON under the same rules), guardian veto of a pending payee change, and a quarantined address can never be activated as a payee. Every callback is idempotent. |
| `GuardReactive` v2 (retired) | Reactive Lasna [`0x7900…a282`](https://lasna.reactscan.net/address/0x7900d7765473eba75a816ccf58a481399036a282) | v1 plus lessons: an address quarantined on any watched vault is quarantined on all of them, a vault watched later is immunized with every lesson, a payee change towards a known attacker is vetoed, CRON (subscribed only while a schedule is active) pays due schedules, and lost callbacks can be retried by anyone after 10 minutes. |
| `GuardVault` v1 | Base Sepolia [`0xb30c…5d4b`](https://sepolia.basescan.org/address/0xb30ccddd31c4e14186801d74ea45a905b7305d4b) | Holds the agent's funds; the agent may only propose payments, which the rules pay or refuse (refusals are events, not reverts). Payee changes are timelocked. Accepts freeze and quarantine callbacks from its guardian only, through the chain's callback proxy. |
| `GuardReactive` v1 | Reactive Lasna [`0xb30c…5d4b`](https://lasna.reactscan.net/address/0xb30ccddd31c4e14186801d74ea45a905b7305d4b) | Subscribes to six events of each watched vault. Freezes the vault on a burst of proposals (more than 5 in 2 minutes) or on 3 refusals in 10 minutes; quarantines any address the agent tried to pay that is not a payee. Mirrors each vault's frozen flag and quarantine list from its events, so it never asks twice. |

Testnet keys (deployer, agent) live in `~/.antibody-guard/` on the machine that runs the scripts,
never in the repository. `deployments/*.json` holds only addresses and transaction hashes.

Both contracts happen to share the address `0xb30c…5d4b`: the same deployer created each as its
first contract, on two different chains (Base Sepolia and Lasna).

## The AI side (`agent/`)

- `steward.ts`: Steward, an AI agent (Qwen via Fortytwo, any OpenAI-compatible endpoint) that pays bills.
  Its tools are `lookup_payee`, `check_payment` (a dry run against the vault's rules) and
  `propose_payment`. It treats its inbox as untrusted, and it never holds a key that can move funds by
  itself: the vault decides and GuardReactive watches.
- `scorer.ts`: the AI risk scorer. It reads an incoming message, and if it is trying to redirect money it
  reports the address to the RiskOracle with a score. Guards around the model: only addresses that appear
  verbatim in the message can be reported, a registered payee is never reported, and a report can only
  restrict.
- Model access: `LLM_BASE_URL` (default Fortytwo), `LLM_MODEL` (default `qwen/qwen3.8-27b`) and
  `LLM_API_KEY`. In this repository's cloud sessions the key is injected by the network proxy, so
  `npm run phase4` sets `NODE_USE_ENV_PROXY=1` to route Node's `fetch` through it.
- Every run is saved in `docs/guard/agent-runs/` (the model's tool calls and results, never a key).

## The Guard service (`service/`) and the live dashboard

- `service/indexer.ts` follows the vaults, the RiskOracle and GuardReactive on all three chains, links each
  GuardReactive decision to its origin transaction and its callback, and measures the time between their
  blocks. It looks back `LOOKBACK_SECONDS` (default two hours) at start-up.
- `service/server.ts`: `GET /api/health`, `GET /api/state`, and `POST /api/score`, where anyone can hand
  the AI scorer a message (2,000 characters; 3 per client per 10 minutes; 30 model calls and 12 on-chain
  reports per hour overall; reports only at 80 or more, and only restrict). `POST /api/watch {chain, vault}`
  asks GuardReactive to watch a vault: the service checks that its runtime code is GuardVault's, that its
  guardian is GuardReactive, and the cap (12 vaults), then sends `watch` from the registrar key, a role
  that may only watch, unwatch and immunize (2 per client per hour, 6 per hour overall).
- Deployed as the Railway service `antibody-guard` (root directory `reactive/`, `reactive/Dockerfile`)
  from the `reactive-guard` branch, at https://antibody-guard-production.up.railway.app. Variables:
  `PORT=8787`, `LOOKBACK_SECONDS`, `GUARD_SCORER_KEY` (the testnet key allowed on the RiskOracle) and
  `GUARD_REGISTRAR_KEY` and `LLM_API_KEY` (the model key; without it `/api/score` answers 503).
- The site is Antibody's frontend, ported in `frontend/` (landing, walkthrough, security, evidence, and the console at `/app`) on https://antibody-guard.netlify.app; Netlify sends `/api/*`
  to the service, so the page's CSP stays `'self'`. Run both locally with `npm run service` and `npm run web`.

## Your own vault: the `guard` CLI and the wallet console

Anyone can deploy their own GuardVault and have the shared GuardReactive watch it, from a terminal or
from a browser wallet.

- **CLI.** `curl -fsSL https://antibody-guard.netlify.app/install.sh | bash` installs `guard` (it clones
  this branch into `~/.antibody-guard/app`). Then `guard keys new`, `guard vault deploy`, `guard guardian`,
  `guard watch`, `guard payee add|activate`, `guard limit`, `guard schedule add`, `guard propose`,
  `guard freeze|unfreeze|release|withdraw`, `guard status`, `guard loops`. Every command takes `--chain`,
  `--vault` and `--json`.
- **Browser.** The console's Wallet section uses Reown AppKit (`wallet/`, bundled separately with
  esbuild). *My vault* deploys a GuardVault from the connected wallet, sets GuardReactive as guardian,
  asks Reactive to watch it, and manages payees, limits, schedules and payments; it also manages the
  demo vaults for their owner. *Public actions* holds what anyone may do: top up GuardReactive's
  lREACT reserves, retry a failed freeze or quarantine, and activate a payee whose delay has passed.
