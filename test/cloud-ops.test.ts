// Hosted sandbox operations: sessions survive a restart, metrics, idle cleanup, global caps.
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { startCloud } from '../src/web/cloud.ts';

async function boot(dataDir: string, extra: Parameters<typeof startCloud>[0] extends infer O ? Partial<O> : never = {}) {
  const c = await startCloud({ dataDir, port: 0, host: '127.0.0.1', ...extra });
  const base = `http://127.0.0.1:${(c.server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown, cookie = '') => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-antibody-ui': '1', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const signIn = async (kp: Ed25519Keypair) => {
    const ch = await (await post('/api/auth/challenge', { address: kp.toSuiAddress() })).json();
    const sig = (await kp.signPersonalMessage(new TextEncoder().encode(ch.message))).signature;
    const r = await post('/api/auth/wallet', { address: kp.toSuiAddress(), message: ch.message, signature: sig });
    return { status: r.status, cookie: r.headers.get('set-cookie')?.split(';')[0] ?? '', body: await r.json() };
  };
  const stop = () => (c.server.closeAllConnections(), c.server.close(), c.tenants.close(), c.auth.flush());
  return { ...c, base, post, signIn, stop };
}

test('a restart keeps visitors signed in; the session file holds only hashes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-cloudops-'));
  try {
    const kp = Ed25519Keypair.generate();
    const a = await boot(dir);
    const { cookie } = await a.signIn(kp);
    a.stop();
    const file = readFileSync(join(dir, 'sessions.json'), 'utf8');
    assert.ok(!file.includes(cookie.split('=')[1]!), 'raw session id is never written');
    const b = await boot(dir);
    try {
      const st = await (await fetch(`${b.base}/api/auth/status`, { headers: { cookie } })).json();
      assert.equal(st.authenticated, true);
      assert.equal(st.address, kp.toSuiAddress());
      assert.equal((await fetch(`${b.base}/api/state`, { headers: { cookie } })).status, 200);
    } finally {
      b.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metrics: counts only, optional bearer token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-cloudops-'));
  const c = await boot(dir, { metricsToken: 'm-tok' });
  try {
    const { cookie } = await c.signIn(Ed25519Keypair.generate());
    assert.equal((await c.post('/api/sandbox/attack', {}, cookie)).status, 200);
    assert.equal((await fetch(`${c.base}/metrics`)).status, 401);
    const text = await (await fetch(`${c.base}/metrics`, { headers: { authorization: 'Bearer m-tok' } })).text();
    assert.match(text, /^antibody_sandbox_sign_ins_total 1$/m);
    assert.match(text, /^antibody_sandbox_attacks_total 1$/m);
    assert.match(text, /^antibody_sandbox_worlds_created_total 1$/m);
    assert.match(text, /^antibody_sandbox_worlds 1$/m);
    assert.match(text, /antibody_sandbox_requests_total\{route="\/api\/sandbox\/attack",status="200"\} 1/);
    assert.ok(!/0x[0-9a-f]{64}/.test(text), 'no addresses in metrics');
  } finally {
    c.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('idle worlds are swept; open ones are kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-cloudops-'));
  const c = await boot(dir, { idleDays: 1, maxOpen: 1 });
  try {
    await c.signIn(Ed25519Keypair.generate());
    await c.signIn(Ed25519Keypair.generate()); // evicts the first from memory (maxOpen 1); its files stay
    const tdir = join(dir, 'tenants');
    assert.equal(readdirSync(tdir).length, 2);
    const old = (Date.now() - 3 * 86_400_000) / 1000;
    for (const n of readdirSync(tdir)) for (const f of ['last-seen', 'antibody.json']) if (existsSync(join(tdir, n, f))) utimesSync(join(tdir, n, f), old, old);
    assert.equal(c.tenants.sweep(), 1, 'only the closed world goes');
    assert.equal(readdirSync(tdir).length, 1);
  } finally {
    c.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('global caps: new worlds per hour, and actions per minute across everyone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-cloudops-'));
  const c = await boot(dir, { newTenantsPerHour: 1, globalRatePerMinute: 2 });
  try {
    const first = await c.signIn(Ed25519Keypair.generate());
    assert.equal(first.status, 200);
    const second = await c.signIn(Ed25519Keypair.generate());
    assert.equal(second.status, 503);
    assert.match(second.body.error, /busy creating worlds/);
    assert.equal((await c.post('/api/sandbox/attack', {}, first.cookie)).status, 200);
    assert.equal((await c.post('/api/sandbox/attack', {}, first.cookie)).status, 200);
    const third = await c.post('/api/sandbox/attack', {}, first.cookie);
    assert.equal(third.status, 503);
  } finally {
    c.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
