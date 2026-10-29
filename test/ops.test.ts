// Operability: retries and health, alerts, state versioning, encrypted keys,
// service files and the doctor.
import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Health, isTransient, resilient, withRetry } from '../src/ops/resilience.ts';
import { Alerter } from '../src/ops/alerts.ts';
import { ensureState, readStateVersion, STATE_VERSION, StateVersionError } from '../src/ops/state.ts';
import { servicePlan } from '../src/ops/service.ts';
import { doctorExitCode, runDoctor } from '../src/ops/doctor.ts';
import { decryptKeyText, encryptKeysInPlace, encryptKeyText, isEncryptedKeyText, keyPath, loadLaneKey, readKeyText } from '../src/keystore.ts';
import { loadConfig } from '../src/config.ts';
import { createWorld, POISON_COIN, seedBaseline } from '../src/dev/world.ts';

const noSleep = { sleep: async () => {}, random: () => 0 };
const connErr = () => Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

test('withRetry retries transient failures, then gives up; never retries a definite error', async () => {
  let n = 0;
  assert.equal(await withRetry(async () => (++n < 3 ? Promise.reject(new Error('503 Service Unavailable')) : 'ok'), noSleep), 'ok');
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(withRetry(async () => (++n, Promise.reject(new Error('503'))), { ...noSleep, retries: 2 }), /503/);
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(withRetry(async () => (++n, Promise.reject(new Error('object not found'))), noSleep), /not found/);
  assert.equal(n, 1);
  assert.equal(isTransient(connErr()), true);
  assert.equal(isTransient(Object.assign(new Error('x'), { status: 429 })), true);
  assert.equal(isTransient(new Error('invalid signature')), false);
});

test('resilient(): reads retry on overload, writes only on connect failures; health tracks the outcome', async () => {
  const health = new Health();
  let reads = 0;
  let writes = 0;
  const target = {
    kind: 'x',
    async read() {
      if (++reads < 2) throw new Error('UNAVAILABLE: overloaded');
      return 1;
    },
    async write() {
      ++writes;
      throw new Error('503 after the server may have applied it');
    },
  };
  const r = resilient(target, 'chain', { ...noSleep, writes: ['write'], health });
  assert.equal(r.kind, 'x');
  assert.equal(await r.read(), 1);
  assert.equal(health.get('chain').ok, true);
  await assert.rejects(r.write(), /503/);
  assert.equal(writes, 1, 'a write that reached the server is not repeated');
  const snap = health.snapshot();
  assert.equal(snap.degraded, true);
  assert.equal(snap.deps.chain?.failures, 1);
  assert.match(snap.deps.chain?.lastError ?? '', /503/);
});

test('alerts: webhook and Telegram get the alert once per window; a dead channel never throws', async () => {
  const got: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    got.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response('{}', { status: String(url).includes('dead') ? 500 : 200 });
  }) as typeof fetch;
  const a = new Alerter({ webhook: 'https://hooks.example/x', telegram: { token: 'T0K', chatId: '42' } }, { fetchImpl, simulated: true });
  const alert = { kind: 'auto-quarantine' as const, severity: 'critical' as const, key: 'q:3', title: 'auto-quarantined source 0xbad', text: 'why' };
  assert.deepEqual(await a.send(alert), ['webhook', 'telegram']);
  assert.deepEqual(await a.send(alert), [], 'deduplicated');
  assert.equal(got[0]!.body.kind, 'auto-quarantine');
  assert.match(String(got[0]!.body.title), /^\[SIMULATED\]/);
  assert.match(got[1]!.url, /api\.telegram\.org\/botT0K\/sendMessage/);
  assert.equal(got[1]!.body.chat_id, '42');
  const dead = new Alerter({ webhook: 'https://dead.example/x', telegram: null }, { fetchImpl });
  assert.deepEqual(await dead.send({ ...alert, key: 'other' }), []);
  assert.equal(new Alerter({ webhook: null, telegram: null }).enabled, false);
});

test('control sends an alert when the sentinel auto-quarantines a repeat attack', async () => {
  const hits: Record<string, unknown>[] = [];
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c)).on('end', () => (hits.push(JSON.parse(b)), res.end('ok')));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  process.env.ANTIBODY_ALERT_WEBHOOK = `http://127.0.0.1:${(srv.address() as { port: number }).port}/hook`;
  const w = await createWorld();
  try {
    await seedBaseline(w);
    const first = w.airdrop(POISON_COIN);
    await w.scan();
    await w.quarantine({ type: 'source', value: first.objectId });
    w.airdrop({ ...POISON_COIN, type: POISON_COIN.type.replace('usdc_rewards', 'usdc_rewards2') });
    await w.scan();
    for (let i = 0; i < 50 && !hits.some((h) => h.kind === 'auto-quarantine'); i++) await new Promise((r) => setTimeout(r, 20));
    const kinds = hits.map((h) => h.kind);
    assert.ok(kinds.includes('incident'), `incident alert (got ${kinds.join(',')})`);
    assert.ok(kinds.includes('quarantine'));
    assert.ok(kinds.includes('auto-quarantine'));
    assert.equal(hits[0]!.simulated, true);
  } finally {
    delete process.env.ANTIBODY_ALERT_WEBHOOK;
    w.dispose();
    srv.close();
  }
});

test('state version: an old home migrates (with a backup), a newer one is refused', () => {
  const home = mkdtempSync(join(tmpdir(), 'ab-state-'));
  assert.deepEqual(ensureState(home), { from: null, to: null }, 'not set up: nothing to do');
  writeFileSync(join(home, 'antibody.json'), JSON.stringify({ accountId: '0x1', stewardWallet: '0x2' }));
  assert.equal(readStateVersion(home), 0);
  assert.deepEqual(ensureState(home), { from: 0, to: STATE_VERSION });
  assert.equal(readStateVersion(home), STATE_VERSION);
  assert.equal(JSON.parse(readFileSync(join(home, 'antibody.json'), 'utf8')).accountId, '0x1', 'other fields kept');
  assert.ok(existsSync(join(home, 'antibody.json.v0.bak')));
  writeFileSync(join(home, 'antibody.json'), JSON.stringify({ stateVersion: STATE_VERSION + 1 }));
  assert.throws(() => ensureState(home), (e: unknown) => e instanceof StateVersionError && /newer Antibody/.test((e as Error).message));
});

test('key files: encrypted at rest with a passphrase, unreadable without it, converted in place', async () => {
  const fast = { logN: 10, r: 8, p: 1 };
  const t = encryptKeyText('deadbeef', 'correct horse battery', fast);
  assert.ok(isEncryptedKeyText(t));
  assert.ok(!t.includes('deadbeef'));
  assert.equal(decryptKeyText(t, 'correct horse battery'), 'deadbeef');
  assert.throws(() => decryptKeyText(t, 'wrong'), /wrong key passphrase/);
  assert.throws(() => decryptKeyText(t.slice(0, -4) + 'AAAA', 'correct horse battery'), /wrong key passphrase|altered/);

  const w = await createWorld();
  try {
    const before = w.readKey('control');
    const done = encryptKeysInPlace(w.cfg.home, 'a long enough passphrase');
    assert.equal(done.length, 5);
    const p = keyPath(w.cfg.home, 'control');
    assert.ok(isEncryptedKeyText(readFileSync(p, 'utf8')));
    if (process.platform !== 'win32') assert.equal((await import('node:fs')).statSync(p).mode & 0o777, 0o600);
    assert.throws(() => readKeyText(p, {}), /is encrypted: set ANTIBODY_KEY_PASSPHRASE/);
    assert.equal(readKeyText(p, { ANTIBODY_KEY_PASSPHRASE: 'a long enough passphrase' }), before);
    process.env.ANTIBODY_KEY_PASSPHRASE = 'a long enough passphrase';
    try {
      assert.equal(loadLaneKey(w.cfg, 'control').seedHex, before);
    } finally {
      delete process.env.ANTIBODY_KEY_PASSPHRASE;
    }
    assert.deepEqual(encryptKeysInPlace(w.cfg.home, 'a long enough passphrase'), [], 'idempotent');
  } finally {
    w.dispose();
  }
});

test('service files: systemd unit, launchd plist and Windows launcher run the supervisor', () => {
  const base = { node: '/opt/node 22/bin/node', entry: '/home/ada/.antibody-app/bin/antibody.mjs', home: '/home/ada/.antibody', homeDir: '/home/ada', user: 'ada', uid: 501 };
  const l = servicePlan({ ...base, platform: 'linux' });
  assert.equal(l.file!.path, '/home/ada/.config/systemd/user/antibody.service');
  assert.match(l.file!.content, /ExecStart="\/opt\/node 22\/bin\/node" "\/home\/ada\/\.antibody-app\/bin\/antibody\.mjs" up --foreground/);
  assert.match(l.file!.content, /Restart=on-failure/);
  const m = servicePlan({ ...base, platform: 'darwin' });
  assert.match(m.file!.path, /LaunchAgents\/xyz\.antibody\.daemon\.plist$/);
  assert.match(m.file!.content, /<string>--foreground<\/string>/);
  assert.deepEqual(m.install[0], ['launchctl', 'bootstrap', 'gui/501', m.file!.path]);
  const wplan = servicePlan({ platform: 'win32', node: 'C:\\Program Files\\nodejs\\node.exe', entry: 'C:\\Users\\LINO ALEMZ\\AppData\\Local\\Antibody\\app\\bin\\antibody.mjs', home: 'C:\\Users\\LINO ALEMZ\\.antibody', localAppData: 'C:\\Users\\LINO ALEMZ\\AppData\\Local', homeDir: 'C:\\Users\\LINO ALEMZ' });
  assert.match(wplan.file!.content, /sh\.Run """C:\\Program Files\\nodejs\\node\.exe"" ""C:\\Users\\LINO ALEMZ\\AppData\\Local\\Antibody\\app\\bin\\antibody\.mjs"" up --foreground", 0, False/);
  const tr = wplan.install[0]![wplan.install[0]!.indexOf('/TR') + 1]!;
  assert.ok(tr.length <= 261, 'schtasks /TR limit');
  assert.throws(() => servicePlan({ ...base, platform: 'aix' }), /no service manager/);
});

test('doctor: a fresh offline install passes with warnings; a world-readable key fails with a fix', async () => {
  const w = await createWorld();
  try {
    const cfg = loadConfig({ ...process.env, ANTIBODY_HOME: w.cfg.home, ANTIBODY_BACKEND: 'offline', ANTIBODY_KEY_ISOLATION: 'simulated' });
    const checks = await runDoctor(cfg, { ledger: async () => ({ ok: true, head: 0 }) });
    assert.equal(doctorExitCode(checks), 0, JSON.stringify(checks.filter((c) => c.status === 'fail')));
    assert.equal(checks.find((c) => c.name === 'Backend')?.status, 'warn');
    assert.equal(checks.find((c) => c.name === 'Ledger')?.detail, 'verified, head #0');
    if (process.platform !== 'win32') {
      chmodSync(keyPath(w.cfg.home, 'agent'), 0o644);
      const bad = await runDoctor(cfg);
      const k = bad.find((c) => c.name === 'Key: agent')!;
      assert.equal(k.status, 'fail');
      assert.match(k.fix ?? '', /chmod 600/);
      assert.equal(doctorExitCode(bad), 1);
    }
    const old = await runDoctor(cfg, { nodeVersion: '20.11.0' });
    assert.equal(old.find((c) => c.name === 'Node.js')?.status, 'fail');
  } finally {
    w.dispose();
  }
});
