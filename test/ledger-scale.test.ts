// The ledger past the old 90-record MVP cap: a cold rebuild still covers every
// record through the relayer's 100-hit recall, appends keep working, and a
// missing record still fails closed.
import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LEDGER_CAP, nextAppend, verifyLedger } from '../src/core/ledger.ts';
import { NS_LEDGER } from '../src/core/types.ts';
import { OfflineRelayer } from '../src/adapters/memwal-offline.ts';
import { retrieveLedger } from '../src/control/retrieve.ts';
import { account, ACCT, genesisStep, ledgerChain, makeKeys, payeeStep } from './helpers.ts';

const k = makeKeys();
const N = 260;
const steps = [genesisStep(k), ...Array.from({ length: N - 1 }, (_, i) => payeeStep(`p${i}`))];
const chain = ledgerChain(k, steps);

async function relayerWith(n: number) {
  const relayer = new OfflineRelayer(mkdtempSync(join(tmpdir(), 'ab-scale-')), () => true);
  const c = relayer.client(k.lane.antibody.publicKeyHex);
  for (const env of chain.slice(0, n)) await c.remember(env.text, NS_LEDGER, env.header.id);
  return { relayer, c };
}

test(`a ${N}-record ledger is fully retrieved from a cold cache and verifies`, async () => {
  assert.ok(LEDGER_CAP > N);
  const { c } = await relayerWith(N);
  const led = await retrieveLedger(c);
  assert.deepEqual(led.missing, []);
  assert.ok(led.queries > 1, 'needs follow-up queries past the 100-hit recall');
  const r = verifyLedger({ acct: ACCT, account: account(k), inventory: led.inventory.map((e) => e.blobId), recalled: led.memories });
  assert.ok(r.ok, !r.ok ? r.detail : '');
  assert.equal(r.ok && r.head.seq, N - 1);
  assert.equal(r.ok && r.payees.length, N - 1);
  assert.equal(r.ok && nextAppend(r).seq, N, 'appends continue past 90');
});

test('a warm cache needs no queries at all', async () => {
  const { c } = await relayerWith(N);
  const cold = await retrieveLedger(c);
  const warm = await retrieveLedger(c, new Map(cold.memories.map((m) => [m.blobId, m])));
  assert.equal(warm.queries, 0);
  assert.deepEqual(warm.missing, []);
});

test('a large ledger with one unrecallable record still fails closed', async () => {
  const { relayer, c } = await relayerWith(N);
  const victim = (await c.inventory(NS_LEDGER))[150]!.blobId;
  relayer.tamper(victim, () => 'unrelated words only');
  const led = await retrieveLedger(c);
  const r = verifyLedger({ acct: ACCT, account: account(k), inventory: led.inventory.map((e) => e.blobId), recalled: led.memories });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.code : '', /LEDGER_(INCOMPLETE|CORRUPT)/);
});
