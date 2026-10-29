import { el, plural, renderGraph, nodeDetail } from '../../ui.js';
import { head } from '../kit.js';

// View state survives re-renders; it resets when the recorded moment changes.
let selected = null;
let highlight;
let seenIndex = null;

function defaultHighlight(src) {
  const qs = src.state.ledger.ok ? src.state.ledger.quarantines.filter((q) => !q.released) : [];
  if (src.mode === 'recorded') return src.steps[src.index].highlight ?? qs[0]?.seq ?? null;
  return qs.at(-1)?.seq ?? null;
}

export default {
  id: 'memory',
  path: '/app/memory',
  title: 'Memory',
  icon: 'memory',
  render(ctx) {
    const src = ctx.src;
    const s = src.state;
    if (seenIndex !== src.index || highlight === undefined) {
      seenIndex = src.index;
      highlight = defaultHighlight(src);
      selected = ctx.params().get('node') ?? null;
    }
    const qs = s.ledger.ok ? s.ledger.quarantines.filter((q) => !q.released) : [];

    const seed = el('select', { 'aria-label': 'Highlight a quarantine', style: 'height:40px;font-size:14px' }, el('option', { value: '' }, 'No highlight'), ...qs.map((q) => el('option', { value: String(q.seq), ...(q.seq === highlight ? { selected: true } : {}) }, `Quarantine #${q.seq} · ${q.seed.type}${q.auto ? ' · auto' : ''}`)));
    seed.addEventListener('change', () => {
      highlight = seed.value === '' ? null : Number(seed.value);
      ctx.rerender();
    });

    const graph = el('div', { class: 'graph-wrap graph' });
    const detailHost = el('section', { class: 'card' });
    const hot = highlight === null ? [] : s.nodes.filter((n) => n.seedHits.includes(highlight));
    const q = qs.find((x) => x.seq === highlight);

    renderGraph(graph, s.nodes, {
      highlightSeq: highlight,
      quarantines: qs,
      selected,
      onSelect: (n) => {
        selected = n.id;
        history.replaceState(null, '', `/app/memory?node=${encodeURIComponent(n.id)}`);
        ctx.rerender();
        requestAnimationFrame(() => document.getElementById('node-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
      },
    });

    const n = s.nodes.find((x) => x.id === selected);
    const qBtn =
      n && !n.quarantined && n.kind !== 'decision'
        ? el(
            'button',
            {
              class: 'btn btn-ghost btn-sm',
              style: 'margin-top:16px',
              onclick: () =>
                ctx.act(async () => {
                  const pv = await src.api('/api/preview', { type: 'memory', value: n.id });
                  if (!confirm(`Quarantine this ${n.kind}?\n\n${plural(pv.memories - pv.decisions, 'memory')} and ${plural(pv.decisions, 'decision')} leave Steward's context. They stay on Walrus as evidence.`)) return;
                  const r = await src.api('/api/quarantine', { type: 'memory', value: n.id, reason: 'quarantined from the console' });
                  highlight = r.seq;
                  await src.refresh();
                  ctx.toast(`Quarantine written as ledger #${r.seq}.`);
                  ctx.rerender();
                }),
            },
            'Quarantine',
          )
        : null;
    detailHost.id = 'node-detail';
    detailHost.append(el('div', { class: 'card-title' }, el('h3', {}, 'Envelope')), nodeDetail(n, qBtn));

    return el(
      'div',
      { style: 'display:grid;gap:16px' },
      head('Blast', 'radius.', 'Every memory, where it came from, and what a quarantine takes out of context.'),
      el(
        'section',
        { class: 'card' },
        el('div', { class: 'card-title', style: 'flex-wrap:wrap' }, el('div', { class: 'legend' }, ...['trusted', 'derived', 'untrusted', 'unverified'].map((c) => el('span', {}, el('i', { class: c }), c)), el('span', {}, el('i', { class: 'q' }), 'quarantined')), seed),
        graph,
        el(
          'p',
          { class: 'hint', style: 'margin-top:14px' },
          q ? `#${q.seq} reaches ${plural(hot.filter((x) => x.kind !== 'decision').length, 'memory')} · ${plural(hot.filter((x) => x.kind === 'decision').length, 'decision')}. Select a node for its envelope.` : `${plural(s.nodes.length, 'memory')} · ${s.nodes.filter((x) => !x.eligible).length} excluded. Select a node for its envelope.`,
        ),
      ),
      detailHost,
    );
  },
};
