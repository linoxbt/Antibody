import { el } from '../../ui.js';
import { head, card } from '../kit.js';
import { addr, chainName } from './common.js';

export default {
  id: 'vaults',
  path: '/app/vaults',
  title: 'Vaults',
  icon: 'payees',
  render(ctx) {
    const s = ctx.state;
    return el(
      'div',
      { style: 'display:grid;gap:16px' },
      head('The', 'vaults.', 'Every vault GuardReactive watches: the two demo vaults and any visitor’s own (deploy yours under My vault). GuardVault holds the agent’s funds. The agent can only propose a payment; the rules pay or refuse it, and a refusal is an event, not a revert, so Reactive sees it.'),
      el(
        'div',
        { class: 'grid-2' },
        ...(s.vaults ?? []).map((v) =>
          card(
            `${chainName(v.chain)}${v.kind === 'community' ? ' · visitor’s vault' : ' · demo'}`,
            el('span', { class: `pill ${v.frozen ? 'bad' : v.frozen === false ? 'ok' : 'rec'}` }, v.frozen ? 'frozen' : v.frozen === false ? 'active' : 'recorded'),
            el(
              'dl',
              { class: 'kv-card' },
              el('dt', {}, 'GuardVault'), el('dd', {}, addr(s, v.chain, v.address)),
              el('dt', {}, 'chain id'), el('dd', { class: 'mono' }, String(v.chainId ?? '')),
              el('dt', {}, 'balance'), el('dd', {}, v.balance !== null ? `${Number(v.balance).toFixed(5)} ETH` : '—'),
              el('dt', {}, 'proposals'), el('dd', {}, v.proposals ?? '—'),
              el('dt', {}, 'guardian'), el('dd', {}, addr(s, 'lasna', v.guardian)),
              v.owner ? el('dt', {}, 'owner') : null, v.owner ? el('dd', {}, addr(s, v.chain, v.owner)) : null,
            ),
          ),
        ),
      ),
      card(
        'The rules, in order',
        null,
        el(
          'div',
          { class: 'table-wrap' },
          el(
            'table',
            { class: 'table' },
            el('tbody', {}, ...[
              ['Frozen', 'Every payment is refused until the owner unfreezes.'],
              ['Quarantined', 'The recipient is a known attacker.'],
              ['UnknownPayee', 'The recipient is not an active registered payee.'],
              ['LabelMismatch', 'The agent’s label is not the recipient’s registered label.'],
              ['OverCap', 'Above the payee’s per-payment cap.'],
              ['OverDailyLimit', 'Above what is left of today’s limit for that token.'],
              ['Duplicate', 'Same recipient, token and amount within ten minutes.'],
              ['TransferFailed', 'Every rule passed but the transfer failed: rolled back and refused.'],
            ].map(([c, d], i) => el('tr', {}, el('td', { class: 'mono nowrap' }, String(i + 1).padStart(2, '0')), el('td', {}, el('span', { class: 'tag q' }, c)), el('td', { class: 'muted' }, d)))),
          ),
        ),
        el('p', { class: 'hint', style: 'margin-top:12px' }, 'Adding or changing a payee waits for a timelock; removing one is immediate. A quarantined address can never be activated as a payee.'),
      ),
    );
  },
};
