# Antibody Guard: build plan (Reactive Omni Buildathon)

Branch `reactive-guard` only; nothing reaches `main` without the owner's go-ahead.
Deadline: 5 December 2026, 20:00 UTC. Track: Set It and Forget It (AI scorer optional).

**The idea.** An AI agent may *propose* payments; it never holds the money. A guarded vault
enforces Antibody's rules in Solidity, and a Reactive contract watches the agent's wallets on
several EVM chains and reacts on its own, with no server, bot or keeper: it freezes a vault
under attack, quarantines a poisoning sender everywhere at once, and settles recurring
payments when they fall due, even while the agent is offline.

## Phase 0: foundations (done)
- Branch, plan, and a separate `reactive/` Hardhat project (Hardhat 3, Solidity tests).
- Reactive library pinned to a commit (`reactive/scripts/fetch-deps.sh`), not vendored.
- Network map: Reactive Lasna (5318007), Base Sepolia (84532), Ethereum Sepolia (11155111),
  Unichain Sepolia (1301), with each chain's callback proxy.
- Contract interfaces: the events the vault emits and the callbacks it accepts.
- Skeletons of `GuardVault` and `GuardReactive` that compile, with a first test.
- Testnet deployer key generated locally (never committed); funding instructions.
- A separate Netlify site for the new version, deployed from this branch.

## Phase 1: the guarded vault (Base Sepolia)
- Payee registry with labels and per-payment caps; daily spending limit.
- `proposePayment(to, amount, label)` for the agent; the six Antibody rules in Solidity.
- Timelocked payee changes (owner adds, takes effect after a delay; can be cancelled).
- Freeze / unfreeze, sender quarantine, and the callback entry points (proxy + sender checked).
- Full unit tests, deployed and verified on Base Sepolia.

## Phase 2: the Reactive contract (Lasna)
- Subscribes to the vault's events: incoming tokens, payment proposals, payee changes, outflows.
- Rules in `react()`: payment burst → freeze; token from a quarantined sender → quarantine;
  payee change → alert and delay; outflow above the daily limit → freeze.
- Callbacks to the vault; transaction hashes for the whole loop, origin event to callback.

## Phase 3: cross-chain and offline rules
- The same guard on a second chain (Sepolia or Unichain Sepolia); an attack on one chain
  quarantines the sender on all of them.
- Recurring payments driven by Reactive CRON (rent settles itself while the agent is off).
- Lessons: a quarantined sender's next token is blocked without any off-chain help.

## Phase 4: the agent and the optional AI scorer
- Steward (Qwen on Fortytwo) proposes payments through the vault instead of signing them.
- Optional: an AI scorer reads token names and memos, writes a score on-chain, and the
  Reactive contract quarantines above a threshold (the model can restrict, never approve).

## Phase 5: dashboard and evidence
- Web dashboard: vault state, payees, live Reactive events, quarantines, an "attack it" button.
- Evidence page: addresses, transaction hashes per loop, measured latency (event to callback).

## Phase 6: submission
- README, architecture diagram, demo video under three minutes, DoraHacks submission.

## Phase 0 result
- `reactive/`: Hardhat 3.22, solc 0.8.30, reactive-lib-omni pinned at `3ade0dc`, forge-std 1.9.7.
- `IGuardVault`, `GuardVault` (callback side), `GuardReactive` (subscribes to `PaymentRefused`,
  freezes the vault after three refusals): 10 Solidity tests, run in CI (`contracts` job).
- Testnet deployer `0x7fE926e147D40cD4a92241a50F2B91EF7Cf5903B`; key at `~/.antibody-guard/deployer.key`
  on the build machine only (`npm run deployer -- show` prints balances on all four networks).
- Status site: https://antibody-guard.netlify.app (Netlify site `antibody-guard`), built by `npm run web`.
