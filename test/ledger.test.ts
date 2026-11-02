import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope } from '../src/core/envelope.ts';
import { sha256Hex, uuidv7 } from '../src/core/encoding.ts';
import { ledgerBodyText, verifyLedger, type LedgerRecord } from '../src/core/ledger.ts';
import { evaluatePayment } from '../src/core/policy.ts';
import { NS_LEDGER } from '../src/core/types.ts';
import { account, ACCT, ATTACKER, genesisStep, ledgerChain, makeKeys, payeeStep, stored, LANDLORD, USDC, tick } from './helpers.ts';
import { generateSeedHex, laneKeyFromSeedHex } from '../src/core/keys.ts';

const k = makeKeys();
const acct = account(k);
const input = (envs: ReturnType<typeof ledgerChain>, opts: { drop?: number; hwm?: { seq: number; hash: string } } = {}) => {
  const all = envs.map((e) => stored(e, NS_LEDGER));
  return {
    acct: ACCT,
    account: acct,
    inventory: all.map((m) => m.blobId),
    recalled: all.filter((_, i) => i !== opts.drop),
    hwm: opts.hwm ?? null,
  };
};

test('a well-formed ledger verifies and yields payees', () => {
  const r = verifyLedger(input(ledgerChain(k, [genesisStep(k), payeeStep()])));
  assert.ok(r.ok, !r.ok ? r.detail : '');
  assert.equal(r.ok && r.payees[0]!.address, LANDLORD);
  assert.equal(r.ok && r.firstSync, true);
});

test('T-10: one record in the inventory but missing from recall blocks all payments (I-6, I-11)', () => {
  const chain = ledgerChain(k, [genesisStep(k), payeeStep()]);
  const r = verifyLedger(input(chain, { drop: 1 }));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, 'LEDGER_INCOMPLETE');
  const v = evaluatePayment({ recipient: LANDLORD, amount: '1', coinType: USDC, reason: 'rent' }, r, { ok: true, ckpt: 1, sender: LANDLORD });
  assert.equal(v.decision, 'BLOCK');
  assert.equal(v.code, 'LEDGER_UNVERIFIED');
});

test('T-11: a forked sequence fails closed', () => {
  const chain = ledgerChain(k, [genesisStep(k), payeeStep()]);
  // A second, validly signed record claiming seq 1 on the same genesis.
  const rec: LedgerRecord = { seq: 1, prev: sha256Hex(chain[0]!.text), type: 'payee.add', payload: payeeStep('evil', '0x' + 'ee'.repeat(32)).payload };
  const forked = buildEnvelope({ id: uuidv7(tick()), acct: ACCT, ns: NS_LEDGER, lane: 'user', kind: 'ledger', ckpt: 101, ts: 'x', text: ledgerBodyText(rec) }, k.lane.user);
  const r = verifyLedger(input([...chain, forked]));
  assert.equal(!r.ok && r.code, 'LEDGER_CORRUPT');
  assert.match(!r.ok ? r.detail : '', /fork/);
});

test('T-11: a broken prev hash fails closed', () => {
  const chain = ledgerChain(k, [genesisStep(k), payeeStep()]);
  const rec: LedgerRecord = { seq: 1, prev: 'f'.repeat(64), type: 'payee.add', payload: payeeStep().payload };
  const bad = buildEnvelope({ id: uuidv7(tick()), acct: ACCT, ns: NS_LEDGER, lane: 'user', kind: 'ledger', ckpt: 101, ts: 'x', text: ledgerBodyText(rec) }, k.lane.user);
  const r = verifyLedger(input([chain[0]!, bad]));
  assert.equal(!r.ok && r.code, 'LEDGER_CORRUPT');
});

test('T-11: a payee.add signed by the antibody lane fails closed (signer rules)', () => {
  const r = verifyLedger(input(ledgerChain(k, [genesisStep(k), { ...payeeStep(), lane: 'antibody' }])));
  assert.equal(!r.ok && r.code, 'LEDGER_CORRUPT');
  assert.match(!r.ok ? r.detail : '', /must be signed by the user lane/);
});

test('T-11: a gap in the sequence fails closed', () => {
  const chain = ledgerChain(k, [genesisStep(k), payeeStep(), payeeStep('sister', '0x' + '55'.repeat(32))]);
  const all = input(chain);
  all.inventory.splice(1, 1);
  all.recalled.splice(1, 1);
  const r = verifyLedger(all);
  assert.equal(!r.ok && r.code, 'LEDGER_CORRUPT');
});

test('T-12: a ledger head rolled back below the high-water mark fails closed', () => {
  const chain = ledgerChain(k, [genesisStep(k), payeeStep(), payeeStep('sister', '0x' + '55'.repeat(32))]);
  const full = verifyLedger(input(chain));
  assert.ok(full.ok);
  const hwm = full.ok ? full.head : { seq: 0, hash: '' };
  const short = verifyLedger(input(chain.slice(0, 2), { hwm }));
  assert.equal(!short.ok && short.code, 'LEDGER_ROLLBACK');
  // A different history at the same height is also caught.
  const other = ledgerChain(k, [genesisStep(k), payeeStep('x', '0x' + '99'.repeat(32)), payeeStep('y', '0x' + '98'.repeat(32))]);
  assert.equal(verifyLedger(input(other, { hwm })).ok, false);
});

test('quarantine.release is honoured, and a signer-window seed excludes payee records signed with a leaked key', () => {
  const steps = [
    genesisStep(k),
    payeeStep(),
    { type: 'quarantine' as const, lane: 'antibody' as const, payload: { seed: { type: 'signer-window' as const, value: k.lane.user.publicKeyHex, from: 0, to: 101 }, reason: 'user key leaked', evidence: [], ckpt: 200, auto: false } },
  ];
  const r = verifyLedger(input(ledgerChain(k, steps)));
  assert.ok(r.ok);
  assert.equal(r.ok && r.payees.length, 0);
  assert.equal(r.ok && r.excluded[0]!.type, 'payee.add');

  const released = verifyLedger(input(ledgerChain(k, [...steps, { type: 'quarantine.release' as const, lane: 'user' as const, ckpt: 300, payload: { quarantineSeq: 2, reason: 'false alarm' } }])));
  assert.ok(released.ok);
  assert.equal(released.ok && released.payees.length, 1);
});

test('lessons retire when the quarantine they came from is released', () => {
  const steps = [
    genesisStep(k),
    { type: 'quarantine' as const, lane: 'antibody' as const, payload: { seed: { type: 'source' as const, value: '0x' + 'cc'.repeat(32) }, reason: 'poison', evidence: [], ckpt: 120, auto: false } },
    { type: 'lesson' as const, lane: 'antibody' as const, payload: { fromSeq: 1, indicators: { senders: ['0x' + 'aa'.repeat(32)], coinTypes: [], packages: [], keywords: ['landlord'] }, summary: 'poison' } },
  ];
  const r = verifyLedger(input(ledgerChain(k, steps)));
  assert.equal(r.ok && r.lessons[0]!.active, true);
  const rel = verifyLedger(input(ledgerChain(k, [...steps, { type: 'quarantine.release' as const, lane: 'user' as const, payload: { quarantineSeq: 1, reason: 'mistake' } }])));
  assert.equal(rel.ok && rel.lessons[0]!.active, false);
});

test('records signed by a revoked key after its revocation checkpoint fail closed', () => {
  // The user key is revoked at checkpoint 150 and removed from the account.
  const steps = [genesisStep(k), { type: 'lane.revoke' as const, lane: 'antibody' as const, payload: { pub: k.lane.user.publicKeyHex, label: 'antibody:user', digest: 'D'.repeat(44), ckpt: 150 }, ckpt: 160 }, { ...payeeStep(), ckpt: 200 }];
  const acctNoUser = { ...acct, delegateKeys: acct.delegateKeys.filter((d) => d.publicKeyHex !== k.lane.user.publicKeyHex) };
  const envs = ledgerChain(k, steps);
  const all = envs.map((e) => stored(e, NS_LEDGER));
  const r = verifyLedger({ acct: ACCT, account: acctNoUser, inventory: all.map((m) => m.blobId), recalled: all, hwm: null });
  assert.equal(!r.ok && r.code, 'LEDGER_CORRUPT');
  assert.match(!r.ok ? r.detail : '', /SIGNER_REVOKED/);
});

// ---- S1: key history only from control-signed records -----------------------------

/** Append records signed by arbitrary keys onto a legitimate chain (attacker with relayer write access). */
function forge(kk: ReturnType<typeof makeKeys>, extra: { type: LedgerRecord['type']; payload: unknown; lane: 'antibody' | 'user'; key: { publicKeyHex: string; sign(m: Uint8Array): Uint8Array }; ckpt?: number }[]) {
  const legit = ledgerChain(kk, [genesisStep(kk), payeeStep()]);
  let prev = sha256Hex(legit[legit.length - 1]!.text);
  const out = [...legit];
  extra.forEach((x, i) => {
    const rec = { seq: legit.length + i, prev, type: x.type, payload: x.payload } as LedgerRecord;
    const env = buildEnvelope({ id: uuidv7(tick()), acct: ACCT, ns: NS_LEDGER, lane: x.lane, kind: 'ledger', ckpt: x.ckpt ?? 500, ts: 'x', text: ledgerBodyText(rec) }, x.key as never);
    out.push(env);
    prev = sha256Hex(env.text);
  });
  return out.map((e) => stored(e, NS_LEDGER));
}

test('S1: a lane.revoke signed by a key that is not on-chain cannot authorise itself or a new user key', () => {
  const kk = makeKeys();
  const X = laneKeyFromSeedHex(generateSeedHex());
  const Y = laneKeyFromSeedHex(generateSeedHex());
  const s = forge(kk, [
    { type: 'lane.revoke', payload: { pub: X.publicKeyHex, label: 'antibody:control', digest: 'x'.repeat(32), ckpt: 1e15 }, lane: 'antibody', key: X },
    { type: 'lane.revoke', payload: { pub: Y.publicKeyHex, label: 'antibody:user', digest: 'x'.repeat(32), ckpt: 1e15 }, lane: 'antibody', key: X },
    { type: 'payee.add', payload: payeeStep('evil', ATTACKER, '999999999999').payload, lane: 'user', key: Y },
  ]);
  const r = verifyLedger({ acct: ACCT, account: account(kk), inventory: s.map((x) => x.blobId), recalled: s, hwm: null });
  assert.equal(!r.ok && r.code, 'LEDGER_CORRUPT');
});

test('S1: even the control key cannot revoke a key nobody bound, revoke the control lane, or backdate past its own checkpoint', () => {
  const kk = makeKeys();
  const stranger = laneKeyFromSeedHex(generateSeedHex());
  const cases: [string, unknown, RegExp][] = [
    ['unbound key', { pub: stranger.publicKeyHex, label: 'antibody:user', digest: 'x'.repeat(32), ckpt: 10 }, /not a bound lane key/],
    ['control lane', { pub: kk.lane.antibody.publicKeyHex, label: 'antibody:control', digest: 'x'.repeat(32), ckpt: 10 }, /control lane cannot be revoked/],
    ['wrong lane', { pub: kk.lane.agent.publicKeyHex, label: 'antibody:user', digest: 'x'.repeat(32), ckpt: 10 }, /names a agent key as user/],
    ['future ckpt', { pub: kk.lane.agent.publicKeyHex, label: 'antibody:agent', digest: 'x'.repeat(32), ckpt: 9999 }, /after the record's own checkpoint/],
  ];
  for (const [name, payload, re] of cases) {
    const s = forge(kk, [{ type: 'lane.revoke', payload, lane: 'antibody', key: kk.lane.antibody }]);
    const r = verifyLedger({ acct: ACCT, account: account(kk), inventory: s.map((x) => x.blobId), recalled: s, hwm: null });
    assert.equal(!r.ok && r.code, 'LEDGER_CORRUPT', name);
    assert.match(!r.ok ? r.detail : '', re, name);
  }
});

test('S1: a forged genesis naming a key that is not antibody:control on-chain never verifies', () => {
  const kk = makeKeys();
  const fake = makeKeys(); // attacker's own four keys; only the account's real keys are on-chain
  const envs = ledgerChain(fake, [genesisStep(fake), payeeStep('evil', ATTACKER)]);
  const s = envs.map((e) => stored(e, NS_LEDGER));
  const r = verifyLedger({ acct: ACCT, account: account(kk), inventory: s.map((x) => x.blobId), recalled: s, hwm: null });
  assert.equal(r.ok, false);
});
