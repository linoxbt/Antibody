# Design notes: where the build refines spec v1

Each item says what changed, why, and what it costs. None weakens an invariant.

## 1. Chain transport: gRPC by default

Spec v1 used Tatum's Sui JSON-RPC as the Phase 1 transport, with gRPC in Phase 2.
On 2026-10-29 the public Sui fullnode answered JSON-RPC with *"JSON-RPC on public
fullnodes has been deprecated. Please migrate to gRPC or GraphQL"*. Tatum's
changelog says Sui JSON-RPC was deprecated on 2026-04-22 and that Tatum is moving
Sui to gRPC; the Walrus Memory relayer's own `/config` reports `suiTransport: grpc`.

So `ChainReader` is implemented once on the Sui SDK core API (`SdkChainReader`)
over **gRPC by default** (`https://sui-mainnet-grpc.gateway.tatum.io`, `x-api-key`
metadata). JSON-RPC is the same class with `ANTIBODY_CHAIN_TRANSPORT=jsonrpc`.
Verified live: account reads, balances, owned objects, coin metadata,
transactions, and a dry-run that passes R5.

## 2. Decision records are written by control

The spec said decisions were written "by Steward" (§6) and "by the control
process, lane antibody" (§8). Control writes them: it is the only process that
sees the verdict and the transaction digest, and the agent lane must not be able
to forge a record of a payment. Decisions are `kind: decision` on the antibody
lane in `steward.mem`, parents = the turn's readSet, class = lowest of the
parents capped at `derived` (never trusted). They reach Steward's context as
`[PAYMENT RECORD]`.

## 3. LABEL_MISMATCH before UNKNOWN_RECIPIENT

Rules still evaluate in order and the first failure blocks. When R2 fails
(unknown recipient) *and* the proposal names a label registered to a different
address, the code is `LABEL_MISMATCH`, the more specific diagnosis. Both are
blocks; only the message changes. This makes the demo line ("landlord is
registered to 0x7a…") true whether or not the model passes a label.

## 4. Lessons are ledger records

The learning loop has to be durable, rebuildable and tamper-evident, and poison
must not be able to teach it. A `lesson` record type (antibody-signed) is
derived deterministically from a human-confirmed quarantine. It reverts when
that quarantine is released, and it is covered by the projection digest. Lessons
tighten the sentinel only; they never reach the policy engine.

## 5. The lane tag carries the envelope id

The base64 header is opaque to semantic search, but the rebuild query plan needs
to find records by parent id. The body's first line is
`[lane:<lane> kind:<kind> id:<uuid>]`. The verifier requires it to match the
header exactly, and `laneQuery` still finds every record of a lane and kind.

## 6. Missing lanes are reported, not fatal, during verification

"Exactly one active key per lane, otherwise refuse to start" is enforced per
process for its own lane (`assertOwnLane`). Ledger verification tolerates a lane
with zero or two keys (reported in `issues`). Otherwise control could not write
`lane.revoke` or `lane.rotate` in the window between removing and adding a key.

## 7. Removed keys without a revoke record verify nothing

A key named by genesis or `lane.rotate` that is gone from `delegate_keys`
without a `lane.revoke` record has no upper bound on its authority, so nothing
it signed verifies (`SIGNER_REMOVED`). `antibody revoke` always writes the record.

## 8. Ledger exclusion is asymmetric

A `signer-window` seed (leaked user key) excludes `payee.add` and
`quarantine.release` records signed in the window: records that grant. It never
excludes `payee.remove`: undoing a removal would re-enable a payee.

## 9. Local index is a JSON file

`cache/index.json` (blob id → text) replaces SQLite. It is disposable: blobs are
immutable, verification runs on every projection, and `rebuild --fresh`
ignores it. `node:sqlite` is still experimental on Node 22 and prints warnings.

## 10. Ed25519 verification uses Node's native implementation

Signing uses `@noble/ed25519` (the MemWal SDK's own dependency). Verification
uses `node:crypto` (≈20× faster), cross-checked against noble in the tests, to
keep "500 envelopes < 1 s" with headroom.

## 11. Revoking the control lane is out of scope

The control key signs `lane.revoke`, and the relayer rejects removed keys. So
revoking `antibody:control` requires the owner to rotate first. The CLI refuses
it with that explanation.

## 12. Agent payments (x402) added

The hackathon has a *Best Use of Agent Payments* award (x402 or MPP, settled on
Sui). x402 v2 over HTTP with the Sui `exact` scheme is implemented as a fourth
Steward tool behind the same policy. The signer signs without executing, and the
facilitator settles. Public Sui x402 facilitators were testnet- or
hackathon-stage when this was written, so the repo ships a reference resource
server and facilitator. Verify a mainnet facilitator before relying on a third party.

## 13. Pasted text is a fourth carrier

The attack set's "user-pasted text marked external" carrier needs a path. Pasted
text enters through the wallet-objects lane as an untrusted observation
(`antibody ingest paste`), never as a user statement.
