// Shared pieces for the Guard console views.
import { el } from '../../ui.js';
import { CHAIN, RULE, secs, txLink, addrLink } from '../../guard.js';
import { shortAddr } from '../kit.js';

export const ext = (href, text, cls = '') => (href ? el('a', { href, target: '_blank', rel: 'noopener', class: cls }, text) : el('span', { class: 'muted' }, text));
export const tx = (s, chain, hash, text) => ext(txLink(s.explorers, chain, hash), text ?? shortAddr(hash ?? ''));
export const addr = (s, chain, a) => ext(addrLink(s.explorers, chain, a), shortAddr(a ?? ''));
export const chainName = (c) => CHAIN[c] ?? c ?? '';
export const ruleName = (r) => (RULE[r] ?? [r])[0];
export const ruleText = (r) => (RULE[r] ?? ['', ''])[1];
export const RULE_TAG = { UnknownRecipient: 'q', AiRisk: 'q', CrossChainQuarantine: 'untrusted', RepeatedRefusals: 'q', Burst: 'q', PayeeVeto: 'derived', ScheduledPayment: 'trusted', Retry: 'record' };

/** One loop as a table row: rule, subject, destination, origin → reaction → callback, time. */
export function loopRow(s, l) {
  return el(
    'tr',
    {},
    el('td', {}, el('span', { class: `tag ${RULE_TAG[l.rule] ?? 'record'}` }, ruleName(l.rule)), l.source === 'recorded' ? el('span', { class: 'muted small' }, ' recorded') : null),
    el('td', { class: 'mono nowrap' }, l.subject ? shortAddr(l.subject) : el('span', { class: 'muted' }, 'vault')),
    el('td', { class: 'nowrap' }, chainName(l.destChain)),
    el('td', { class: 'nowrap' }, l.origin?.tx ? tx(s, l.origin.chain, l.origin.tx, 'origin') : el('span', { class: 'muted' }, l.rule === 'ScheduledPayment' ? 'CRON' : 'owner call')),
    el('td', { class: 'nowrap' }, tx(s, 'lasna', l.reactive?.tx, 'reaction')),
    el('td', { class: 'nowrap' }, l.callback?.tx ? tx(s, l.destChain, l.callback.tx, 'callback') : el('span', { class: 'muted' }, 'on its way')),
    el('td', { class: 'mono nowrap' }, secs(l.seconds)),
  );
}

export function loopTable(s, rows) {
  return el(
    'div',
    { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Table, scrolls sideways' },
    el('table', { class: 'table' }, el('thead', {}, el('tr', {}, ...['Rule', 'Subject', 'Vault on', 'Origin', 'Reaction · Lasna', 'Callback', 'Time'].map((h) => el('th', {}, h)))), el('tbody', {}, ...rows.map((l) => loopRow(s, l)))),
  );
}
