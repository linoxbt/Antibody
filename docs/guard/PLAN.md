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

## Phase 1: the guarded vault (Base Sepolia) (done)
- Payee registry with labels and per-payment caps; daily spending limit.
- `proposePayment(to, amount, label)` for the agent; the six Antibody rules in Solidity.
- Timelocked payee changes (owner adds, takes effect after a delay; can be cancelled).
- Freeze / unfreeze, sender quarantine, and the callback entry points (proxy + sender checked).
- Full unit tests, deployed and verified on Base Sepolia.

## Phase 2 (done): the Reactive contract (Lasna)
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

## Phase 1 result
- `GuardVault` deployed on Base Sepolia at `0xb30ccddd31c4e14186801d74ea45a905b7305d4b`,
  verified on Sourcify (exact match). Payee timelock 120 s on testnet; daily limit 0.01 ETH.
- Rules, checked in order: frozen, quarantined, unknown payee, label mismatch, over cap,
  over daily limit, duplicate (10 min), and a failed transfer is rolled back and refused.
  A refusal is an event (`PaymentRefused` with its code), not a revert, so Reactive can see it.
- The guardian (GuardReactive) is set by the owner after it is deployed in Phase 2; until then no
  callback is accepted.
- On-chain run: 2 payments paid, 4 refused (LabelMismatch, UnknownPayee, OverCap, Duplicate);
  see [evidence-baseSepolia.md](evidence-baseSepolia.md).
- 30 Solidity tests including a fuzz test of the agent against the rules.

## Phase 2 result
- `GuardReactive` on Lasna at `0xb30ccddd31c4e14186801d74ea45a905b7305d4b` (Sourcify exact match),
  guardian of the Base Sepolia vault. Rules: burst (more than 5 proposals in 120 s) and repeated
  refusals (3 in 600 s) freeze the vault; an unknown recipient is quarantined. Counters reset when
  the owner unfreezes; frozen state and quarantines are mirrored from the vault's own events.
- Three live loops, each origin -> reactive -> callback, recorded in
  [evidence-lasna.md](evidence-lasna.md): the vault changed 1 to 2 s (block timestamps) after the
  agent's transaction.
- The system contract's `getCallbacks()` returned an empty record on Lasna, so callbacks are linked
  by the vault event they produced in a transaction to the callback proxy (`npm run link-callbacks`).
- 39 Solidity tests, including the full loop simulated in one EVM (real vault events fed to
  GuardReactive, its callbacks delivered back through a stand-in proxy).

## Phase 3 result (Base Sepolia done; Ethereum Sepolia waits for funds)
- v2 contracts, Sourcify exact matches: `GuardReactive` v2 on Lasna
  `0x7900d7765473eba75a816ccf58a481399036a282`, `GuardVault` v2 on Base Sepolia
  `0x114e6c7e2cd7feeec8d75912cf762f1fc45dc7d2`. Version 1 stays deployed as the Phase 1 and 2 record.
- Lessons: a quarantine confirmed on any vault makes the address a known attacker and is requested on
  every other watched vault; `watch()` immunizes a new vault with the lessons so far.
- Veto: a payee change towards a known attacker is cancelled by callback before its timelock ends; the
  vault also refuses to activate a quarantined address on its own.
- Recurring payments: the vault holds the schedules and enforces due times; GuardReactive mirrors them
  and subscribes to Cron100 only while one is active (every tick is billed), unsubscribing on the last
  cancellation.
- Following Reactive MCP's pitfalls: every callback is idempotent (logs can be delivered twice), and a
  freeze or quarantine not confirmed within 10 minutes can be re-requested by anyone (no network retries).
- 53 Solidity tests, including two vaults on two simulated chains and CRON ticks.
- Live: D (quarantine and lesson), E (veto), F (two CRON payments, then CRON off) on Base Sepolia;
  G (Sepolia vault immunized at once, and an attacker seen on Sepolia quarantined on Base Sepolia)
  runs with `npm run phase3 -- G` once the deployer has about 0.03 ETH on Ethereum Sepolia.
- Base Sepolia now produces several blocks per second, so some callbacks land within the same second
  as the agent's transaction (4 blocks later).
