/**
 * Recall query plans (spec §7 completeness, §10 content coverage). The
 * relayer only answers similarity queries, so coverage is driven by what each
 * retrieved record names: ledger seq numbers, lane tags, source ids, parents.
 */
import { laneQuery, parseEnvelope } from '../core/envelope.ts';
import { LEDGER_PHRASE } from '../core/ledger.ts';
import { srcIdentifiers } from '../core/seeds.ts';
import { LANE_KINDS, NS_CONTENT, NS_LEDGER, type Kind, type Lane, type StoredMemory } from '../core/types.ts';
import { retrieveAll, type CoverageResult, type MemoryClient } from '../adapters/memory.ts';

export function ledgerQueries(): string[] {
  return [LEDGER_PHRASE];
}

function ledgerFollowUps(found: StoredMemory[], missing: string[]): string[] {
  const seqs = new Set<number>();
  for (const m of found) {
    const r = /antibody ledger record seq (\d+)/.exec(m.text);
    if (r) seqs.add(Number(r[1]));
  }
  const top = Math.max(-1, ...seqs) + missing.length + 2;
  const out: string[] = [];
  for (let s = 0; s <= top; s++) if (!seqs.has(s)) out.push(`${LEDGER_PHRASE} seq ${s}`);
  return out;
}

export function retrieveLedger(mem: MemoryClient, known?: ReadonlyMap<string, StoredMemory>): Promise<CoverageResult> {
  // One base query covers up to 100 records; beyond that, one follow-up per missing seq, plus slack.
  return retrieveAll(mem, NS_LEDGER, ledgerQueries(), ledgerFollowUps, (n) => Math.max(150, n + 50), known);
}

export function contentQueries(): string[] {
  const out: string[] = [];
  for (const [lane, kinds] of Object.entries(LANE_KINDS) as [Lane, readonly Kind[]][]) {
    for (const k of kinds) if (k !== 'ledger') out.push(laneQuery(lane, k));
  }
  return out;
}

/** One query per known source id, then one per unresolved parent id. */
function contentFollowUps(found: StoredMemory[]): string[] {
  const ids = new Set<string>();
  const sources = new Set<string>();
  const parents = new Set<string>();
  for (const m of found) {
    try {
      const h = parseEnvelope(m.text).header;
      ids.add(h.id);
      for (const p of h.parents) parents.add(p);
      for (const r of h.src) for (const s of srcIdentifiers(r)) sources.add(s);
    } catch {
      /* unparseable records still count toward coverage */
    }
  }
  return [...[...sources].sort(), ...[...parents].filter((p) => !ids.has(p)).sort().map((p) => `id:${p}`)];
}

export function retrieveContent(mem: MemoryClient, known?: ReadonlyMap<string, StoredMemory>): Promise<CoverageResult> {
  return retrieveAll(mem, NS_CONTENT, contentQueries(), contentFollowUps, 300, known);
}
