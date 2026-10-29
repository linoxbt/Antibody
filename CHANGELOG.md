# Changelog

## 1.0.0 — 2026-10-29

First release. Everything below runs on the simulated backend with no keys;
mainnet needs a Walrus Memory account, a Tatum key and your owner wallet (see
[the install guide](https://antibody-memory.netlify.app/install#mainnet)).

### Protection
- Signed envelopes on four lanes (user, agent, wallet objects, control), lineage
  and taint tracking, and a hash-chained ledger on Walrus Memory; payments are
  decided by code (rules R0–R5), never by the model.
- Quarantine by source, memory, turn or signer window, with a blast-radius
  preview; nothing is deleted. Lessons learned from a quarantine auto-quarantine
  repeat attacks.
- Always-on sentinel on Sui checkpoint streaming (gRPC), polling fallback.
- Second-RPC cross-check of the delegate set; disagreement fails closed.
- Owner-wallet revocation and rotation; incident reports to Walrus via Tatum.
- Ledger beyond 90 records (now up to 5000); gaps still fail closed.

### Operating it
- `antibody doctor`: the whole install checked, with a fix for each problem.
- `antibody up --foreground` supervisor and `antibody service install` for
  systemd, launchd and Task Scheduler.
- Retries with backoff for the relayer and the Sui RPC; a degraded banner and
  per-connection health in the console.
- Alerts to a webhook or Telegram for incidents, quarantines, blocked payments
  and ledger failures.
- State format versioning with migrations and backups.

### Keys
- Optional encryption of key files at rest (scrypt + AES-256-GCM).
- `setup`, `revoke` and `rotate` with `--wallet`: the owner's browser wallet
  signs; the owner key never touches the machine.
- Role separation script for Linux and macOS.

### Apps and install
- One-line installers for Windows (PowerShell), macOS and Linux, with
  published SHA-256 checksums; Start menu, desktop, app-menu and
  `~/Applications` launchers; `antibody open`.
- The console installs as an app (PWA) and opens offline to a clear notice.
- Hosted sandbox: any Sui wallet gets its own simulated Antibody, with
  persistent sessions, global limits, idle cleanup and metrics.

### Quality
- 104 unit tests, seeded fuzzing, browser end-to-end tests with an injected
  Wallet Standard wallet, axe accessibility checks (WCAG 2.1 AA), CI on
  Linux, macOS and Windows including the real installers.
