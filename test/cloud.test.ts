// The hosted sandbox: any wallet signs in and gets its own simulated Antibody,
// owned by that wallet, isolated from every other visitor's.
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { startCloud } from '../src/web/cloud.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'ab-cloud-'));
let base = '';
let close = () => {};
before(async () => {
  const c = await startCloud({ dataDir, port: 0, host: '127.0.0.1', maxTenants: 3 });
  base = `http://127.0.0.1:${(c.server.address() as { port: number }).port}`;
  close = () => (c.server.closeAllConnections(), c.server.close(), c.tenants.close());
});
after(() => (close(), rmSync(dataDir, { recursive: true, force: true })));

const post = (path: string, body: unknown, cookie = '') => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-antibody-ui': '1', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const get = (path: string, cookie = '') => fetch(base + path, { headers: cookie ? { cookie } : {} });
const sign = async (kp: Ed25519Keypair, m: string) => (await kp.signPersonalMessage(new TextEncoder().encode(m))).signature;

async function signIn(kp: Ed25519Keypair): Promise<string> {
  const ch = await (await post('/api/auth/challenge', { address: kp.toSuiAddress() })).json();
  assert.match(ch.message, /your own Antibody sandbox/);
  const r = await post('/api/auth/wallet', { address: kp.toSuiAddress(), message: ch.message, signature: await sign(kp, ch.message) });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie')!.split(';')[0]!;
}

const alice = Ed25519Keypair.generate();
const bob = Ed25519Keypair.generate();
let ca = '';
let cb = '';

test('any wallet signs in and owns its own seeded world; nothing without a session', async () => {
  const st = await (await get('/api/auth/status')).json();
  assert.deepEqual([st.node, st.mode, st.authenticated], [true, 'sandbox', false]);
  assert.equal((await get('/api/state')).status, 401);
  ca = await signIn(alice);
  cb = await signIn(bob);
  const a = await (await get('/api/state', ca)).json();
  assert.equal(a.sandbox, true);
  assert.equal(a.account.owner, alice.toSuiAddress(), 'the visitor is the account owner');
  assert.deepEqual(a.ledger.payees.map((p: { label: string }) => p.label).sort(), ['landlord', 'sister', 'utility']);
  assert.equal(a.simulated, true);
  const b = await (await get('/api/state', cb)).json();
  assert.equal(b.account.owner, bob.toSuiAddress());
  assert.notEqual(a.account.id, b.account.id);
});

test('worlds are isolated: a payee Alice adds is not in Bob’s ledger; bad input is refused', async () => {
  const ok = await post('/api/sandbox/payee', { label: 'gym', address: '0x' + 'ab'.repeat(32), cap: '40' }, ca);
  assert.equal(ok.status, 200);
  assert.equal((await post('/api/sandbox/payee', { label: 'x', address: '0xnope', cap: '1' }, ca)).status, 400);
  assert.equal((await post('/api/sandbox/payee', { label: 'x', address: '0x' + 'ab'.repeat(32), cap: '-1' }, ca)).status, 400);
  const a = await (await get('/api/state', ca)).json();
  const b = await (await get('/api/state', cb)).json();
  assert.ok(a.ledger.payees.some((p: { label: string }) => p.label === 'gym'));
  assert.ok(!b.ledger.payees.some((p: { label: string }) => p.label === 'gym'));
});

test('the attack lands, the sentinel flags it, Steward is fooled and blocked, quarantine and rebuild work', async () => {
  const atk = await (await post('/api/sandbox/attack', {}, ca)).json();
  assert.equal(atk.coin.name, 'USDC Rewards');
  assert.ok(atk.items[0].incident, 'the sentinel raised an incident');
  const run = await (await post('/api/run', { instruction: "Pay this month's rent." }, ca)).json();
  assert.equal(run.protected.decisions.at(-1).verdict.decision, 'BLOCK');
  assert.ok(run.unprotected.wouldSend, 'the unprotected agent would have paid');
  const q = await (await post('/api/quarantine', { type: 'source', value: atk.coin.objectId }, ca)).json();
  assert.ok(q.seq > 0 && q.lessonSeq !== null);
  const fresh = await (await post('/api/rebuild', {}, ca)).json();
  const live = await (await get('/api/state', ca)).json();
  assert.equal(fresh.digest, live.digest, 'a fresh rebuild reproduces the live digest');
  const again = await (await post('/api/sandbox/attack', {}, ca)).json();
  assert.equal(again.items[0].incident.status, 'auto-quarantined', 'the lesson catches the repeat');
});

test('revoking a lane needs the owner wallet’s signature; another visitor cannot use it', async () => {
  const p = await (await post('/api/revoke/prepare', { lane: 'wallet-objects' }, ca)).json();
  assert.equal(p.mode, 'message');
  assert.equal(p.owner, alice.toSuiAddress());
  assert.equal((await post('/api/revoke/submit', { id: p.id, signature: await sign(alice, p.message) }, cb)).status, 410, 'Bob’s world never issued that request');
  const p2 = await (await post('/api/revoke/prepare', { lane: 'wallet-objects' }, ca)).json();
  assert.equal((await post('/api/revoke/submit', { id: p2.id, signature: await sign(bob, p2.message) }, ca)).status, 403, 'Bob’s signature is not the owner’s');
  const p3 = await (await post('/api/revoke/prepare', { lane: 'wallet-objects' }, ca)).json();
  const r = await (await post('/api/revoke/submit', { id: p3.id, signature: await sign(alice, p3.message) }, ca)).json();
  assert.equal(r.lane, 'wallet-objects');
  const s = await (await get('/api/state', ca)).json();
  assert.equal(s.lanes.find((l: { lane: string }) => l.lane === 'wallet-objects').status, 'revoked');
});

test('reset gives a fresh world; capacity is enforced for new wallets', async () => {
  assert.equal((await post('/api/sandbox/reset', {}, ca)).status, 200);
  const a = await (await get('/api/state', ca)).json();
  assert.ok(!a.ledger.payees.some((p: { label: string }) => p.label === 'gym'));
  await signIn(Ed25519Keypair.generate()); // third world: at the cap
  const fourth = Ed25519Keypair.generate();
  const ch = await (await post('/api/auth/challenge', { address: fourth.toSuiAddress() })).json();
  const r = await post('/api/auth/wallet', { address: fourth.toSuiAddress(), message: ch.message, signature: await sign(fourth, ch.message) });
  assert.equal(r.status, 503);
});
