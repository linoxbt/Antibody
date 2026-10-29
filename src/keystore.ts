/**
 * Per-role key files (spec §12 key handling, invariant I-12).
 *
 *   $ANTIBODY_HOME/keys/<role>/<lane>.key   mode 0600, directory 0700
 *
 * A process loads only its own role's key and refuses to start if it can read
 * another role's key file. On a single shared OS user that check is
 * meaningless, so it only enforces when ANTIBODY_KEY_ISOLATION=enforce (the
 * live default); otherwise the process runs with a SIMULATED isolation banner.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { laneKeyFromSeedHex } from './core/keys.ts';
import { ROLES, type Config, type Role } from './config.ts';

const KEY_FILE: Readonly<Record<Role, string>> = {
  control: 'antibody.key',
  user: 'user.key',
  agent: 'agent.key',
  ingest: 'wallet-objects.key',
  signer: 'wallet.key',
};

export function keyPath(home: string, role: Role): string {
  return join(home, 'keys', role, KEY_FILE[role]);
}

// ---- passphrase encryption at rest -----------------------------------------
//
// With ANTIBODY_KEY_PASSPHRASE (or ANTIBODY_KEY_PASSPHRASE_FILE) set, key files
// are written as one line:
//   antibody-key:v1:scrypt:<logN>:<r>:<p>:<salt>:<iv>:<tag>:<ciphertext>   (base64url, AES-256-GCM)
// so a copied disk, backup or stray `cat` does not leak the key. Plaintext key
// files keep working; `antibody keys encrypt` converts them in place.

const ENC_PREFIX = 'antibody-key:v1:scrypt:';
const SCRYPT = { logN: 15, r: 8, p: 1 };

export const isEncryptedKeyText = (text: string) => text.trimStart().startsWith(ENC_PREFIX);

/** The passphrase from the environment, if any (a file wins so it stays out of `ps` and shell history). */
export function keyPassphrase(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ANTIBODY_KEY_PASSPHRASE_FILE) return readFileSync(env.ANTIBODY_KEY_PASSPHRASE_FILE, 'utf8').replace(/\r?\n$/, '');
  return env.ANTIBODY_KEY_PASSPHRASE || null;
}

const kdf = (pass: string, salt: Buffer, o = SCRYPT) => scryptSync(pass.normalize('NFKC'), salt, 32, { N: 2 ** o.logN, r: o.r, p: o.p, maxmem: 256 * 2 ** o.logN * o.r });

export function encryptKeyText(plain: string, pass: string, o = SCRYPT): string {
  if (!pass) throw new Error('empty passphrase');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kdf(pass, salt, o), iv);
  const ct = Buffer.concat([c.update(plain.trim(), 'utf8'), c.final()]);
  return ENC_PREFIX + [o.logN, o.r, o.p, salt.toString('base64url'), iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

export function decryptKeyText(text: string, pass: string): string {
  const parts = text.trim().slice(ENC_PREFIX.length).split(':');
  if (!isEncryptedKeyText(text) || parts.length !== 7) throw new Error('not an encrypted Antibody key file');
  const [logN, r, p] = parts.slice(0, 3).map(Number) as [number, number, number];
  if (!(logN >= 10 && logN <= 20 && r >= 1 && r <= 32 && p >= 1 && p <= 16)) throw new Error('encrypted key file has out-of-range scrypt parameters');
  const [salt, iv, tag, ct] = parts.slice(3).map((x) => Buffer.from(x, 'base64url')) as [Buffer, Buffer, Buffer, Buffer];
  const d = createDecipheriv('aes-256-gcm', kdf(pass, salt, { logN, r, p }), iv);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch {
    throw new Error('wrong key passphrase (or the key file was altered)');
  }
}

/** What goes on disk for a key: encrypted when a passphrase is configured. */
export function sealKeyText(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  const pass = keyPassphrase(env);
  return (pass ? encryptKeyText(plain, pass) : plain.trim()) + '\n';
}

/** A key file's secret, decrypting when needed. */
export function readKeyText(p: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = readFileSync(p, 'utf8');
  if (!isEncryptedKeyText(raw)) return raw.trim();
  const pass = keyPassphrase(env);
  if (!pass) throw new Error(`${p} is encrypted: set ANTIBODY_KEY_PASSPHRASE (or ANTIBODY_KEY_PASSPHRASE_FILE) to unlock it`);
  return decryptKeyText(raw, pass).trim();
}

/** Encrypt existing plaintext key files in place (atomic per file). Returns the files converted. */
export function encryptKeysInPlace(home: string, pass: string): string[] {
  const done: string[] = [];
  for (const role of ROLES) {
    const p = keyPath(home, role);
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, 'utf8');
    if (isEncryptedKeyText(raw)) continue;
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, encryptKeyText(raw, pass) + '\n', { mode: 0o600, flag: 'wx' });
    if (decryptKeyText(readFileSync(tmp, 'utf8'), pass).trim() !== raw.trim()) throw new Error(`round-trip check failed for ${p}; left unchanged`);
    renameSync(tmp, p);
    done.push(p);
  }
  return done;
}

export function writeKeyFile(home: string, role: Role, contents: string): string {
  const p = keyPath(home, role);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  chmodSync(dirname(p), 0o700);
  if (existsSync(p)) throw new Error(`refusing to overwrite existing key ${p}`);
  writeFileSync(p, sealKeyText(contents), { mode: 0o600, flag: 'wx' });
  return p;
}

export interface IsolationReport {
  ok: boolean;
  readableForeign: Role[];
  mode: Config['keyIsolation'];
}

/** Which other roles' key files can this process read? */
export function checkIsolation(cfg: Config, role: Role): IsolationReport {
  const readableForeign = ROLES.filter((r) => r !== role).filter((r) => {
    const p = keyPath(cfg.home, r);
    if (!existsSync(p)) return false;
    try {
      accessSync(p, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  });
  return { ok: readableForeign.length === 0, readableForeign, mode: cfg.keyIsolation };
}

export class KeyIsolationError extends Error {}

function assertRole(cfg: Config, role: Role): void {
  if (cfg.role && cfg.role !== role) {
    throw new KeyIsolationError(`this command runs as role "${role}" but ANTIBODY_ROLE=${cfg.role}`);
  }
  const rep = checkIsolation(cfg, role);
  if (!rep.ok && cfg.keyIsolation === 'enforce') {
    throw new KeyIsolationError(
      `role ${role} can read key files of ${rep.readableForeign.join(', ')}: run each role as its own OS user ` +
        `(scripts/setup-roles.sh) or set ANTIBODY_KEY_ISOLATION=simulated for a single-user demo`,
    );
  }
  const own = keyPath(cfg.home, role);
  // Windows has no POSIX modes (access is by ACL), so this check only means something elsewhere.
  if (process.platform !== 'win32' && existsSync(own) && (statSync(own).mode & 0o077) !== 0) {
    throw new KeyIsolationError(`${own} must be mode 0600`);
  }
}

/** Load the lane key for a role, after the isolation check. */
export function loadLaneKey(cfg: Config, role: Exclude<Role, 'signer'>): ReturnType<typeof laneKeyFromSeedHex> {
  assertRole(cfg, role);
  const p = keyPath(cfg.home, role);
  if (!existsSync(p)) throw new Error(`no ${role} key at ${p}: run \`antibody setup\` first`);
  return laneKeyFromSeedHex(readKeyText(p));
}

/** Load the Steward wallet secret (suiprivkey…) for the signer role. */
export function loadWalletSecret(cfg: Config): string {
  assertRole(cfg, 'signer');
  const p = keyPath(cfg.home, 'signer');
  if (!existsSync(p)) throw new Error(`no signer wallet key at ${p}`);
  return readKeyText(p);
}

/** Public half of a role's lane key, without enforcing isolation (setup and tests only). */
export function hasKey(home: string, role: Role): boolean {
  return existsSync(keyPath(home, role));
}
