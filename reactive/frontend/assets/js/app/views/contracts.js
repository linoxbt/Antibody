import { el } from '../../ui.js';
import { head, card } from '../kit.js';
import { addr, chainName, ext } from './common.js';

export default {
  id: 'contracts',
  path: '/app/contracts',
  title: 'Contracts',
  icon: 'keys',
  render(ctx) {
    const s = ctx.state;
    const c = s.evidence?.contracts;
    const row = (name, chain, a, verified, note) => el('tr', {}, el('td', {}, name), el('td', { class: 'nowrap' }, chainName(chain)), el('td', { class: 'mono nowrap' }, addr(s, chain, a)), el('td', { class: 'nowrap' }, verified ? ext(verified, 'Sourcify ✓') : el('span', { class: 'muted' }, '—')), el('td', { class: 'muted' }, note ?? ''));
    return el(
      'div',
      { style: 'display:grid;gap:16px' },
      head('The', 'contracts.', 'Every contract is verified on Sourcify (exact match). Earlier versions stay deployed as the record of each build phase.'),
      card(
        'Current',
        null,
        c
          ? el(
              'div',
              { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Table, scrolls sideways' },
              el(
                'table',
                { class: 'table' },
                el('thead', {}, el('tr', {}, ...['Contract', 'Chain', 'Address', 'Source', 'Role'].map((h) => el('th', {}, h)))),
                el('tbody', {}, ...c.current.map((x) => row(x.name, x.chain, x.address, x.verified, x.role))),
              ),
            )
          : el('p', { class: 'empty' }, 'The contract list comes with the recorded evidence.'),
      ),
      c
        ? card(
            'History',
            null,
            el(
              'div',
              { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Table, scrolls sideways' },
              el('table', { class: 'table' }, el('thead', {}, el('tr', {}, ...['Contract', 'Chain', 'Address', 'Source', 'Status'].map((h) => el('th', {}, h)))), el('tbody', {}, ...c.history.map((x) => row(x.name, x.chain, x.address, x.verified, x.status)))),
            ),
          )
        : null,
      card(
        'Keys',
        null,
        el('p', { class: 'small muted', style: 'margin:0' }, 'All testnet. The owner deploys and configures; the agent key can only propose payments; the scorer key can only report to the RiskOracle. None of them is in the repository.'),
      ),
    );
  },
};
