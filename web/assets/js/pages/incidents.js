import { mountShell, modeBar, toast } from '../shell.js';
import { loadSource } from '../data.js';
import { $, el, short, plural } from '../ui.js';

mountShell('incidents');
let src;

async function quarantine(type, value) {
  try {
    const pv = await src.api('/api/preview', { type, value });
    if (!confirm(`Quarantine ${type} ${value}?\n\n${plural(pv.memories - pv.decisions, 'memory')} and ${plural(pv.decisions, 'decision')} leave Steward's context. They stay on Walrus as evidence.`)) return;
    const r = await src.api('/api/quarantine', { type, value, reason: 'quarantined from the incidents view' });
    toast(`Quarantine written as ledger #${r.seq}${r.lessonSeq !== null ? `; learned lesson #${r.lessonSeq}` : ''}.`);
    await src.refresh();
    render();
  } catch (e) {
    toast(e.message);
  }
}

const STATUS = { open: 'rec', quarantined: 'bad', 'auto-quarantined': 'bad', dismissed: 'plain' };

function render() {
  const s = src.state;
  $('modebar').replaceChildren(modeBar(src, render));
  $('incidents').replaceChildren(
    ...(s.incidents.length === 0 ? [el('p', { class: 'empty' }, 'No incidents.')] : []),
    ...s.incidents.map((i) =>
      el(
        'div',
        { class: 'item' },
        el('div', { class: 'item-head' }, el('span', { class: `pill plain ${STATUS[i.status] ?? ''}` }, i.status.replace('-', ' ')), el('span', { class: 'mono small' }, `score ${i.score}`), el('code', {}, short(i.objectId, 18))),
        el('p', {}, i.rules.map((r) => r.split(':')[0]).filter((v, k, a) => a.indexOf(v) === k).join(' · ')),
        i.lessonMatches.length ? el('p', { style: 'color:var(--gold-hi)' }, `Learned · lesson ${[...new Set(i.lessonMatches.map((m) => '#' + m.lessonSeq))].join(', ')}`) : null,
        i.status === 'open'
          ? el('div', {}, el('button', { class: 'btn btn-gold btn-sm', onclick: () => quarantine('source', i.objectId) }, 'Quarantine'))
          : i.quarantineSeq !== undefined
            ? el('p', { class: 'muted small' }, `Ledger #${i.quarantineSeq}`)
            : null,
      ),
    ),
  );
  const excluded = s.nodes.filter((n) => !n.eligible);
  $('forensic').replaceChildren(
    ...(excluded.length === 0 && s.failed.length === 0 ? [el('p', { class: 'empty' }, 'Nothing excluded.')] : []),
    ...excluded.map((n) =>
      el(
        'div',
        { class: 'item' },
        el('div', { class: 'item-head' }, el('span', { class: 'tag q' }, n.quarantined ? `quarantined #${n.seedHits.join(', #')}` : n.unresolved ? 'unresolved lineage' : n.cls), el('span', { class: 'mono small muted' }, `${n.lane} · ${n.kind}`), el('code', {}, short(n.id, 14))),
        el('div', { class: 'quote' }, n.text.split('\n').slice(0, 3).join('\n').slice(0, 220)),
      ),
    ),
    ...s.failed.map((f) => el('div', { class: 'item' }, el('div', { class: 'item-head' }, el('span', { class: 'tag unverified' }, f.code), el('code', {}, short(f.blobId, 16))), el('p', {}, f.reason))),
  );
}

$('q-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('q-value').value.trim();
  if (!v) return toast('Enter an object id, envelope id or turn id.');
  quarantine($('q-type').value, v);
});

(async () => {
  try {
    src = await loadSource();
    render();
  } catch {
    $('incidents').replaceChildren(el('p', { class: 'empty' }, 'No data source. Start the daemons with antibody up.'));
  }
})();
