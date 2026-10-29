// Console sign-in: wallet challenge/response against the account owner,
// the operator link, sessions, throttling, and the HTTP gate in front of /api.
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Auth, AuthError, SESSION_COOKIE } from '../src/web/auth.ts';
import { startWeb, tokenPath } from '../src/web/server.ts';
import type { Control } from '../src/control/control.ts';
import type { Runtime } from '../src/runtime.ts';

const owner = Ed25519Keypair.generate();
const stranger = Ed25519Keypair.generate();
const ORIGIN = 'http://127.0.0.1:7402';

async function signed(kp: Ed25519Keypair, auth: Auth, address = kp.toSuiAddress()) {
  const { message } = auth.challenge(address, ORIGIN);
  const { signature } = await kp.signPersonalMessage(new TextEncoder().encode(message));
  return { message, signature, address };
}

const rejects = async (p: Promise<unknown>, status: number, re?: RegExp) =>
  assert.rejects(p, (e: unknown) => e instanceof AuthError && e.status === status && (!re || re.test(e.message)));

test('the owner wallet signs in; the session cookie resolves', async () => {
  const auth = new Auth(async () => owner.toSuiAddress());
  const { message, signature, address } = await signed(owner, auth);
  assert.match(message, /wants you to sign in to the Antibody console/);
  assert.match(message, new RegExp(address));
  const s = await auth.signInWithWallet(address, message, signature);
  assert.equal(s.method, 'wallet');
  assert.equal(s.address, address);
  const cookie = Auth.setCookie(s);
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.equal(auth.fromCookie(`x=1; ${SESSION_COOKIE}=${s.id}`)?.id, s.id);
  auth.end(s.id);
  assert.equal(auth.fromCookie(`${SESSION_COOKIE}=${s.id}`), null);
});

test('a valid signature from a wallet that is not the owner is refused', async () => {
  const auth = new Auth(async () => owner.toSuiAddress());
  const { message, signature, address } = await signed(stranger, auth);
  await rejects(auth.signInWithWallet(address, message, signature), 403, /not the account owner/);
});

test('challenges are single use, bound to the address, and must verify', async () => {
  const auth = new Auth(async () => owner.toSuiAddress());
  const a = await signed(owner, auth);
  await auth.signInWithWallet(a.address, a.message, a.signature);
  await rejects(auth.signInWithWallet(a.address, a.message, a.signature), 401, /expired or unknown/);

  // The stranger signs a challenge issued to the owner's address.
  const { message } = auth.challenge(owner.toSuiAddress(), ORIGIN);
  const forged = await stranger.signPersonalMessage(new TextEncoder().encode(message));
  await rejects(auth.signInWithWallet(owner.toSuiAddress(), message, forged.signature), 401, /does not verify/);

  // A message the server never issued.
  const made = 'sign in please';
  const sig = await owner.signPersonalMessage(new TextEncoder().encode(made));
  await rejects(auth.signInWithWallet(owner.toSuiAddress(), made, sig.signature), 401);

  assert.throws(() => auth.challenge('not-an-address', ORIGIN), /not a Sui address/);
});

test('challenges and sessions expire', async () => {
  let t = 1_000_000;
  const auth = new Auth(async () => owner.toSuiAddress(), { now: () => t });
  const a = await signed(owner, auth);
  t += 6 * 60_000;
  await rejects(auth.signInWithWallet(a.address, a.message, a.signature), 401, /expired/);
  const b = await signed(owner, auth);
  const s = await auth.signInWithWallet(b.address, b.message, b.signature);
  t += 13 * 60 * 60_000;
  assert.equal(auth.fromCookie(`${SESSION_COOKIE}=${s.id}`), null);
});

test('operator link: right token in, wrong token out, repeated failures throttled', () => {
  const auth = new Auth(async () => owner.toSuiAddress(), { operatorToken: 'correct-horse' });
  assert.equal(auth.signInWithOperatorToken('correct-horse').method, 'operator');
  for (let i = 0; i < 10; i++) assert.throws(() => auth.signInWithOperatorToken('nope'), /invalid/);
  assert.throws(() => auth.signInWithOperatorToken('correct-horse'), (e: unknown) => e instanceof AuthError && e.status === 429);
});

test('HTTP: /api is gated, sign-in sets a cookie that opens it, moved pages redirect', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ab-web-'));
  const rt = { cfg: { home } } as unknown as Runtime;
  const control = {} as Control; // never reached: every data route is behind the gate here
  const auth = new Auth(async () => owner.toSuiAddress(), { operatorToken: 'tok-123' });
  const { server } = await startWeb(rt, control, 0, auth);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-antibody-ui': '1', ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal(readFileSync(tokenPath(rt), 'utf8'), 'tok-123');
    if (process.platform !== 'win32') assert.equal(statSync(tokenPath(rt)).mode & 0o777, 0o600);

    const st = await (await fetch(`${base}/api/auth/status`)).json();
    assert.deepEqual([st.node, st.authenticated], [true, false]);
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await post('/api/quarantine', { type: 'source', value: '0x1' })).status, 401);
    assert.equal((await fetch(`${base}/api/auth/operator`, { method: 'POST', body: '{"token":"tok-123"}' })).status, 403, 'header required');
    assert.equal((await post('/api/auth/operator', { token: 'wrong' })).status, 401);

    const ok = await post('/api/auth/operator', { token: 'tok-123' });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie')!.split(';')[0]!;
    const st2 = await (await fetch(`${base}/api/auth/status`, { headers: { cookie } })).json();
    assert.deepEqual([st2.authenticated, st2.method], [true, 'operator']);

    // Wallet path over HTTP.
    const ch = await (await post('/api/auth/challenge', { address: owner.toSuiAddress() })).json();
    assert.match(ch.message, new RegExp(`URI: http://127.0.0.1:${port}`));
    const { signature } = await owner.signPersonalMessage(new TextEncoder().encode(ch.message));
    const w = await post('/api/auth/wallet', { address: owner.toSuiAddress(), message: ch.message, signature });
    assert.equal(w.status, 200);
    assert.equal((await w.json()).address, owner.toSuiAddress());

    const out = await post('/api/auth/logout', {}, { cookie });
    assert.match(out.headers.get('set-cookie')!, /Max-Age=0/);
    assert.equal((await (await fetch(`${base}/api/auth/status`, { headers: { cookie } })).json()).authenticated, false);

    const app = await fetch(`${base}/app/memory?step=3`);
    assert.equal(app.status, 200);
    assert.match(await app.text(), /<div id="app"/);
    const moved = await fetch(`${base}/graph?step=2`, { redirect: 'manual' });
    assert.equal(moved.status, 301);
    assert.equal(moved.headers.get('location'), '/app/memory?step=2');
    assert.equal((await fetch(`${base}/login`)).status, 200);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('only zkLogin signatures are sent to the chain for verification', async () => {
  const { isZkLogin } = await import('../src/web/auth.ts');
  const { signature } = await owner.signPersonalMessage(new TextEncoder().encode('x'));
  assert.equal(isZkLogin(signature), false);
  assert.equal(isZkLogin('not-a-signature'), false);
});

test('static files stay inside web/ with POSIX and Windows paths alike', async () => {
  const { isInside } = await import('../src/web/server.ts');
  const { posix, win32 } = await import('node:path');
  assert.equal(isInside('/srv/app/web', '/srv/app/web/login.html', posix), true);
  assert.equal(isInside('/srv/app/web', '/srv/app/web-evil/x.html', posix), false);
  assert.equal(isInside('/srv/app/web', '/srv/app/secret.key', posix), false);
  const root = 'C:\\Users\\LINO ALEMZ\\AppData\\Local\\Antibody\\app\\web';
  assert.equal(isInside(root, win32.resolve(root, './login.html'), win32), true, 'Windows backslash paths are served');
  assert.equal(isInside(root, win32.resolve(root, './assets/css/brand.css'), win32), true);
  assert.equal(isInside(root, win32.resolve(root, './../keys/x.key'), win32), false, 'and still cannot escape web\\');
  assert.equal(isInside(root, 'D:\\other\\login.html', win32), false);
});
