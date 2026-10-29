/**
 * The learning loop. When a quarantine is confirmed, control derives a lesson
 * from the quarantined observations (who sent it, which coin type and package,
 * which words it used) and appends it to the ledger. The sentinel recalls
 * active lessons on every scan, so a repeat attack from the same sender or
 * package is recognised on sight and quarantined before Steward ever reads it.
 *
 * Lessons only ever tighten detection; they never feed the policy engine and
 * can never add a payee or raise a cap. Releasing the quarantine retires the
 * lesson, and both survive rebuild because they live in the ledger.
 */
import { bodyContent } from './envelope.ts';
import { normalizeSuiAddress } from './encoding.ts';
import type { LedgerPayload, LessonEntry } from './ledger.ts';
import type { LineageNode } from './lineage.ts';

const STOPWORDS = new Set(
  'the and for that this with from your you are was have has will into about them they their there what when which while would could should been being than then also just only more most some such very over under after before again here coin token sui wallet object description name symbol'.split(' '),
);

export function keywords(text: string, max = 24): string[] {
  const counts = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9']{3,}/g) ?? []) {
    if (STOPWORDS.has(w) || w.length > 24 || /^x?[0-9a-f]{8,}$/.test(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([w]) => w)
    .sort();
}

function packageOf(type: string): string | undefined {
  const m = /^(0x[0-9a-fA-F]{1,64})::/.exec(type);
  return m ? normalizeSuiAddress(m[1]!) : undefined;
}

/** Derive a lesson from the observations a quarantine excluded. */
export function deriveLesson(fromSeq: number, quarantined: LineageNode[], reason: string): LedgerPayload<'lesson'> | null {
  const senders = new Set<string>();
  const coinTypes = new Set<string>();
  const packages = new Set<string>();
  const words = new Set<string>();
  for (const n of quarantined) {
    if (n.env.header.kind !== 'observation') continue;
    for (const r of n.env.header.src) {
      if (r.t === 'sender' && r.addr) senders.add(normalizeSuiAddress(r.addr));
      if ((r.t === 'coin-type' || r.t === 'sui-object') && r.type) {
        if (r.t === 'coin-type') coinTypes.add(r.type);
        const pkg = packageOf(r.type);
        // The framework packages (0x1, 0x2) are shared by everyone: never learn them.
        if (pkg && !/^0x0{62}0[12]$/.test(pkg)) packages.add(pkg);
      }
    }
    for (const w of keywords(bodyContent(n.env.body))) words.add(w);
  }
  if (senders.size + coinTypes.size + packages.size === 0 && words.size === 0) return null;
  const sorted = (s: Set<string>, max: number) => [...s].sort().slice(0, max);
  return {
    fromSeq,
    indicators: {
      senders: sorted(senders, 16),
      coinTypes: sorted(coinTypes, 16),
      packages: sorted(packages, 16),
      keywords: sorted(words, 48),
    },
    summary: reason.slice(0, 512),
  };
}

export interface LessonCandidate {
  sender?: string;
  coinType?: string;
  objectType?: string;
  text: string;
}

export interface LessonMatch {
  lessonSeq: number;
  fromSeq: number;
  indicator: 'sender' | 'coin-type' | 'package' | 'keywords';
  value: string;
  weight: number;
}

/**
 * Score a new observation against active lessons. An exact sender, coin type
 * or package match is strong evidence; keyword overlap alone is weak.
 */
export function matchLessons(c: LessonCandidate, lessons: LessonEntry[]): { score: number; matches: LessonMatch[] } {
  const matches: LessonMatch[] = [];
  const sender = c.sender ? normalizeSuiAddress(c.sender) : undefined;
  const pkgs = [c.coinType, c.objectType].map((t) => (t ? packageOf(t) : undefined)).filter((x): x is string => !!x);
  const words = new Set(keywords(c.text));
  for (const l of lessons) {
    if (!l.active) continue;
    const base = { lessonSeq: l.seq, fromSeq: l.fromSeq };
    if (sender && l.indicators.senders.includes(sender)) matches.push({ ...base, indicator: 'sender', value: sender, weight: 0.7 });
    if (c.coinType && l.indicators.coinTypes.includes(c.coinType)) matches.push({ ...base, indicator: 'coin-type', value: c.coinType, weight: 0.9 });
    for (const p of pkgs) if (l.indicators.packages.includes(p)) matches.push({ ...base, indicator: 'package', value: p, weight: 0.6 });
    if (l.indicators.keywords.length > 0 && words.size > 0) {
      const shared = l.indicators.keywords.filter((w) => words.has(w));
      const jaccard = shared.length / new Set([...l.indicators.keywords, ...words]).size;
      if (shared.length >= 3 && jaccard >= 0.25) {
        matches.push({ ...base, indicator: 'keywords', value: shared.slice(0, 6).join(' '), weight: Math.min(0.5, jaccard) });
      }
    }
  }
  const score = 1 - matches.reduce((acc, m) => acc * (1 - m.weight), 1);
  return { score, matches };
}

/** Strong matches (sender, coin type, package) justify automatic quarantine. */
export function isStrongLessonMatch(m: LessonMatch): boolean {
  return m.indicator !== 'keywords';
}
