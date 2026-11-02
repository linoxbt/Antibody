# Changelog

## 1.1.0 — 2026-11-02

Fixes from a full audit of 1.0.0. Upgrading is in place; on a machine with no
ledger high-water mark run `antibody verify-ledger --accept` once.

### Security
- Ledger key changes are accepted only from control-signed history; outsider
  records are ignored as noise (S1). Quarantine closure covers unverified and
  duplicate ids (B2, S3). Back-dated records are flagged from the relayer's
  `createdAt`.
- Incidents are revalidated before they act; auto-quarantine has a budget per
  sender (S2, S4). The signer checks the shape of every transaction (S5).
- Payments: duplicate refusal and serialisation (B6, M8); x402 is opt-in with an
  origin allowlist, no redirects, deadlines and on-chain settlement checks (S7).
- IPC responses are signed; nonces are reserved before use; bodies capped (S13).
- Local console: session secret header, Host allowlist, Origin checks (S11).
  Hosted sandbox: `__Host-` cookies, session only after the world exists,
  `/metrics` off without a token, fixed sign-in origin (S8, S14, S15). Owner
  approval page bound to the first browser (S6). Reports redact private text (S9).
- Per-role key passphrases; rotation runs as the lane's role (S16, B9).
- Container runs as an unprivileged user; nothing secret goes into the image
  (S12). Security headers on the public site; CI actions pinned, read-only token.

### Reliability
- Alerts can no longer crash control (B3); strict configuration (B8); network
  deadlines on every chain, relayer and storage call; ingest outbox so an
  observation is never lost between scan and write; flapping checkpoint streams
  back off to polling (B24); doctor works under role separation (B26).
- Revoking the user lane no longer deadlocks; interrupted revokes and rotations
  can be recorded afterwards (`--record-only`).
- Quarantines that match nothing need an explicit confirmation; duplicate payees
  are refused (B15, B18). Ledger verification and projection are memoised.
- Installers: run only when fully downloaded, detect a failed update, keep
  `%VAR%` entries in the Windows PATH, use `npm.cmd` (B27).

### Honest numbers
- The attack-set table is computed from the runs, including the blocked cell
  (M10), and CI fails on any unsafe execution or wrongly blocked rent.
- `.env.example` lists every variable (M12); unused code removed and the
  compiler now rejects unused code (M14).

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
