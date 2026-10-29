// Shared UI helpers. Memory text is attacker-controlled: everything renders
// through DOM nodes and textContent, never innerHTML.

const SVGNS = 'http://www.w3.org/2000/svg';

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}

export function svg(tag, attrs = {}, ...children) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, String(v));
  for (const c of children) if (c) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

export const $ = (id) => document.getElementById(id);
export const short = (s, n = 10) => (s && s.length > n + 3 ? `${s.slice(0, n)}…` : (s ?? ''));
const IRREGULAR = { memory: 'memories' };
export const plural = (n, w) => `${n} ${n === 1 ? w : (IRREGULAR[w] ?? `${w}s`)}`;

export function tagFor(cls, quarantined) {
  if (quarantined) return el('span', { class: 'tag q' }, 'quarantined');
  return el('span', { class: `tag ${cls}` }, cls);
}

export function labelClass(label) {
  if (label.startsWith('[USER')) return 'trusted';
  if (label.startsWith('[AGENT')) return 'derived';
  if (label.startsWith('[PAYMENT')) return 'record';
  return 'untrusted';
}

const ICON = { pass: '✓', fail: '✕' };

/** The protected (Steward + Antibody) result of a run. */
export function protectedPane(p) {
  if (!p) return el('div', { class: 'empty' }, 'Run an instruction to see Steward’s verdict.');
  if (p.error) return el('div', { class: 'empty' }, el('span', { style: 'color:var(--block)' }, p.error));
  const recall = p.steps?.find((s) => s.tool === 'recall_memories');
  const items = recall?.result?.items ?? [];
  const d = p.decisions?.[p.decisions.length - 1];
  return el(
    'div',
    {},
    d
      ? el(
          'div',
          {},
          el('div', { class: `verdict ${d.verdict.decision === 'ALLOW' ? 'allow' : 'block'}` }, d.verdict.decision === 'ALLOW' ? 'Allowed' : 'Blocked', el('small', {}, d.verdict.code === 'OK' ? (d.txDigest ? 'executed' : 'dry-run passed') : d.verdict.code.replaceAll('_', ' '))),
          el('p', { class: 'small', style: 'margin:0;color:var(--text-2)' }, d.verdict.reasons.join('; ')),
          el('ul', { class: 'rules' }, ...d.verdict.rules.map((r) => el('li', {}, el('span', { class: `i ${r.pass ? 'pass' : 'fail'}` }, r.pass ? ICON.pass : ICON.fail), el('span', { class: 'r' }, r.rule), el('span', {}, r.detail)))),
          el('p', { class: 'tiny muted', style: 'margin:14px 0 0' }, `decision ${short(d.decisionId, 13)} · ${d.txDigest ? `tx ${short(d.txDigest, 14)}` : d.dryRunOnly ? 'dry-run only' : 'nothing signed'}`),
        )
      : el('div', { class: 'empty' }, p.final ?? 'No payment proposed.'),
    items.length
      ? el(
          'details',
          { style: 'margin-top:18px' },
          el('summary', { class: 'kicker', style: 'cursor:pointer' }, `What Steward saw · ${plural(items.length, 'memory')}`),
          el('ul', { class: 'ctx', style: 'margin-top:12px' }, ...items.map((i) => el('li', {}, el('span', {}, el('span', { class: `tag ${labelClass(i.label)}` }, i.label.replace(/[[\]]/g, '').split(' — ')[0])), i.text.split('\n')[0].slice(0, 220)))),
        )
      : null,
    p.notes?.length ? el('p', { class: 'tiny muted', style: 'margin:12px 0 0' }, `Wrote ${plural(p.notes.length, 'note')}; the runtime set its parents to everything the turn read, so taint follows.`) : null,
  );
}

/** The unprotected agent's result: what it would have done. */
export function unprotectedPane(u) {
  if (!u) return el('div', { class: 'empty' }, 'Same model, same memories, no Antibody.');
  if (u.error) return el('div', { class: 'empty' }, u.error);
  if (!u.wouldSend) return el('div', { class: 'empty' }, u.final ?? 'Proposed no payment.');
  const w = u.wouldSend;
  return el(
    'div',
    {},
    el('div', { class: 'verdict would' }, `Would send ${w.amount} ${w.symbol}`, el('small', {}, 'no policy · dry-run only · never signed')),
    el('p', { class: 'small', style: 'margin:0;color:var(--text-2)' }, 'to ', el('code', {}, w.recipient)),
    el('p', { class: 'tiny muted', style: 'margin:14px 0 0' }, `dry-run ${w.dryRunOk ? 'succeeds — this transfer would have gone through' : `fails: ${w.dryRunError}`}`),
  );
}

// ---- lineage graph -----------------------------------------------------------

const CLASS_VAR = { trusted: '--trusted', derived: '--derived', untrusted: '--untrusted', unverified: '--unverified' };
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export function renderGraph(host, nodes, { highlightSeq = null, quarantines = [], selected = null, onSelect = () => {}, nodeW = 214, colW = 262 } = {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map();
  const d = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 1;
    seen.add(id);
    const ps = (byId.get(id)?.parents ?? []).filter((p) => byId.has(p));
    const v = ps.length ? 1 + Math.max(...ps.map((p) => d(p, seen))) : 1;
    depth.set(id, v);
    return v;
  };
  nodes.forEach((n) => d(n.id));
  const sources = [];
  for (const n of nodes) {
    if (n.lane !== 'wallet-objects') continue;
    const o = n.src.find((s) => s.t === 'sui-object' || s.t === 'url');
    if (!o) continue;
    let s = sources.find((x) => x.id === o.id);
    if (!s) sources.push((s = { id: o.id, type: o.type ?? 'external text', obs: [] }));
    s.obs.push(n.id);
  }
  const cols = new Map();
  for (const n of nodes) {
    const c = depth.get(n.id);
    if (!cols.has(c)) cols.set(c, []);
    cols.get(c).push(n);
  }
  const H = 62, PX = 28, PY = 24, NH = 40;
  const pos = new Map();
  // Column 0 holds source objects when there are any; memories start after them.
  const off = sources.length ? 0 : -1;
  sources.forEach((s, i) => pos.set(`src:${s.id}`, { x: PX, y: PY + i * H }));
  for (const [c, list] of cols) {
    list.sort((a, b) => a.ckpt - b.ckpt || a.lane.localeCompare(b.lane));
    list.forEach((n, i) => pos.set(n.id, { x: PX + (c + off) * colW, y: PY + i * H }));
  }
  const maxCol = Math.max(1, ...cols.keys()) + off;
  const rows = Math.max(sources.length, ...[...cols.values()].map((l) => l.length), 1);
  const width = PX * 2 + maxCol * colW + nodeW;
  const height = PY * 2 + (rows - 1) * H + NH;

  const hot = new Set(highlightSeq === null ? [] : nodes.filter((n) => n.seedHits.includes(highlightSeq)).map((n) => n.id));
  const q = quarantines.find((x) => x.seq === highlightSeq);
  const hotSrc = q?.seed?.type === 'source' ? `src:${q.seed.value}` : null;

  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': 'Memory lineage graph' });
  const edge = (a, b, isHot) => {
    const p = pos.get(a), r = pos.get(b);
    if (!p || !r) return;
    const x1 = p.x + nodeW, y1 = p.y + NH / 2, x2 = r.x, y2 = r.y + NH / 2, mx = (x1 + x2) / 2;
    root.append(svg('path', { d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, class: `g-edge${isHot ? ' hot' : ''}` }));
  };
  for (const s of sources) for (const o of s.obs) edge(`src:${s.id}`, o, hotSrc === `src:${s.id}` && hot.has(o));
  for (const n of nodes) for (const p of n.parents) edge(p, n.id, hot.has(p) && hot.has(n.id));

  for (const s of sources) {
    const p = pos.get(`src:${s.id}`);
    const g = svg('g', { class: `g-node${highlightSeq !== null && hotSrc !== `src:${s.id}` ? ' dim' : ''}`, transform: `translate(${p.x},${p.y})` });
    g.append(svg('rect', { class: 'shape', width: nodeW, height: NH, rx: NH / 2, fill: 'transparent', stroke: css('--gold'), 'stroke-dasharray': '3 4' }));
    g.append(svg('text', { x: 16, y: 17 }, `◆ ${short(s.id, 18)}`), svg('text', { x: 16, y: 31, class: 'sub' }, short(String(s.type).split('::').slice(-1)[0], 30)));
    root.append(g);
  }
  for (const n of nodes) {
    const p = pos.get(n.id);
    const stroke = n.quarantined ? css('--garnet') : css(CLASS_VAR[n.cls]);
    const g = svg('g', { class: `g-node${highlightSeq !== null && !hot.has(n.id) ? ' dim' : ''}${selected === n.id ? ' sel' : ''}`, transform: `translate(${p.x},${p.y})`, tabindex: 0, role: 'button', 'aria-label': `${n.kind} ${n.cls}` });
    const fill = `color-mix(in srgb, ${stroke} 12%, ${css('--bg-2')})`;
    const dash = n.quarantined ? '5 4' : null;
    if (n.kind === 'decision') g.append(svg('polygon', { class: 'shape', points: `0,${NH / 2} 14,0 ${nodeW - 14},0 ${nodeW},${NH / 2} ${nodeW - 14},${NH} 14,${NH}`, fill, stroke, 'stroke-width': 1.4, 'stroke-dasharray': dash }));
    else g.append(svg('rect', { class: 'shape', width: nodeW, height: NH, rx: 9, fill, stroke, 'stroke-width': 1.4, 'stroke-dasharray': dash }));
    const verdict = n.kind === 'decision' ? (/Payment decision: (\w+)( \w+)?/.exec(n.text)?.slice(1).join('').trim() ?? '') : '';
    g.append(
      svg('text', { x: 14, y: 17 }, short(`${n.kind}${verdict ? ' · ' + verdict : ''}`, 30)),
      svg('text', { x: 14, y: 31, class: 'sub' }, `${n.lane} · ${n.cls}${n.quarantined ? ' · excluded' : n.unresolved ? ' · unresolved' : ''}`),
    );
    const pick = () => onSelect(n);
    g.addEventListener('click', pick);
    g.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick()));
    root.append(g);
  }
  host.replaceChildren(root);
}

export function nodeDetail(n, extra = null) {
  if (!n) return el('p', { class: 'muted small' }, 'Select a node to read its envelope, class and lineage.');
  return el(
    'div',
    { class: 'detail' },
    el('div', { class: 'item-head' }, el('h3', {}, n.kind), tagFor(n.cls, false), n.quarantined ? el('span', { class: 'tag q' }, `quarantined by #${n.seedHits.join(', #')}`) : null),
    el(
      'dl',
      { class: 'kv', style: 'margin-top:14px' },
      el('dt', {}, 'lane'), el('dd', {}, el('code', {}, n.lane)),
      el('dt', {}, 'envelope'), el('dd', {}, el('code', {}, n.id)),
      el('dt', {}, 'blob'), el('dd', {}, el('code', {}, n.blobIds[0] ?? '—')),
      el('dt', {}, 'parents'), el('dd', {}, n.parents.length ? n.parents.map((p) => short(p, 13)).join(', ') : 'none (runtime-assigned)'),
      el('dt', {}, 'checkpoint'), el('dd', {}, String(n.ckpt)),
      ...(n.notes.length ? [el('dt', {}, 'why'), el('dd', {}, n.notes.join(' · '))] : []),
    ),
    el('pre', {}, n.text),
    extra,
  );
}
