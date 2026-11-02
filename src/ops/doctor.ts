/**
 * `antibody doctor`: one command that checks everything an install needs and
 * says how to fix what is wrong. Read-only: it never writes state, keys or
 * ledger records. Each check is independent, so one failure never hides the
 * rest.
 */
import { existsSync, readdirSync, readFileSync, statfsSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { ipcPath, persistedPath, ROLES, runDir, type Config } from '../config.ts';
import { bindLanes } from '../core/lanes.ts';
import { isEncryptedKeyText, keyPassphrase, keyPath, readKeyText } from '../keystore.ts';
import { alertConfigFrom } from './alerts.ts';
import { readStateVersion, STATE_VERSION } from './state.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DoctorDeps {
  /** Live probes; omitted in offline mode or when the prerequisite failed. */
  chain?: { latestCheckpoint(): Promise<number>; getAccount(id: string): Promise<import('../core/lanes.ts').AccountState> };
  relayerHealth?: () => Promise<unknown>;
  ledger?: () => Promise<{ ok: true; head: number; acknowledged?: boolean } | { ok: false; code: string; detail: string }>;
  fetchImpl?: typeof fetch;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
}

const accepts = (path: string, ms = 1500) =>
  new Promise<boolean>((res) => {
    const s = connect(path);
    const t = setTimeout(() => (s.destroy(), res(false)), ms);
    s.once('connect', () => (clearTimeout(t), s.end(), res(true)));
    s.once('error', () => (clearTimeout(t), res(false)));
  });

const pidAlive = (p: string) => {
  if (!existsSync(p)) return false;
  try {
    process.kill(Number(readFileSync(p, 'utf8')), 0);
    return true;
  } catch {
    return false;
  }
};

async function timed<T>(p: Promise<T>, ms = 10_000): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`no answer in ${ms / 1000}s`)), ms)))]);
  } finally {
    clearTimeout(t);
  }
}

export async function runDoctor(cfg: Config, d: DoctorDeps = {}): Promise<Check[]> {
  const out: Check[] = [];
  const add = (c: Check) => out.push(c);
  const platform = d.platform ?? process.platform;

  // Runtime
  const major = Number((d.nodeVersion ?? process.versions.node).split('.')[0]);
  add(major >= 22 ? { name: 'Node.js', status: 'ok', detail: `v${d.nodeVersion ?? process.versions.node}` } : { name: 'Node.js', status: 'fail', detail: `v${d.nodeVersion ?? process.versions.node} is too old`, fix: platform === 'win32' ? 'winget upgrade OpenJS.NodeJS.LTS' : 'nvm install 22 (or install Node 22+ from nodejs.org)' });

  // Home and state
  if (!existsSync(cfg.home)) {
    add({ name: 'Antibody home', status: 'fail', detail: `${cfg.home} does not exist`, fix: 'antibody setup' });
    return out;
  }
  add({ name: 'Antibody home', status: 'ok', detail: cfg.home });
  try {
    const free = statfsSync(cfg.home);
    const mb = Math.floor((Number(free.bavail) * Number(free.bsize)) / 2 ** 20);
    add(mb >= 200 ? { name: 'Disk space', status: 'ok', detail: `${mb} MB free` } : { name: 'Disk space', status: mb < 20 ? 'fail' : 'warn', detail: `${mb} MB free`, fix: 'free some disk space: logs live in ' + join(cfg.home, 'logs') });
  } catch {
    add({ name: 'Disk space', status: 'skip', detail: 'not measurable here' });
  }
  const sv = readStateVersion(cfg.home);
  if (sv === null) add({ name: 'Setup', status: 'fail', detail: `no ${persistedPath(cfg.home)}`, fix: 'antibody setup' });
  else if (sv > STATE_VERSION) add({ name: 'State format', status: 'fail', detail: `version ${sv} is newer than this build (${STATE_VERSION})`, fix: 're-run the installer to update Antibody' });
  else add({ name: 'State format', status: 'ok', detail: `version ${sv}${sv < STATE_VERSION ? ` (migrates to ${STATE_VERSION} on next start)` : ''}` });
  add(cfg.accountId ? { name: 'MemWal account', status: 'ok', detail: cfg.accountId } : { name: 'MemWal account', status: 'fail', detail: 'not configured', fix: 'antibody setup (live: set MEMWAL_ACCOUNT_ID first)' });
  add(cfg.stewardWallet ? { name: 'Steward wallet', status: 'ok', detail: cfg.stewardWallet } : { name: 'Steward wallet', status: 'fail', detail: 'not configured', fix: 'antibody setup' });

  // Keys
  const pass = (() => {
    try {
      return keyPassphrase();
    } catch (e) {
      add({ name: 'Key passphrase', status: 'fail', detail: (e as Error).message, fix: 'check ANTIBODY_KEY_PASSPHRASE_FILE points at a readable file' });
      return null;
    }
  })();
  let encrypted = 0;
  // B26: under role separation this user cannot even see the other roles' key folders. That is the
  // point of the separation, so it is reported as "held by its role", not as missing.
  const look = (role: (typeof ROLES)[number]): 'missing' | 'other-role' | 'here' => {
    try {
      statSync(keyPath(cfg.home, role));
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EACCES' ? 'other-role' : 'missing';
    }
    try {
      readFileSync(keyPath(cfg.home, role));
      return 'here';
    } catch {
      return 'other-role';
    }
  };
  const where = Object.fromEntries(ROLES.map((r) => [r, look(r)])) as Record<(typeof ROLES)[number], ReturnType<typeof look>>;
  const keysDirListable = (() => {
    try {
      readdirSync(join(cfg.home, 'keys'));
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== 'EACCES';
    }
  })();
  if (ROLES.every((r) => where[r] === 'missing') && keysDirListable) add({ name: 'Keys', status: 'fail', detail: `none in ${join(cfg.home, 'keys')}`, fix: 'antibody setup' });
  else
    for (const role of ROLES) {
      const p = keyPath(cfg.home, role);
      if (where[role] === 'missing' && keysDirListable) {
        add({ name: `Key: ${role}`, status: 'fail', detail: 'missing', fix: 'antibody setup' });
        continue;
      }
      if (where[role] !== 'here') {
        add({ name: `Key: ${role}`, status: 'ok', detail: 'held by its own role (not readable by this user)' });
        continue;
      }
      const mode = statSync(p).mode & 0o777;
      if (platform !== 'win32' && (mode & 0o077) !== 0) {
        add({ name: `Key: ${role}`, status: 'fail', detail: `mode ${mode.toString(8)}: readable by others`, fix: `chmod 600 ${p}` });
        continue;
      }
      const raw = readFileSync(p, 'utf8');
      if (isEncryptedKeyText(raw)) {
        encrypted++;
        if (!pass && !keyPassphrase(process.env, role)) {
          add({ name: `Key: ${role}`, status: 'fail', detail: 'encrypted, and no passphrase is set', fix: `set ANTIBODY_KEY_PASSPHRASE_${role.toUpperCase()} (or the shared ANTIBODY_KEY_PASSPHRASE)` });
          continue;
        }
        try {
          readKeyText(p);
        } catch (e) {
          add({ name: `Key: ${role}`, status: 'fail', detail: (e as Error).message, fix: 'check the passphrase' });
          continue;
        }
      }
      add({ name: `Key: ${role}`, status: 'ok', detail: isEncryptedKeyText(raw) ? 'present, encrypted' : 'present' });
    }
  if (encrypted === 0 && where.control === 'here') {
    add({ name: 'Keys at rest', status: cfg.backend === 'live' ? 'warn' : 'ok', detail: 'plaintext (protected by file permissions only)', ...(cfg.backend === 'live' ? { fix: 'ANTIBODY_KEY_PASSPHRASE=… antibody keys encrypt' } : {}) });
  }
  const readableHere = ROLES.filter((r) => where[r] === 'here');
  add(
    readableHere.length <= 1
      ? { name: 'Key isolation', status: 'ok', detail: readableHere.length ? `this user holds only the ${readableHere[0]} key` : 'this user holds no role key' }
      : { name: 'Key isolation', status: cfg.keyIsolation === 'enforce' ? 'fail' : 'warn', detail: `this OS user can read ${readableHere.length} role keys (${cfg.keyIsolation === 'enforce' ? 'enforced: daemons will refuse to start' : 'SIMULATED isolation'})`, fix: 'give each role its own OS user: sudo scripts/setup-roles.sh' },
  );

  // Backend and network
  if (cfg.backend === 'offline') {
    add({ name: 'Backend', status: 'warn', detail: 'offline (SIMULATED: fixture chain + local relayer, nothing touches Sui or Walrus)', fix: 'for real use: ANTIBODY_BACKEND=live in ~/.antibody/antibody.env' });
  } else {
    add({ name: 'Backend', status: 'ok', detail: `live, ${cfg.network}` });
    add(cfg.tatumApiKey ? { name: 'Tatum API key', status: 'ok', detail: 'set' } : { name: 'Tatum API key', status: 'fail', detail: 'TATUM_API_KEY is not set', fix: 'get a key at dashboard.tatum.io and add TATUM_API_KEY to ~/.antibody/antibody.env' });
    if (d.chain) {
      try {
        const ck = await timed(d.chain.latestCheckpoint());
        add({ name: 'Sui RPC', status: 'ok', detail: `checkpoint ${ck} via ${cfg.chainTransport}` });
        if (cfg.accountId) {
          const acct = await timed(d.chain.getAccount(cfg.accountId));
          const b = bindLanes(acct);
          add(b.ok ? { name: 'Lane keys on-chain', status: b.issues.length ? 'warn' : 'ok', detail: b.issues.length ? b.issues.join('; ') : `${acct.delegateKeys.length} delegate keys, every lane bound once` } : { name: 'Lane keys on-chain', status: 'fail', detail: b.error, fix: 'antibody status; re-run antibody setup or rotate the lane' });
        }
      } catch (e) {
        add({ name: 'Sui RPC', status: 'fail', detail: (e as Error).message, fix: 'check TATUM_API_KEY, the network, or set ANTIBODY_CHAIN_TRANSPORT=jsonrpc' });
      }
    }
    if (d.relayerHealth) {
      try {
        await timed(d.relayerHealth());
        add({ name: 'Walrus Memory relayer', status: 'ok', detail: cfg.memwalServerUrl });
      } catch (e) {
        add({ name: 'Walrus Memory relayer', status: 'fail', detail: `${cfg.memwalServerUrl}: ${(e as Error).message}`, fix: 'check your connection; status of the relayer: memory.walrus.xyz' });
      }
    }
    add(cfg.crossCheck ? { name: 'Second-RPC cross-check', status: 'ok', detail: new URL(cfg.crossCheck.url).host } : { name: 'Second-RPC cross-check', status: 'warn', detail: 'off: one RPC is trusted for the delegate set', fix: 'set ANTIBODY_CROSSCHECK_RPC_URL to an independent Sui fullnode' });
  }
  add(await checkLlm(cfg, d.fetchImpl ?? fetch));

  // Ledger
  if (d.ledger) {
    try {
      const l = await timed(d.ledger(), 60_000);
      add(l.ok ? (l.acknowledged === false ? { name: 'Ledger', status: 'fail', detail: `verified, head #${l.head}, but first seen on this machine: payments are blocked until you confirm it`, fix: 'antibody verify-ledger --accept' } : { name: 'Ledger', status: 'ok', detail: `verified, head #${l.head}` }) : { name: 'Ledger', status: 'fail', detail: `${l.code}: ${l.detail} (every payment is blocked)`, fix: 'antibody verify-ledger; antibody restore-index' });
    } catch (e) {
      add({ name: 'Ledger', status: 'fail', detail: (e as Error).message, fix: 'antibody verify-ledger' });
    }
  }

  // Daemons
  const up: string[] = [];
  const down: string[] = [];
  for (const n of ['control', 'signer', 'agent'] as const) ((await accepts(ipcPath(cfg, n))) ? up : down).push(n);
  (pidAlive(join(runDir(cfg), 'ingest.pid')) ? up : down).push('sentinel');
  add(down.length === 0 ? { name: 'Daemons', status: 'ok', detail: up.join(', ') + ' running' } : { name: 'Daemons', status: up.length ? 'fail' : 'warn', detail: up.length ? `${down.join(', ')} not running (${up.join(', ')} up)` : 'not running', fix: up.length ? 'antibody down && antibody up; logs in ' + join(cfg.home, 'logs') : 'antibody up' });
  if (up.includes('control')) {
    try {
      const r = await (d.fetchImpl ?? fetch)(`http://127.0.0.1:${cfg.webPort}/api/auth/status`, { signal: AbortSignal.timeout(3000) });
      add(r.ok ? { name: 'Console', status: 'ok', detail: `http://127.0.0.1:${cfg.webPort}` } : { name: 'Console', status: 'fail', detail: `HTTP ${r.status}` });
    } catch (e) {
      add({ name: 'Console', status: 'fail', detail: `port ${cfg.webPort}: ${(e as Error).message}`, fix: 'another program may hold the port: set ANTIBODY_WEB_PORT' });
    }
  }

  const a = alertConfigFrom();
  add(a.webhook || a.telegram ? { name: 'Alerts', status: 'ok', detail: [a.webhook && 'webhook', a.telegram && 'Telegram'].filter(Boolean).join(' + ') } : { name: 'Alerts', status: 'warn', detail: 'off: incidents only show in the console', fix: 'set ANTIBODY_ALERT_WEBHOOK or ANTIBODY_TELEGRAM_BOT_TOKEN + ANTIBODY_TELEGRAM_CHAT_ID, then antibody alert test' });
  return out;
}

export const doctorExitCode = (checks: Check[]) => (checks.some((c) => c.status === 'fail') ? 1 : 0);

/**
 * The model endpoint answers, accepts the key and serves the configured model
 * (GET /models: one cheap call, no tokens spent).
 */
export async function checkLlm(cfg: Config, fetchImpl: typeof fetch): Promise<Check> {
  const { llm } = cfg;
  const name = 'LLM for Steward';
  const keyVar = llm.provider === 'fortytwo' ? 'LLM_API_KEY (or FORTYTWO_API_KEY)' : 'LLM_API_KEY';
  if (!llm.apiKey && llm.provider === 'fortytwo') return { name, status: 'fail', detail: 'LLM_PROVIDER=fortytwo but no API key', fix: `create a key at platform.fortytwo.network (with a spend limit) and set ${keyVar} in ~/.antibody/antibody.env` };
  if (!llm.baseUrl || !llm.apiKey || !llm.model) return { name, status: 'warn', detail: 'not set: Steward uses a scripted model (SIMULATED)', fix: 'set LLM_PROVIDER=fortytwo and LLM_API_KEY, or LLM_BASE_URL, LLM_API_KEY and LLM_MODEL' };
  const where = `${llm.model} at ${new URL(llm.baseUrl).host}`;
  try {
    const r = await fetchImpl(`${llm.baseUrl.replace(/\/+$/, '')}/models`, { headers: { authorization: `Bearer ${llm.apiKey}` }, signal: AbortSignal.timeout(10_000) });
    if (r.status === 401 || r.status === 403) return { name, status: 'fail', detail: `${where}: the key was refused (HTTP ${r.status})`, fix: `check ${keyVar}; on Fortytwo, make sure the key is active and under its spend limit` };
    if (!r.ok) return { name, status: 'warn', detail: `${where}: GET /models answered HTTP ${r.status}; chat may still work`, fix: 'run antibody llm test' };
    const ids = ((await r.json()) as { data?: { id?: string }[] }).data?.map((m) => m.id).filter((x): x is string => !!x) ?? [];
    if (ids.length && !ids.includes(llm.model)) return { name, status: 'fail', detail: `${where}: the endpoint does not serve this model`, fix: `set LLM_MODEL to one of: ${ids.slice(0, 8).join(', ')}` };
    return { name, status: 'ok', detail: `${where}${llm.reasoningEffort ? `, reasoning ${llm.reasoningEffort}` : ''}` };
  } catch (e) {
    return { name, status: 'fail', detail: `${where}: ${(e as Error).message}`, fix: 'check your connection and LLM_BASE_URL' };
  }
}
