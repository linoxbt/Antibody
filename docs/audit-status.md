# Audit status (second audit, 9 November 2026)

Every finding of the second full audit, what was done, and how it was verified.
"Test" names a regression test in `test/` that fails on the old code.

## High

| ID | Finding | Status | Verification |
| --- | --- | --- | --- |
| S1 | A leaked lane key could backdate a ledger record to slip outside a signer-window quarantine (proof of concept reproduced) | **Fixed.** Ledger checkpoints must not decrease by sequence and may not run ahead of the chain; control refuses such an append before storing it; an open-ended signer window covers every later ledger record of that key; checkpoints are bounded to safe integers | `test/backdate.test.ts` (7 tests, from the PoCs); mainnet ledger re-checked: checkpoints already monotonic |
| B1 | Under role isolation the sentinel wrote into control's private `cache/` | **Fixed.** Ingest keeps its state in `ingest/` (migrated once); `setup-roles.sh` gives it to `antibody-ingest`; file locks fail at once on errors other than "held" | `hardening.test.ts` B1 tests |
| B2 | Pending or unknown payments stayed that way forever; x402 settlement was read once | **Fixed.** The digest is computed from the bytes before signing, unsettled payments are reconciled on-chain before the next payment, x402 waits for the settlement, `antibody payments [list|reconcile|resolve]` | `hardening.test.ts` B2 tests; digest-from-bytes checked against two mainnet transactions |
| M1 | Demo video 3:12; the form asks for 2 to 3 minutes | **Fixed.** Re-cut to 2:55 by tightening pacing and two narration cuts; the spoken rule list now names all six rules shown; SIMULATED caption on the sandbox shots; new report id on the mainnet card | ffprobe 175.4 s; −14 LUFS; stills checked |

## Medium

| ID | Finding | Status | Verification |
| --- | --- | --- | --- |
| S2 | The ingest key could quarantine a user statement through a forged observation (PoC reproduced) | **Fixed.** An incident must name a Sui object id that is in Steward's wallet; a source seed never matches a human's own message id | `hardening.test.ts` S2; PoC now rejected |
| S3 | Daemons inherited every secret, including the owner key | **Fixed.** Per-role allowlist (`ROLE_SECRET_VARS`), reapplied after `antibody.env` is reloaded | `ops.test.ts` S3 |
| S4 | Model text unquoted in decision records; untrusted decisions labelled like trusted history | **Fixed.** Model fields JSON-quoted, verdict text escaped, untrusted-lineage decisions labelled as such | `hardening.test.ts` S4 (a newline in the recipient no longer forges a line) |
| S5 | A recorded revoke or rotation accepted any owner transaction, and an empty sender passed | **Fixed.** Must be `account::remove/add_delegate_key` on this account naming that key; unreadable or senderless fails closed | `hardening.test.ts` S5; parsing checked on a mainnet `add_delegate_key` |
| S6 | Sandbox sign-in could be starved (challenge eviction, global zkLogin budget, world creation) | **Fixed.** Limits per client for challenges, zkLogin checks and new worlds; Railway reads the client from `x-nf-client-connection-ip` | `cloud.test.ts` S6; load test (40 clients) |
| S7 | Sandbox worlds inherited the host's environment | **Fixed.** Only non-secret `ANTIBODY_*` settings reach a world | `cloud.test.ts` S7 |
| B3 | x402 ignored dry-run mode | **Fixed** | `system.test.ts` x402 |
| B4 | A payment could go out with no stored decision; unbounded inputs | **Fixed.** Inputs schema-bounded; decisions queued locally and flushed before the next payment | `hardening.test.ts` B4 |
| B5 | Wallet setup used a stale account id after creating the account | **Fixed** | code path reviewed; typecheck |
| B6 | Incidents dropped when the observation was not indexed yet; scans failed when control was down | **Fixed.** Deferred and retried; cached lessons | `hardening.test.ts` B6 |
| B7 | IPC timeouts reported as "cannot reach" (a second write could follow); stacked retries | **Fixed** | `ipc.test.ts` B7 |
| B8 | Daemons exited on a brief outage; the supervisor gave up after 12 exits | **Fixed.** Startup waits out an outage; only a configuration error (exit 78) stops the supervisor | `ops.test.ts` B8 |
| B9 / M2 | Report uploads never polled; the link served the whole Walrus quilt | **Fixed.** Job followed to `CERTIFIED`, quilt-patch link, `antibody report status`; mainnet report republished and all links updated | live link serves the JSON report |
| M3 | Evidence did not record the rebuild digest | **Fixed.** Both digests recorded; they match on mainnet | `docs/mainnet-evidence.md` |
| M4 | No mainnet revoke or rotate | **Fixed.** On 9 November the owner removed the agent key (`QyoP9hy3…`) and registered a fresh one (`5eckAme6…`); `lane.revoke` and `lane.rotate` are ledger #8 and #9 | `verify-ledger` passes; the fresh rebuild matches (`5a588326…a3c3`); all 13 earlier memories still verify |
| M5 | Probe P-5 unverified | **Labelled** in the README (Antibody does not rely on it) | |
| M6 | Qwen attack set listed as mainnet | **Fixed** (labelled simulated chain, real model calls) | |
| M7 | Blog claimed per-role OS users on mainnet | **Fixed** (qualified) | |

## Low

| ID | Finding | Status |
| --- | --- | --- |
| M8 | x402 bill server and facilitator were our own | **Disclosed** in README and blog |
| M9 | Lessons also come from automatic quarantines | **Docs fixed** (README, design notes) |
| M10 | R4 wording | **Fixed** |
| M11 | Design notes for the plain-JS console, the 5,000 cap; install page said "90" | **Fixed** (design notes 19 to 21) |
| M12 | Test count wording; evidence payments heading | **Fixed** |
| M13 | Daemons not running; old Railway services `sandbox`, `sandbox-v2` | **Operator action.** Deleting services needs the owner's confirmation |
| B10 | `.env.example` role names and passphrases | **Fixed** |
| B11 | `writeOwn` read the head outside the lock | **Fixed** |
| B12 | Non-numeric sandbox limits became NaN | **Fixed** (fail at start) |
| B13 | Sign-out without the session secret left the session alive | **Fixed** |
| B14 | Sandbox eviction could close a busy world | **Fixed** |
| B15 | Inventory paging stopped silently; HEAD 404; sandbox claimed Walrus refresh; `file://` paths; Guardians never refreshed | **Fixed** (paging anomalies fail closed) |
| B16 | Dead code, uncalled `/api/blast` | **Fixed** |
| S8 | IPC lane lookup trusted a stale snapshot, case-sensitive | **Fixed** |
| S9 | Duplicate guard: nudged amounts, eviction of open entries | **Fixed** (any payment to the same recipient and coin within 10 minutes; open entries never evicted) |
| S10 | Installers cloned unpinned `main`; checksums from the same origin | **Fixed / documented.** Site installers pinned to a released commit and verified; the install page states the checksums' limits |
| S11 | Plaintext secrets on the demo machine; keys pasted in chat | **Operator action:** rotate the Tatum and Fortytwo keys and retire the demo owner wallet after judging |

## Performance

The sentinel's lesson fetch reuses a verified snapshot under a minute old,
polling-mode scans have a minimum interval, chain retries no longer stack on the
transport's rate-limit retries, and the Guardians lists refresh in the
background. Each snapshot still lists both inventories; that is the price of
the completeness check and stays as is.
