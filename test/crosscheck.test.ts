// FR-19: the delegate set must read the same from two providers, or nothing proceeds.
import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ChainDisagreement, CrossCheckedChain, delegateFingerprint } from '../src/adapters/chain-crosscheck.ts';
import type { ChainReader } from '../src/adapters/chain.ts';
import type { AccountState } from '../src/core/lanes.ts';
import { CAST, createWorld, seedBaseline, type World } from '../src/dev/world.ts';
import { buildControl } from '../src/services.ts';

const worlds: World[] = [];
after(() => worlds.forEach((w) => w.dispose()));

const acct = (keys: [string, string][], owner = '0xa'): AccountState => ({ accountId: '0x1', owner, active: true, delegateKeys: keys.map(([publicKeyHex, label]) => ({ publicKeyHex, label, suiAddress: '0x0', createdAtMs: 0 })) }) as unknown as AccountState;
const reader = (fn: () => AccountState) => ({ kind: 'fixture', simulated: true, getAccount: async () => fn() }) as unknown as ChainReader;

test('agreement passes; order and hex case do not matter; owner, flag and labels do', async () => {
  const a = acct([['aa', 'antibody:user'], ['bb', 'antibody:agent']]);
  const b = acct([['BB', 'antibody:agent'], ['AA', 'antibody:user']]);
  assert.equal(delegateFingerprint(a), delegateFingerprint(b));
  assert.notEqual(delegateFingerprint(a), delegateFingerprint(acct([['aa', 'antibody:agent'], ['bb', 'antibody:user']])));
  assert.notEqual(delegateFingerprint(a), delegateFingerprint(acct([['aa', 'antibody:user'], ['bb', 'antibody:agent']], '0xb')));
  const cc = new CrossCheckedChain(reader(() => a), reader(() => b), { label: 'second', retryMs: 1 });
  assert.equal(await cc.getAccount('0x1'), a);
  assert.equal(cc.status().agreed, true);
});

test('a persistent disagreement throws after one retry; a transient one (a checkpoint straddled) passes', async () => {
  const honest = acct([['aa', 'antibody:user']]);
  const forged = acct([['aa', 'antibody:user'], ['ff', 'antibody:user']]);
  const liar = new CrossCheckedChain(reader(() => honest), reader(() => forged), { label: 'second', retryMs: 1 });
  await assert.rejects(liar.getAccount('0x1'), (e: unknown) => e instanceof ChainDisagreement && /only on secondary: \[antibody:user=ff\]/.test(e.message));
  assert.equal(liar.status().agreed, false);
  let calls = 0;
  const lagging = new CrossCheckedChain(reader(() => honest), reader(() => (++calls === 1 ? forged : honest)), { label: 'second', retryMs: 1 });
  assert.equal(await lagging.getAccount('0x1'), honest);
});

test('system: a gateway that adds a forged user key gets every payment BLOCKed (fail closed); an honest second reader changes nothing', async () => {
  const w = await createWorld();
  worlds.push(w);
  await seedBaseline(w);
  const fixture = w.rt.chain;
  const forging = { kind: 'fixture', simulated: true, getAccount: async (id: string) => { const a = await fixture.getAccount(id); return { ...a, delegateKeys: [...a.delegateKeys, { ...a.delegateKeys[0]!, publicKeyHex: 'ff'.repeat(32), label: 'antibody:user' }] }; } } as unknown as ChainReader;
  const control = (second: ChainReader) => buildControl({ ...w.rt, chain: new CrossCheckedChain(fixture, second, { label: 'second', retryMs: 1 }) }, { signer: null, noCache: true, cacheDirOverride: mkdtempSync(join(tmpdir(), 'ab-cc-')) });
  const rent = { turn: 't', readSet: [], proposal: { recipient: CAST.landlord, amount: '450', payeeLabel: 'landlord', reason: 'rent' }, execute: false };

  const ok = await control(fixture).propose(rent);
  assert.equal(ok.verdict.decision, 'ALLOW');

  const blocked = await control(forging).propose(rent);
  assert.equal(blocked.verdict.decision, 'BLOCK');
  assert.equal(blocked.verdict.code, 'CHAIN_UNAVAILABLE');
  assert.match(blocked.verdict.reasons[0]!, /disagree on the delegate set/);
  assert.equal(blocked.executed, false);
});
