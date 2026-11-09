# Changelog

## 1.2.0 — 2026-11-09

Second full audit; every finding and its verification is in
[docs/audit-status.md](docs/audit-status.md).

### Security
- Ledger checkpoints only move forward: a leaked key can no longer backdate a
  record around its own signer-window quarantine (S1).
- The ingest lane can only raise incidents about objects really in Steward's
  wallet, and cannot reach a user statement (S2).
- Daemons keep only their own role's secrets; the owner key reaches none (S3).
- Model text in decision records is quoted; untrusted decisions say so (S4).
- Recorded revokes and rotations must be the exact owner call for that key (S5).
- Sandbox: per-client sign-in and world limits; worlds see no host secrets (S6, S7).
- Duplicate guard covers any payment to the same recipient and coin within ten
  minutes; IPC lane lookup re-reads the chain when stale (S8, S9).
- Site installers are pinned to a released commit and verify it (S10).

### Payments and reliability
- Payment outcomes settle from the chain (digest known before signing);
  `antibody payments [list|reconcile|resolve]` (B2).
- x402 honours dry-run; decisions are never lost to a relayer failure (B3, B4).
- Daemons wait out a brief outage; the supervisor no longer gives up (B8).
- Incident reports are followed to certification and linked as JSON;
  `antibody report status`; the mainnet report was republished (B9).
- The sentinel keeps its own state directory; deferred incidents; cached
  lessons; Guardians lists refresh (B1, B6, B15).
- `antibody evidence` records the fresh-rebuild digest next to the cached one (M3).

## 1.1.0 — 2026-11-02

### Mainnet run (2026-11-05)
- Full demo on Sui mainnet with real Walrus Memory writes: setup on an existing
  account, payees, statements, a real attack coin from a separate wallet, the
  sentinel's incident, a blocked theft, quarantine and lesson, the repeat
  attack auto-quarantined, a fresh rebuild with a matching digest, three real
  payments (one over x402) and an incident report through Tatum. Every
  identifier is in `docs/mainnet-evidence.md` (`antibody evidence`).
- Fixes found on the way: Tatum 429s retried on gRPC calls; one wallet scan at
  a time across processes (a coin was observed twice); `ANTIBODY_X402_ALLOW`
  accepts origins as documented; the sentinel's stream has a watchdog and a
  5-minute safety scan (hardening against a silent stall; the run itself
  showed a one-minute delay, not a stall).

### Chain
- Native gRPC (HTTP/2) to Tatum's Sui gateway by default: Tatum answers gRPC-Web
  with native gRPC, so mainnet reads through Tatum failed. Checked live:
  checkpoint reads, object reads and the checkpoint stream.
  `ANTIBODY_GRPC_WIRE=web` keeps the old wire.

### Models
- `LLM_PROVIDER=fortytwo`: Steward on Qwen over the Fortytwo network with one
  key. Reasoning effort is configurable and the model's reasoning is sent back
  on the next call, as reasoning providers require. Every model call has a
  deadline. `antibody llm test` checks key, model name and tool calling; doctor
  checks the model is served.

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
