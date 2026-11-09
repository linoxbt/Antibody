/** S1: a leaked lane key cannot backdate or future-date ledger records around a signer-window quarantine. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { verifyLedger } from '../src/core/ledger.ts';
import { seedMatches } from '../src/core/seeds.ts';
import { makeKeys, account, ledgerChain, genesisStep, payeeStep, stored, ACCT, ATTACKER } from './helpers.ts';

type Step = Parameters<typeof ledgerChain>[1][number];

function verify(k: ReturnType<typeof makeKeys>, steps: Step[], chainCkpt?: number) {
  const st = ledgerChain(k, steps).map((e) => stored(e));
  return verifyLedger({ acct: ACCT, account: account(k), inventory: st.map((s) => s.blobId), recalled: st, ...(chainCkpt !== undefined ? { chainCkpt } : {}) });
}

function quarantineUser(k: ReturnType<typeof makeKeys>, ckpt: number, from: number): Step {
  return { type: 'quarantine', lane: 'antibody', ckpt, payload: { seed: { type: 'signer-window', value: k.lane.user.publicKeyHex, from }, reason: 'user key leaked', evidence: [], ckpt, auto: false } } as Step;
}

test('S1: a record claiming an earlier checkpoint than the record before it fails closed', () => {
  const k = makeKeys();
  const r = verify(k, [genesisStep(k), { ...payeeStep(), ckpt: 101 }, quarantineUser(k, 5000, 4000), { ...payeeStep('evil', ATTACKER), ckpt: 3999 } as Step]);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, 'LEDGER_CORRUPT');
  assert.match(!r.ok ? r.detail : '', /backdated/);
});

test('S1: a backdated release of a signer-window quarantine is refused', () => {
  const k = makeKeys();
  const r = verify(k, [genesisStep(k), quarantineUser(k, 5000, 4000), { type: 'quarantine.release', lane: 'user', ckpt: 3998, payload: { quarantineSeq: 1, reason: 'all clear' } } as Step]);
  assert.equal(r.ok, false);
});

test('S1: an open-ended signer window covers every later ledger record of that key, whatever checkpoint it claims', () => {
  const k = makeKeys();
  // Window starts in the future relative to the quarantine record: the later record still claims a checkpoint below it.
  const r = verify(k, [genesisStep(k), quarantineUser(k, 5000, 9000), { ...payeeStep('evil', ATTACKER), ckpt: 5001 } as Step]);
  assert.ok(r.ok);
  assert.deepEqual(r.payees.map((p) => p.payeeId), []);
  assert.deepEqual(r.excluded.map((e) => e.seq), [2]);
});

test('S1: honest records signed before the quarantine stay valid', () => {
  const k = makeKeys();
  const r = verify(k, [genesisStep(k), { ...payeeStep(), ckpt: 101 }, quarantineUser(k, 5000, 4000)]);
  assert.ok(r.ok);
  assert.deepEqual(r.payees.map((p) => p.payeeId), ['landlord']);
});

test('S1: a future-dated record fails closed against the chain checkpoint', () => {
  const k = makeKeys();
  const steps = [genesisStep(k), quarantineUser(k, 5000, 4000), { ...payeeStep('evil', ATTACKER), ckpt: 9_000_000 } as Step];
  assert.equal(verify(k, steps, 5100).ok, false);
});

test('S1: checkpoints beyond the safe-integer range are rejected, and open windows have no upper bound', () => {
  const k = makeKeys();
  assert.throws(() => verify(k, [genesisStep(k), { ...payeeStep('evil', ATTACKER), ckpt: Number.MAX_SAFE_INTEGER + 2 } as Step]));
  const h = { pub: k.lane.user.publicKeyHex, ckpt: Number.MAX_SAFE_INTEGER } as Parameters<typeof seedMatches>[1];
  assert.ok(seedMatches({ type: 'signer-window', value: k.lane.user.publicKeyHex, from: 4000 }, h));
});

test('S1: control refuses to store a backdated append, so the ledger stays verifiable', async () => {
  const { createWorld, seedBaseline } = await import('../src/dev/world.ts');
  const { buildEnvelope } = await import('../src/core/envelope.ts');
  const { uuidv7 } = await import('../src/core/encoding.ts');
  const { laneKeyFromSeedHex } = await import('../src/core/keys.ts');
  const { ledgerBodyText } = await import('../src/core/ledger.ts');
  const { NS_LEDGER } = await import('../src/core/types.ts');
  const w = await createWorld();
  try {
    await seedBaseline(w);
    const h = await w.control.head();
    const user = laneKeyFromSeedHex(w.readKey('user'));
    const record = { seq: h.seq, prev: h.prev, type: 'payee.remove' as const, payload: { payeeId: 'landlord' } };
    const sign = (ckpt: number) => buildEnvelope({ id: uuidv7(Date.now()), acct: h.acct, ns: NS_LEDGER, lane: 'user', kind: 'ledger', ckpt, ts: new Date().toISOString(), text: ledgerBodyText(record) }, user).text;
    await assert.rejects(w.control.appendLedger(sign(0)), /earlier than the ledger head/);
    await assert.rejects(w.control.appendLedger(sign(h.ckpt + 1_000_000)), /ahead of the chain/);
    assert.ok((await w.control.snapshot()).ledger.ok);
    assert.equal((await w.control.appendLedger(sign(h.ckpt))).seq, h.seq);
  } finally {
    w.dispose();
  }
});
