import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createPublicClient, http, keccak256, toBytes } from 'viem';
import { baseSepolia } from 'viem/chains';
import { CHAINS, DEMO, GUARD_REACTIVE, GuardApi, GuardApiError, GuardMemory, GuardRefusal, GuardVault, contentHash, guardedAgent, label, unlabel } from '../src/index.ts';

// ---- pure helpers ---------------------------------------------------------------------------------

test('labels round-trip and are limited to 32 bytes', () => {
  assert.equal(unlabel(label('alice')), 'alice');
  assert.equal(label('alice').length, 66);
  assert.throws(() => label('x'.repeat(33)), /32 bytes/);
});

test('contentHash is keccak256 of the UTF-8 text, as GuardMemory stores it', () => {
  assert.equal(contentHash('hello'), keccak256(toBytes('hello')));
  assert.equal(contentHash(new TextEncoder().encode('hello')), keccak256(toBytes('hello')));
});

test('constants point at the live deployment', () => {
  assert.equal(CHAINS.baseSepolia.chainId, 84532);
  assert.match(GUARD_REACTIVE, /^0x[0-9a-f]{40}$/);
  assert.match(DEMO.memory.baseSepolia, /^0x[0-9a-f]{40}$/);
});

// ---- the API client, against a local stand-in ------------------------------------------------------

async function withServer(handler: (url: string, body: string) => [number, unknown], fn: (base: string) => Promise<void>) {
  const srv = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const [status, json] = handler(`${req.method} ${req.url}`, body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as { port: number };
  try { await fn(`http://127.0.0.1:${port}`); } finally { srv.close(); }
}

test('GuardApi calls the v1 routes and returns their JSON', async () => {
  const seen: string[] = [];
  await withServer((url, body) => {
    seen.push(url + (body ? ` ${body}` : ''));
    if (url.startsWith('GET /api/v1/check/')) return [200, { address: '0xbad', knownAttacker: true, verdict: 'block', advice: 'no' }];
    if (url === 'POST /api/v1/score') return [200, { verdict: { suspicious: true, score: 95, reason: 'x', addresses: [] }, reported: [], skipped: [], reportingPaused: false }];
    if (url.startsWith('GET /api/v1/memories/baseSepolia/0xm/entries/2')) return [200, { id: 2, usable: false, status: 'quarantined-source' }];
    return [404, { error: 'not found', status: 404 }];
  }, async (base) => {
    const api = new GuardApi({ baseUrl: `${base}/` });
    assert.equal((await api.check('0xbad')).knownAttacker, true);
    assert.equal((await api.score({ body: 'pay me' })).verdict.score, 95);
    assert.equal((await api.recall('baseSepolia', '0xm', 2)).status, 'quarantined-source');
    await assert.rejects(api.attackers(), (e: unknown) => e instanceof GuardApiError && e.status === 404 && e.message === 'not found');
  });
  assert.deepEqual(seen.slice(0, 2), ['GET /api/v1/check/0xbad', 'POST /api/v1/score {"body":"pay me"}']);
});

test('guardedAgent refuses to pay a known attacker', async () => {
  await withServer((url) => [200, { address: '0xbad', knownAttacker: url.includes('bad'), verdict: 'block', advice: 'blocked' }], async (base) => {
    const g = guardedAgent(new GuardApi({ baseUrl: base }));
    await assert.rejects(g.beforePaying('0x00000000000000000000000000000000000000ba' as any).then(() => g.beforePaying('0xbad' as any)), GuardRefusal);
    assert.equal((await g.beforePaying('0x0000000000000000000000000000000000000001')).knownAttacker, false);
  });
});

test('writes need a wallet', async () => {
  const pub = createPublicClient({ chain: baseSepolia, transport: http('http://127.0.0.1:1') });
  const v = new GuardVault('0x0000000000000000000000000000000000000001', { publicClient: pub as any });
  await assert.rejects(v.freeze(), /walletClient/);
  const m = new GuardMemory('0x0000000000000000000000000000000000000001', { publicClient: pub as any });
  await assert.rejects(m.remember('x', '0x0000000000000000000000000000000000000002'), /walletClient/);
});

// ---- live: the deployed contracts and the public API (LIVE=1) ----------------------------------------

const live = process.env.LIVE === '1';

test('live: the demo memory remembers where each entry came from', { skip: !live }, async () => {
  const pub = createPublicClient({ chain: baseSepolia, transport: http(CHAINS.baseSepolia.rpc) });
  const mem = new GuardMemory(DEMO.memory.baseSepolia, { publicClient: pub as any });
  const s = await mem.status();
  assert.equal(s.guarded, true, 'its guardian is GuardReactive');
  const good = await mem.recall(1);
  assert.equal(good.usable, true);
  const planted = await mem.recall(2);
  assert.equal(planted.usable, false, 'planted by an attacker caught on a wallet');
  assert.equal(planted.status, 'quarantined-source');
  assert.deepEqual(await mem.usableMany([1, 2, 999]), [true, false, false]);
  assert.ok(await mem.matches(1, 'Alice (0x…a11ce) invoices on the 1st, 0.0001 ETH'));
});

test('live: the vault refuses an attacker in a dry run', { skip: !live }, async () => {
  const pub = createPublicClient({ chain: baseSepolia, transport: http(CHAINS.baseSepolia.rpc) });
  const v = new GuardVault(DEMO.vaults.baseSepolia, { publicClient: pub as any });
  assert.equal(await v.check('0x00000000000000000000000000000000bad3e301', '0.0001', 'alice'), 'Quarantined');
  assert.equal((await v.status()).guarded, true);
});

test('live: the API knows the attackers', { skip: !live }, async () => {
  const api = new GuardApi({ baseUrl: process.env.GUARD_API });
  const c = await api.check('0x00000000000000000000000000000000bad3e301');
  assert.equal(c.knownAttacker, true);
  assert.equal((await api.check('0x0000000000000000000000000000000000000001')).knownAttacker, false);
  const s = await api.status();
  assert.ok(s.counts.lessons >= 9 && s.counts.memories >= 1);
  const r = await api.recall('baseSepolia', DEMO.memory.baseSepolia, 2);
  assert.equal(r.usable, false);
});
