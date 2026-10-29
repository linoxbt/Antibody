import { el, short } from '../../ui.js';
import { head, stat, card } from '../kit.js';

const TYPE_TAG = { genesis: 'record', 'payee.add': 'trusted', 'payee.remove': 'trusted', quarantine: 'q', 'quarantine.release': 'trusted', lesson: 'record', 'lane.revoke': 'q', 'lane.rotate': 'derived' };
let filter = 'all';

function summary(r) {
  const p = r.payload;
  switch (r.type) {
    case 'genesis': return `Account ${short(p.account, 12)} · owner ${short(p.owner, 12)} · ${p.lanes.length} lanes`;
    case 'payee.add': return `${p.label} → ${short(p.address, 16)} · cap ${p.capPerTx}`;
    case 'payee.remove': return `remove ${p.payeeId}`;
    case 'quarantine': return `${p.seed.type} ${short(p.seed.value, 16)}${p.auto ? ' · automatic' : ''} — ${p.reason}`;
    case 'quarantine.release': return `release #${p.quarantineSeq} — ${p.reason}`;
    case 'lesson': return `from quarantine #${p.fromSeq} · ${p.indicators.senders.length} sender · ${p.indicators.packages.length} package · ${p.indicators.keywords.length} words`;
    default: return `${p.label ?? ''} ${short(p.pub, 12)} · tx ${short(p.digest, 10)}`;
  }
}

export default {
  id: 'ledger',
  path: '/app/ledger',
  title: 'Ledger',
  icon: 'ledger',
  render(ctx) {
    const l = ctx.state.ledger;
    if (!l.ok) {
      return el('div', { style: 'display:grid;gap:16px' }, head('The', 'ledger.'), el('section', { class: 'stat-row' }, stat('Ledger', l.code, 'fail closed: every payment is blocked')), card('Why', null, el('p', { class: 'empty' }, l.detail)));
    }
    const types = ['all', ...new Set(l.records.map((r) => r.type))];
    const chips = el('div', { class: 'chips' }, ...types.map((t) => el('button', { class: 'chip', type: 'button', 'aria-pressed': String(t === filter), style: t === filter ? 'border-color:var(--line-accent);color:var(--text);background:var(--accent-wash)' : '', onclick: () => ((filter = t), ctx.rerender()) }, t)));
    const rows = l.records.filter((r) => filter === 'all' || r.type === filter).slice().reverse();

    return el(
      'div',
      { style: 'display:grid;gap:16px' },
      head('The', 'ledger.', 'Hash-chained control records on Walrus. Rebuilt and verified on every read.'),
      el(
        'section',
        { class: 'stat-row' },
        stat('Head', `#${l.head.seq}`, short(l.head.hash, 20)),
        stat('Payees', String(l.payees.length)),
        stat('Quarantines', String(l.quarantines.filter((q) => !q.released).length), `${l.quarantines.filter((q) => q.auto).length} automatic`),
        stat('Lessons', String(l.lessons.filter((x) => x.active).length)),
      ),
      card(
        'Records',
        chips,
        el(
          'div',
          { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Table, scrolls sideways' },
          el(
            'table',
            { class: 'table' },
            el('thead', {}, el('tr', {}, el('th', {}, 'Seq'), el('th', {}, 'Type'), el('th', {}, 'Signed by'), el('th', {}, 'Record'), el('th', {}, 'Walrus blob'))),
            el('tbody', {}, ...rows.map((r) => el('tr', {}, el('td', { class: 'mono' }, `#${r.seq}`), el('td', {}, el('span', { class: `tag ${TYPE_TAG[r.type] ?? 'record'}` }, r.type)), el('td', { class: 'mono muted nowrap' }, `antibody:${r.lane === 'antibody' ? 'control' : r.lane}`), el('td', {}, summary(r)), el('td', { class: 'nowrap' }, el('code', { title: r.blobId }, short(r.blobId, 12)))))),
          ),
        ),
      ),
      card(
        'Lessons',
        el('span', { class: 'pill rec plain' }, 'learned from quarantines'),
        l.lessons.length
          ? el('div', { class: 'feed' }, ...l.lessons.map((x) => el('div', { class: 'item' }, el('div', { class: 'item-head' }, el('strong', {}, `Lesson #${x.seq}`), el('span', { class: `pill plain ${x.active ? 'ok' : 'bad'}` }, x.active ? 'active' : 'retired'), el('span', { class: 'muted small' }, `from quarantine #${x.fromSeq}`)), el('p', { class: 'muted' }, `senders ${x.indicators.senders.map((v) => short(v, 10)).join(', ') || '—'} · packages ${x.indicators.packages.map((v) => short(v, 10)).join(', ') || '—'}`))))
          : el('p', { class: 'empty' }, 'Nothing learned yet.'),
      ),
    );
  },
};
