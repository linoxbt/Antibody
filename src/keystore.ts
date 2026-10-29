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
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

export function writeKeyFile(home: string, role: Role, contents: string): string {
  const p = keyPath(home, role);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  chmodSync(dirname(p), 0o700);
  if (existsSync(p)) throw new Error(`refusing to overwrite existing key ${p}`);
  writeFileSync(p, contents.trim() + '\n', { mode: 0o600, flag: 'wx' });
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
  if (existsSync(own) && (statSync(own).mode & 0o077) !== 0) {
    throw new KeyIsolationError(`${own} must be mode 0600`);
  }
}

/** Load the lane key for a role, after the isolation check. */
export function loadLaneKey(cfg: Config, role: Exclude<Role, 'signer'>): ReturnType<typeof laneKeyFromSeedHex> {
  assertRole(cfg, role);
  const p = keyPath(cfg.home, role);
  if (!existsSync(p)) throw new Error(`no ${role} key at ${p}: run \`antibody setup\` first`);
  return laneKeyFromSeedHex(readFileSync(p, 'utf8'));
}

/** Load the Steward wallet secret (suiprivkey…) for the signer role. */
export function loadWalletSecret(cfg: Config): string {
  assertRole(cfg, 'signer');
  const p = keyPath(cfg.home, 'signer');
  if (!existsSync(p)) throw new Error(`no signer wallet key at ${p}`);
  return readFileSync(p, 'utf8').trim();
}

/** Public half of a role's lane key, without enforcing isolation (setup and tests only). */
export function hasKey(home: string, role: Role): boolean {
  return existsSync(keyPath(home, role));
}
