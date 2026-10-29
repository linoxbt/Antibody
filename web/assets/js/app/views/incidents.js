import { el, short, plural } from '../../ui.js';
import { head, card, command, shortAddr } from '../kit.js';

const STATUS = { open: 'rec', quarantined: 'bad', 'auto-quarantined': 'bad', dismissed: 'plain' };
let form = { type: 'source', value: '' };

async function quarantine(ctx, type, value, reason) {
  const src = ctx.src;
  const pv = await src.api('/api/preview', { type, value });
  if (!confirm(`Quarantine ${type} ${value}?\n\n${plural(pv.memories - pv.decisions, 'memory')} and ${plural(pv.decisions, 'decision')} leave Steward's context. They stay on Walrus as evidence.`)) return;
  const r = await src.api('/api/quarantine', { type, value, reason });
  ctx.toast(`Quarantine written as ledger #${r.seq}${r.lessonSeq !== null ? `; learned lesson #${r.lessonSeq}` : ''}.`);
  await src.refresh();
  ctx.rerender();
}

export default {
  id: 'incidents',
  path: '/app/incidents',
  title: 'Incidents',
  icon: 'incidents',
  render(ctx) {
    const s = ctx.state;
    const qs = s.ledger.ok ? s.ledger.quarantines.filter((q) => !q.released) : [];
    const excluded = s.nodes.filter((n) => !n.eligible);

    const type = el('select', { 'aria-label': 'Seed type' }, ...[['source', 'Source object'], ['memory', 'Memory'], ['turn', 'Turn']].map(([v, t]) => el('option', { value: v, ...(v === form.type ? { selected: true } : {}) }, t)));
    type.addEventListener('change', () => (form.type = type.value));
    const value = el('input', { placeholder: '0x… or envelope id', 'aria-label': 'Seed value', value: form.value, autocomplete: 'off', spellcheck: 'false' });
    value.addEventListener('input', () => (form.value = value.value));
    const qForm = el('form', { style: 'display:grid;gap:10px' }, type, value, el('button', { class: 'btn btn-primary', type: 'submit' }, 'Preview and quarantine'));
    qForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!form.value.trim()) return value.focus();
      ctx.act(() => quarantine(ctx, form.type, form.value.trim(), 'quarantined from the console'));
    });

    return el(
      'div',
      { style: 'display:grid;gap:16px' },
      head('Incidents,', 'contained.', 'The sentinel scores what lands in the wallet. Quarantine excludes a source and everything it reached; nothing is deleted.'),
      el(
        'div',
        { class: 'grid-main' },
        card(
          'Sentinel',
          el('span', { class: 'pill plain' }, `${s.incidents.length} raised`),
          s.incidents.length
            ? el(
                'div',
                { class: 'feed' },
                ...s.incidents.map((i) =>
                  el(
                    'div',
                    { class: 'item' },
                    el('div', { class: 'item-head' }, el('span', { class: `pill plain ${STATUS[i.status] ?? ''}` }, i.status.replace('-', ' ')), el('span', { class: 'mono small' }, `score ${i.score}`), el('code', { title: i.objectId }, shortAddr(i.objectId))),
                    el('p', {}, [...new Set(i.rules.map((r) => r.split(':')[0]))].join(' · ')),
                    i.lessonMatches.length ? el('p', { style: 'color:var(--accent-hi)' }, `Caught by lesson ${[...new Set(i.lessonMatches.map((m) => '#' + m.lessonSeq))].join(', ')}`) : null,
                    i.status === 'open'
                      ? el('div', {}, el('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => ctx.act(() => quarantine(ctx, 'source', i.objectId, 'quarantined from the incidents view')) }, 'Quarantine source'))
                      : i.quarantineSeq !== undefined
                        ? el('p', { class: 'muted small' }, `Ledger #${i.quarantineSeq}`)
                        : null,
                  ),
                ),
              )
            : el('p', { class: 'empty' }, 'Nothing suspicious has landed in the wallet.'),
        ),
        el(
          'div',
          { style: 'display:grid;gap:16px' },
          el('section', { class: 'card glow' }, el('div', { class: 'card-title' }, el('h3', {}, 'Quarantine')), qForm),
          card(
            'Active quarantines',
            null,
            qs.length
              ? el('div', { class: 'row-list' }, ...qs.map((q) => el('div', { class: 'row-i' }, el('span', { class: 'dot r' }), el('span', { class: 'grow' }, `#${q.seq} · ${q.seed.type} ${short(q.seed.value, 12)}`), el('span', { class: 'meta' }, q.auto ? 'auto' : 'manual'))))
              : el('p', { class: 'empty' }, 'None.'),
            qs.length ? el('div', { style: 'margin-top:12px;display:grid;gap:8px' }, el('p', { class: 'hint' }, 'Releasing is a human decision, signed with your user key:'), command(`antibody release ${qs[0].seq} --reason "reviewed: safe"`)) : null,
          ),
        ),
      ),
      card(
        'Excluded · kept as evidence',
        el('span', { class: 'pill plain' }, `${excluded.length + s.failed.length}`),
        excluded.length || s.failed.length
          ? el(
              'div',
              { class: 'feed' },
              ...excluded.map((n) => el('div', { class: 'item' }, el('div', { class: 'item-head' }, el('span', { class: 'tag q' }, n.quarantined ? `quarantined #${n.seedHits.join(', #')}` : n.unresolved ? 'unresolved lineage' : n.cls), el('span', { class: 'mono small muted' }, `${n.lane} · ${n.kind}`), el('a', { href: `/app/memory?node=${encodeURIComponent(n.id)}`, 'data-nav': '' }, el('code', {}, short(n.id, 14)))), el('div', { class: 'quote' }, n.text.split('\n').slice(0, 3).join('\n').slice(0, 220)))),
              ...s.failed.map((f) => el('div', { class: 'item' }, el('div', { class: 'item-head' }, el('span', { class: 'tag unverified' }, f.code), el('code', {}, short(f.blobId, 16))), el('p', {}, f.reason))),
            )
          : el('p', { class: 'empty' }, 'Nothing excluded.'),
      ),
    );
  },
};
