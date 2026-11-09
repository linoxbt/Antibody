/**
 * Sui Guardians threat lists (suiet/guardians): coin-list.json and
 * object-list.json, fetched at startup and cached on disk.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeCoinType } from '../core/encoding.ts';

const BASE = 'https://raw.githubusercontent.com/suiet/guardians/main/dist';
const MAX_AGE_MS = 24 * 3600 * 1000;

export interface GuardianLists {
  coinBlocklist: Set<string>;
  objectBlocklist: Set<string>;
  source: 'network' | 'cache' | 'none';
}

function norm(t: string): string {
  try {
    return normalizeCoinType(t);
  } catch {
    return t;
  }
}

async function fetchList(name: string, cacheDir: string, fetchImpl: typeof fetch): Promise<{ list: string[]; source: GuardianLists['source'] }> {
  const p = join(cacheDir, name);
  const fresh = existsSync(p) && Date.now() - statSync(p).mtimeMs < MAX_AGE_MS;
  if (!fresh) {
    try {
      const res = await fetchImpl(`${BASE}/${name}`, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const text = await res.text();
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(p, text);
        return { list: ((JSON.parse(text) as { blocklist?: string[] }).blocklist ?? []).map(norm), source: 'network' };
      }
    } catch {
      /* fall back to cache */
    }
  }
  if (existsSync(p)) return { list: ((JSON.parse(readFileSync(p, 'utf8')) as { blocklist?: string[] }).blocklist ?? []).map(norm), source: 'cache' };
  return { list: [], source: 'none' };
}

export async function loadGuardians(cacheDir: string, opts: { offline?: boolean; fetchImpl?: typeof fetch } = {}): Promise<GuardianLists> {
  if (opts.offline) return { coinBlocklist: new Set(), objectBlocklist: new Set(), source: 'none' };
  const f = opts.fetchImpl ?? fetch;
  const [c, o] = await Promise.all([fetchList('coin-list.json', cacheDir, f), fetchList('object-list.json', cacheDir, f)]);
  return { coinBlocklist: new Set(c.list), objectBlocklist: new Set(o.list), source: c.source === 'none' ? o.source : c.source };
}

/** Is a coin or object type on a blocklist? Matches the full type. */
export function blocklisted(g: GuardianLists, type: string): boolean {
  const t = norm(type);
  return g.coinBlocklist.has(t) || g.objectBlocklist.has(t);
}

/** How often the Sui Guardians lists are fetched again by a long-running process (B15). */
export const GUARDIANS_TTL_MS = 6 * 60 * 60_000;

/**
 * B15: a loader that refreshes itself. The first call fetches; later calls
 * return the lists at once and, once they are older than the TTL, fetch new
 * ones in the background (a failed refresh keeps the previous lists).
 */
export function refreshingGuardians(load: () => Promise<GuardianLists>, ttlMs = GUARDIANS_TTL_MS, now: () => number = Date.now): { get(): Promise<GuardianLists>; current(): GuardianLists | null } {
  let lists: GuardianLists | null = null;
  let at = 0;
  let inflight: Promise<GuardianLists> | null = null;
  const fetchNow = () =>
    (inflight ??= load()
      .then((l) => ((lists = l), (at = now()), l))
      .finally(() => (inflight = null)));
  return {
    async get() {
      if (!lists) return fetchNow();
      if (now() - at > ttlMs) void fetchNow().catch(() => undefined);
      return lists;
    },
    current: () => lists,
  };
}
