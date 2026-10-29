import { mountShell, modeBar } from '../shell.js';
import { loadSource } from '../data.js';
import { $, el, short } from '../ui.js';

mountShell('ledger');
let src;

const TYPE_TAG = { genesis: 'record', 'payee.add': 'trusted', 'payee.remove': 'trusted', quarantine: 'q', 'quarantine.release': 'trusted', lesson: 'record', 'lane.revoke': 'q', 'lane.rotate': 'derived' };

function summary(r) {
  const p = r.payload;
  switch (r.type) {
    case 'genesis': return `Account ${short(p.account, 12)} · owner ${short(p.owner, 12)} · ${p.lanes.length} lanes`;
    case 'payee.add': return `${p.label} → ${short(p.address, 16)} · cap ${p.capPerTx}`;
    case 'payee.remove': return `remove ${p.payeeId}`;
    case 'quarantine': return `${p.seed.type} ${short(p.seed.value, 16)}${p.auto ? ' · automatic' : ''} — ${p.reason}`;
    case 'quarantine.release': return `release #${p.quarantineSeq} — ${p.reason}`;
    case 'lesson': return `from quarantine #${p.fromSeq} · ${p.indicators.senders.length} sender · ${p.indicators.packages.length} package · ${p.indicators.keywords.length} words`;
    default: return `${p.label} ${short(p.pub, 12)} · tx ${short(p.digest, 10)}`;
  }
}

function stat(k, v, sub) {
  return el('div', { class: 'stat' }, el('span', { class: 'kicker' }, k), el('div', { class: 'v' }, v), sub ? el('div', { class: 'sub' }, sub) : null);
}

function render() {
  const s = src.state;
  $('modebar').replaceChildren(modeBar(src, render));
  const l = s.ledger;
  if (!l.ok) {
    $('stats').replaceChildren(stat('Ledger', l.code, 'fail closed: every payment is blocked'));
    $('records').replaceChildren(el('p', { class: 'empty' }, l.detail));
    return;
  }
  $('stats').replaceChildren(
    stat('Head', `#${l.head.seq}`, short(l.head.hash, 20)),
    stat('Payees', String(l.payees.length), 'user-signed'),
    stat('Quarantines', String(l.quarantines.filter((q) => !q.released).length), `${l.quarantines.filter((q) => q.auto).length} automatic`),
    stat('Lessons', String(l.lessons.filter((x) => x.active).length), l.firstSync ? 'first sync on this machine' : 'rollback guard armed'),
  );
  $('records').replaceChildren(
    el(
      'table',
      { class: 'table' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Seq'), el('th', {}, 'Type'), el('th', {}, 'Signed by'), el('th', {}, 'Record'), el('th', {}, 'Walrus blob'))),
      el('tbody', {}, ...l.records.map((r) => el('tr', {}, el('td', { class: 'mono' }, `#${r.seq}`), el('td', {}, el('span', { class: `tag ${TYPE_TAG[r.type] ?? 'record'}` }, r.type)), el('td', { class: 'mono muted nowrap' }, `antibody:${r.lane === 'antibody' ? 'control' : r.lane}`), el('td', {}, summary(r)), el('td', { class: 'nowrap' }, el('code', {}, short(r.blobId, 12)))))),
    ),
  );
  $('payees').replaceChildren(
    l.payees.length
      ? el('table', { class: 'table' }, el('thead', {}, el('tr', {}, el('th', {}, 'Payee'), el('th', {}, 'Address'), el('th', {}, 'Cap (base units)'))), el('tbody', {}, ...l.payees.map((p) => el('tr', {}, el('td', {}, p.label), el('td', {}, el('code', {}, short(p.address, 18))), el('td', { class: 'mono' }, p.capPerTx)))))
      : el('p', { class: 'empty' }, 'No payees yet.'),
  );
  $('lessons').replaceChildren(
    ...(l.lessons.length === 0 ? [el('p', { class: 'empty' }, 'Nothing learned yet. Confirm a quarantine and Antibody learns from it.')] : []),
    el(
      'div',
      { class: 'feed' },
      ...l.lessons.map((x) =>
        el(
          'div',
          { class: 'item' },
          el('div', { class: 'item-head' }, el('strong', {}, `Lesson #${x.seq}`), el('span', { class: `pill plain ${x.active ? 'ok' : 'bad'}` }, x.active ? 'active' : 'retired'), el('span', { class: 'muted small' }, `from quarantine #${x.fromSeq}`)),
          el('p', {}, `Senders: ${x.indicators.senders.map((v) => short(v, 12)).join(', ') || '—'}`),
          el('p', {}, `Packages: ${x.indicators.packages.map((v) => short(v, 12)).join(', ') || '—'}`),
          el('p', { class: 'muted' }, `Words: ${x.indicators.keywords.slice(0, 10).join(' · ') || '—'}`),
        ),
      ),
    ),
  );
}

(async () => {
  try {
    src = await loadSource();
    render();
  } catch {
    $('records').replaceChildren(el('p', { class: 'empty' }, 'No data source. Start the daemons with antibody up.'));
  }
})();
