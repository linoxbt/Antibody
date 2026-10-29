/**
 * `antibody doctor`: one command that checks everything an install needs and
 * says how to fix what is wrong. Read-only: it never writes state, keys or
 * ledger records. Each check is independent, so one failure never hides the
 * rest.
 */
import { existsSync, readFileSync, statfsSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { ipcPath, persistedPath, ROLES, runDir, type Config } from '../config.ts';
import { bindLanes } from '../core/lanes.ts';
import { checkIsolation, isEncryptedKeyText, keyPassphrase, keyPath, readKeyText } from '../keystore.ts';
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
  ledger?: () => Promise<{ ok: true; head: number } | { ok: false; code: string; detail: string }>;
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
  const present = ROLES.filter((r) => existsSync(keyPath(cfg.home, r)));
  if (present.length === 0) add({ name: 'Keys', status: 'fail', detail: `none in ${join(cfg.home, 'keys')}`, fix: 'antibody setup' });
  for (const role of present.length ? ROLES : []) {
    const p = keyPath(cfg.home, role);
    if (!existsSync(p)) {
      add({ name: `Key: ${role}`, status: 'fail', detail: 'missing', fix: 'antibody setup' });
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
      if (!pass) {
        add({ name: `Key: ${role}`, status: 'fail', detail: 'encrypted, and no passphrase is set', fix: 'set ANTIBODY_KEY_PASSPHRASE or ANTIBODY_KEY_PASSPHRASE_FILE' });
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
  if (encrypted === 0 && existsSync(keyPath(cfg.home, 'control'))) {
    add({ name: 'Keys at rest', status: cfg.backend === 'live' ? 'warn' : 'ok', detail: 'plaintext (protected by file permissions only)', ...(cfg.backend === 'live' ? { fix: 'ANTIBODY_KEY_PASSPHRASE=… antibody keys encrypt' } : {}) });
  }
  const iso = ROLES.map((r) => ({ r, rep: checkIsolation(cfg, r) })).filter((x) => !x.rep.ok);
  add(
    iso.length === 0
      ? { name: 'Key isolation', status: 'ok', detail: 'each role can read only its own key' }
      : { name: 'Key isolation', status: cfg.keyIsolation === 'enforce' ? 'fail' : 'warn', detail: `one OS user can read every role's key (${cfg.keyIsolation === 'enforce' ? 'enforced: daemons will refuse to start' : 'SIMULATED isolation'})`, fix: 'give each role its own OS user: sudo scripts/setup-roles.sh' },
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
  add(cfg.llm.baseUrl && cfg.llm.apiKey ? { name: 'LLM for Steward', status: 'ok', detail: `${cfg.llm.model ?? 'default model'} at ${new URL(cfg.llm.baseUrl).host}` } : { name: 'LLM for Steward', status: 'warn', detail: 'not set: Steward uses a scripted model (SIMULATED)', fix: 'set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL' });

  // Ledger
  if (d.ledger) {
    try {
      const l = await timed(d.ledger(), 60_000);
      add(l.ok ? { name: 'Ledger', status: 'ok', detail: `verified, head #${l.head}` } : { name: 'Ledger', status: 'fail', detail: `${l.code}: ${l.detail} (every payment is blocked)`, fix: 'antibody verify-ledger; antibody restore-index' });
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
