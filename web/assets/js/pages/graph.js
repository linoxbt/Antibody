import { mountShell, modeBar, toast } from '../shell.js';
import { loadSource } from '../data.js';
import { $, el, plural, renderGraph, nodeDetail } from '../ui.js';

mountShell('graph');

let src;
let selected = null;
let highlight = null;

function defaultHighlight() {
  const qs = src.state.ledger.ok ? src.state.ledger.quarantines.filter((q) => !q.released) : [];
  if (src.mode === 'recorded') return src.steps[src.index].highlight ?? qs[0]?.seq ?? null;
  return qs.at(-1)?.seq ?? null;
}

function render() {
  const s = src.state;
  $('modebar').replaceChildren(modeBar(src, () => ((highlight = defaultHighlight()), (selected = null), render())));
  const qs = s.ledger.ok ? s.ledger.quarantines.filter((q) => !q.released) : [];
  $('seed').replaceChildren(el('option', { value: '' }, 'No highlight'), ...qs.map((q) => el('option', { value: String(q.seq), ...(q.seq === highlight ? { selected: true } : {}) }, `Quarantine #${q.seq} · ${q.seed.type}${q.auto ? ' · auto' : ''}`)));
  renderGraph($('graph'), s.nodes, {
    highlightSeq: highlight,
    quarantines: qs,
    selected,
    onSelect: (n) => {
      selected = n.id;
      render();
      $('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
  });
  const hot = highlight === null ? [] : s.nodes.filter((n) => n.seedHits.includes(highlight));
  const q = qs.find((x) => x.seq === highlight);
  $('radius').textContent = q
    ? `#${q.seq} reaches ${plural(hot.filter((n) => n.kind !== 'decision').length, 'memory')} · ${plural(hot.filter((n) => n.kind === 'decision').length, 'decision')}`
    : `${plural(s.nodes.length, 'memory')} · ${s.nodes.filter((n) => !n.eligible).length} excluded`;
  const n = s.nodes.find((x) => x.id === selected);
  $('detail').replaceChildren(
    el('div', { class: 'card-title' }, el('div', {}, el('h3', {}, 'Envelope'))),
    nodeDetail(
      n,
      n && !n.quarantined && n.kind !== 'decision'
        ? el('button', { class: 'btn btn-ghost btn-sm', style: 'margin-top:16px', onclick: () => quarantine(n.id) }, 'Quarantine')
        : null,
    ),
  );
}

async function quarantine(id) {
  try {
    const pv = await src.api('/api/preview', { type: 'memory', value: id });
    if (!confirm(`Quarantine memory ${id}?\n\n${plural(pv.memories - pv.decisions, 'memory')} and ${plural(pv.decisions, 'decision')} leave Steward's context. They stay on Walrus as evidence.`)) return;
    const r = await src.api('/api/quarantine', { type: 'memory', value: id, reason: 'quarantined from the blast-radius view' });
    highlight = r.seq;
    await src.refresh();
    render();
  } catch (e) {
    toast(e.message);
  }
}

$('seed').addEventListener('change', (e) => {
  highlight = e.target.value === '' ? null : Number(e.target.value);
  render();
});

(async () => {
  try {
    src = await loadSource();
  } catch {
    $('graph').replaceChildren(el('p', { class: 'empty', style: 'padding:24px' }, 'No data source. Start the daemons with antibody up.'));
    return;
  }
  highlight = defaultHighlight();
  render();
})();
