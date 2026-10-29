/**
 * On-disk state format version for $ANTIBODY_HOME (antibody.json's
 * stateVersion). Every process checks it before touching state: an older home
 * is migrated in order (antibody.json backed up first), a newer one is refused
 * so an old binary never rewrites a format it does not understand.
 *
 *   0  pre-1.0: no stateVersion field
 *   1  1.0: stateVersion recorded; keys/, run/, logs/ tightened to 0700
 */
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { persistedPath } from '../config.ts';

export const STATE_VERSION = 1;

type Migration = (home: string) => void;

const MIGRATIONS: Record<number, Migration> = {
  // 0 → 1
  0: (home) => {
    if (process.platform === 'win32') return;
    for (const d of ['keys', 'run', 'logs']) if (existsSync(join(home, d))) chmodSync(join(home, d), 0o700);
  },
};

export class StateVersionError extends Error {}

export function readStateVersion(home: string): number | null {
  const p = persistedPath(home);
  if (!existsSync(p)) return null;
  const v = (JSON.parse(readFileSync(p, 'utf8')) as { stateVersion?: unknown }).stateVersion;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

function writeVersion(home: string, version: number): void {
  const p = persistedPath(home);
  const cur = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ...cur, stateVersion: version }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, p);
}

/** Migrate an older home in place; refuse a newer one. Returns the versions crossed. */
export function ensureState(home: string, target = STATE_VERSION, migrations: Record<number, Migration> = MIGRATIONS): { from: number | null; to: number | null } {
  const from = readStateVersion(home);
  if (from === null) return { from, to: null }; // not set up yet: setup writes the current version
  if (from > target) {
    throw new StateVersionError(`${home} was written by a newer Antibody (state version ${from}; this build understands ${target}). Update Antibody: re-run the installer.`);
  }
  if (from === target) return { from, to: from };
  copyFileSync(persistedPath(home), `${persistedPath(home)}.v${from}.bak`);
  for (let v = from; v < target; v++) {
    const m = migrations[v];
    if (!m) throw new StateVersionError(`no migration from state version ${v}`);
    m(home);
    writeVersion(home, v + 1);
  }
  return { from, to: target };
}
