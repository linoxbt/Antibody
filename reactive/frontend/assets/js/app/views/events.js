import { el } from '../../ui.js';
import { head, card, shortAddr } from '../kit.js';
import { CODES } from '../../guard.js';
import { chainName, tx, ruleName } from './common.js';

const TAG = { PaymentRefused: 'q', Quarantined: 'q', Frozen: 'q', PaymentExecuted: 'trusted', Decision: 'derived', Lesson: 'untrusted', RiskReported: 'untrusted' };

function detail(e) {
  const a = e.args ?? {};
  switch (e.name) {
    case 'PaymentRefused': return `refused: ${e.refusal ?? CODES[Number(a.code)]} · to ${shortAddr(a.to)}`;
    case 'PaymentExecuted': return `paid to ${shortAddr(a.to)}`;
    case 'PaymentProposed': return `to ${shortAddr(a.to)}`;
    case 'Quarantined': case 'Released': return shortAddr(a.account);
    case 'RiskReported': return `${shortAddr(a.subject)} · score ${a.score} · ${a.reason ?? ''}`;
    case 'Decision': return `${ruleName(e.rule ?? a.rule)}${a.subject && !/^0x0+$/.test(a.subject) ? ` · ${shortAddr(a.subject)}` : ''}`;
    case 'Lesson': return shortAddr(a.account);
    default: return '';
  }
}

export default {
  id: 'events',
  path: '/app/events',
  title: 'Events',
  icon: 'ledger',
  render(ctx) {
    const s = ctx.state;
    const rows = s.events ?? [];
    return el(
      'div',
      { style: 'display:grid;gap:16px' },
      head('Recent', 'events.', 'The vaults on Base Sepolia and Ethereum Sepolia, the RiskOracle, and GuardReactive on Lasna, as the Guard service reads them.'),
      card(
        'Newest first',
        null,
        rows.length
          ? el(
              'div',
              { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Table, scrolls sideways' },
              el('table', { class: 'table' }, el('thead', {}, el('tr', {}, ...['Chain', 'Event', 'Details', 'Transaction'].map((h) => el('th', {}, h)))), el('tbody', {}, ...rows.slice(0, 60).map((e) => el('tr', {}, el('td', { class: 'nowrap' }, chainName(e.chain)), el('td', {}, el('span', { class: `tag ${TAG[e.name] ?? 'record'}` }, e.name)), el('td', {}, detail(e)), el('td', { class: 'nowrap' }, tx(s, e.chain, e.tx)))))),
            )
          : el('p', { class: 'empty' }, s.live ? 'No events in the indexing window yet.' : 'Live events need the Guard service; the recorded loops are under Loops.'),
      ),
    );
  },
};
