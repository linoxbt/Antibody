/** Terminal rendering for the CLI (honours NO_COLOR). */
import { bodyContent } from '../core/envelope.ts';
import type { BlastRadius, LineageNode } from '../core/lineage.ts';
import { contextEligible, forensicView, type Projection } from '../core/projection.ts';
import type { Verdict } from '../core/policy.ts';
import type { TrustClass } from '../core/types.ts';

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const c = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = c(1);
export const dim = c(2);
export const red = c(31);
export const green = c(32);
export const yellow = c(33);
export const blue = c(34);
export const magenta = c(35);
export const cyan = c(36);

export const CLASS_COLOR: Record<TrustClass, (s: string) => string> = {
  trusted: green,
  derived: blue,
  untrusted: yellow,
  unverified: red,
};

export function banner(lines: string[]): void {
  for (const l of lines) console.log(magenta(bold(l)));
}

export function short(s: string, n = 10): string {
  return s.length <= n + 4 ? s : `${s.slice(0, n)}…`;
}

export function verdictLine(v: Verdict): string {
  return v.decision === 'ALLOW' ? green(bold(`ALLOW`)) + ` ${v.reasons.join('; ')}` : red(bold(`BLOCK ${v.code}`)) + ` ${v.reasons.join('; ')}`;
}

export function rulesTable(v: Verdict): string {
  return v.rules.map((r) => `    ${r.pass ? green('✓') : red('✗')} ${r.rule} ${dim(r.detail)}`).join('\n');
}

function nodeLine(n: LineageNode): string {
  const h = n.env.header;
  const flag = n.quarantined ? red(' [QUARANTINED]') : n.unresolved ? yellow(' [UNRESOLVED]') : '';
  const first = bodyContent(n.env.body).split('\n')[0]!.slice(0, 90);
  return `${CLASS_COLOR[n.cls](n.cls.padEnd(10))} ${dim(h.lane.padEnd(14))} ${h.kind.padEnd(11)} ${dim(short(n.id, 13))}${flag}  ${first}`;
}

export function renderProjection(p: Projection, opts: { forensic?: boolean } = {}): string {
  const out: string[] = [];
  const nodes = p.lineage.order.map((id) => p.lineage.nodes.get(id)!);
  const eligible = nodes.filter(contextEligible);
  out.push(bold(`Projection (in model context: ${eligible.length}, excluded: ${nodes.length - eligible.length}, failed verification: ${p.lineage.forensic.length})`));
  for (const cls of ['trusted', 'derived', 'untrusted'] as TrustClass[]) {
    const group = eligible.filter((n) => n.cls === cls);
    if (group.length === 0) continue;
    out.push(`  ${CLASS_COLOR[cls](bold(cls.toUpperCase()))}`);
    for (const n of group) out.push(`    ${nodeLine(n)}`);
  }
  if (opts.forensic) {
    const f = forensicView(p);
    out.push(bold('\nForensic view (excluded, kept as evidence — never deleted)'));
    if (f.excluded.length === 0 && f.failed.length === 0) out.push(dim('  nothing excluded'));
    for (const e of f.excluded) {
      out.push(`  ${red('✗')} ${short(e.id, 13)} ${e.lane}/${e.kind} ${dim(e.why.join('; '))}`);
      out.push(dim(`      ${e.text.split('\n').join(' ⏎ ').slice(0, 220)}`));
    }
    for (const x of f.failed) out.push(`  ${red('✗')} blob ${short(x.blobId, 12)} ${red(x.code)} ${dim(x.reason)}`);
  }
  out.push(dim(`Coverage: ${p.coverage.retrieved}/${p.coverage.inventory} inventory blobs retrieved${p.coverage.missing.length ? `, missing ${p.coverage.missing.length}` : ''}`));
  out.push(`Projection digest: ${bold(p.digest)}`);
  return out.join('\n');
}

/** Text blast-radius tree: source → memories → decisions (FR-08). */
export function renderBlast(r: BlastRadius): string {
  const out: string[] = [];
  const kids = new Map<string, string[]>();
  for (const e of r.edges) kids.set(e.from, [...(kids.get(e.from) ?? []), e.to]);
  const byId = new Map(r.memories.map((m) => [m.id, m]));
  const roots = r.sources.length ? r.sources.map((s) => `src:${s}`) : r.memories.filter((m) => !m.env.header.parents.some((p) => byId.has(p))).map((m) => m.id);
  const seen = new Set<string>();
  const walk = (id: string, depth: number) => {
    const pad = '  '.repeat(depth);
    if (id.startsWith('src:')) out.push(`${pad}${yellow('◆')} source ${bold(id.slice(4))}`);
    else {
      const n = byId.get(id);
      if (!n) return;
      const kind = n.env.header.kind === 'decision' ? red('decision') : n.env.header.kind;
      out.push(`${pad}└─ ${kind} ${dim(short(id, 13))} ${CLASS_COLOR[n.cls](n.cls)} ${dim(bodyContent(n.env.body).split('\n')[0]!.slice(0, 70))}`);
    }
    if (seen.has(id)) return;
    seen.add(id);
    for (const k of kids.get(id) ?? []) walk(k, depth + 1);
  };
  for (const r0 of roots) walk(r0, 0);
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
  out.push(dim(`${n(r.memories.length - r.decisions.length, 'memory').replace('memorys', 'memories')}, ${n(r.decisions.length, 'decision')}, ${n(r.txDigests.length, 'transaction digest')}${r.txDigests.length ? ': ' + r.txDigests.join(', ') : ''}`));
  return out.join('\n');
}
