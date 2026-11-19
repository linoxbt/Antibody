// Activity: everything agents and people do with Antibody Guard, live. Calls through the hosted MCP endpoint,
// the npm MCP server, the SDK, the API and this site, merged with what happened on-chain. The text of scored
// messages is never shown (it is never recorded); nor are IP addresses.
import { el } from '../../ui.js';
import { head, stat, card, shortAddr } from '../kit.js';
import { txLink } from '../../guard.js';
import { chainName, ext } from './common.js';

let filter = 'all';
const VIA = { mcp: 'MCP · hosted', 'mcp-local': 'MCP · npm', api: 'API', sdk: 'SDK', site: 'Site' };
const ON_CHAIN = new Set(['PaymentProposed', 'PaymentExecuted', 'PaymentRefused', 'Quarantined', 'Frozen', 'Unfrozen', 'Released', 'Remembered', 'MemoryRefused', 'Forgotten', 'RiskReported', 'Lesson', 'Watching', 'PayeeChangeRequested', 'PayeeActivated']);

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(iso).toLocaleDateString();
}

function subjectEl(s, sub) {
  if (!sub) return null;
  if (sub.kind === 'address') return el('a', { href: `/app/attackers/${sub.address}`, 'data-nav': '', class: 'mono' }, shortAddr(sub.address));
  if (sub.kind === 'memory') return el('span', {}, 'memory ', el('a', { href: '/app/memory', 'data-nav': '', class: 'mono' }, shortAddr(sub.address)), sub.id ? ` #${sub.id}` : '', sub.source ? el('span', {}, ' · source ', el('a', { href: `/app/attackers/${sub.source}`, 'data-nav': '', class: 'mono' }, shortAddr(sub.source))) : null);
  return el('span', {}, chainName(sub.chain), ' ', el('span', { class: 'mono' }, shortAddr(sub.address)));
}

/** One on-chain event as a feed row. */
function chainRow(s, e) {
  const a = e.args ?? {};
  const who = a.account ?? a.subject ?? a.to ?? a.source ?? null;
  const text = {
    PaymentProposed: 'the agent proposed a payment', PaymentExecuted: 'paid', PaymentRefused: `refused${e.refusal ? `: ${e.refusal}` : ''}`,
    Quarantined: 'quarantined', Frozen: 'frozen', Unfrozen: 'unfrozen', Released: 'released', Remembered: `memory #${a.id} written`, MemoryRefused: 'memory write refused',
    Forgotten: `memory #${a.id} forgotten`, RiskReported: `AI risk report, score ${a.score}`, Lesson: 'a new lesson in GuardReactive', Watching: 'GuardReactive started watching',
    PayeeChangeRequested: 'payee requested', PayeeActivated: 'payee activated',
  }[e.name] ?? e.name;
  const bad = ['PaymentRefused', 'Quarantined', 'Frozen', 'MemoryRefused', 'RiskReported', 'Lesson'].includes(e.name);
  return {
    t: e.ts * 1000,
    node: el(
      'div',
      { class: 'row-i act-row' },
      el('span', { class: 'act-time muted' }, ago(new Date(e.ts * 1000).toISOString())),
      el('span', { class: 'pill plain rec act-via' }, 'on-chain'),
      el('span', { class: 'grow attacker-main' }, el('span', {}, el('b', {}, e.name), ' · ', chainName(e.chain), who ? el('span', {}, ' · ', el('a', { href: `/app/attackers/${who}`, 'data-nav': '', class: 'mono' }, shortAddr(who))) : null), el('span', { class: 'attacker-how' }, text)),
      ext(txLink(s.explorers, e.chain, e.tx), 'tx'),
    ),
  };
}

/** One call (MCP, API, SDK, site) as a feed row. */
function callRow(s, a) {
  return {
    t: new Date(a.at).getTime(),
    node: el(
      'div',
      { class: 'row-i act-row' },
      el('span', { class: 'act-time muted' }, ago(a.at)),
      el('span', { class: `pill plain ${a.via.startsWith('mcp') ? 'ok' : 'rec'} act-via` }, VIA[a.via] ?? a.via),
      el('span', { class: 'grow attacker-main' },
        el('span', {}, el('b', {}, a.client), ' · ', el('span', { class: 'mono' }, a.tool), a.subject ? el('span', {}, ' · ', subjectEl(s, a.subject)) : null),
        el('span', { class: `attacker-how act-${a.tone}` }, a.result, a.error ? ` · ${a.error}` : ''),
      ),
      a.tx ? ext(txLink(s.explorers, a.tx.chain, a.tx.hash), 'tx') : null,
    ),
  };
}

export default {
  id: 'activity',
  path: '/app/activity',
  title: 'Activity',
  icon: 'ledger',
  render(ctx) {
    const s = ctx.state;
    const calls = s.activity ?? [];
    const events = (s.events ?? []).filter((e) => ON_CHAIN.has(e.name));
    const rows = [
      ...(filter === 'chain' ? [] : calls.filter((a) => filter !== 'mcp' || a.via.startsWith('mcp')).map((a) => callRow(s, a))),
      ...(filter === 'all' || filter === 'chain' ? events.map((e) => chainRow(s, e)) : []),
    ].sort((x, y) => y.t - x.t).slice(0, 80);
    const byMcp = calls.filter((a) => a.via.startsWith('mcp')).length;
    const clients = new Set(calls.map((a) => a.client)).size;
    const chip = (id, text) => {
      const b = el('button', { class: `chip${filter === id ? ' on' : ''}`, type: 'button', 'aria-pressed': String(filter === id) }, text);
      b.addEventListener('click', () => ((filter = id), ctx.rerender()));
      return b;
    };
    return el(
      'div',
      { style: 'display:grid;gap:16px' },
      head('Agent', 'activity.', 'Everything agents and people do with Antibody Guard, live: calls through MCP (in Claude, Cursor, any client), the SDK, the API and this site, next to what happened on-chain. Scored messages are never shown, only their verdict.'),
      el('section', { class: 'stat-row' }, stat('Calls', String(calls.length), 'since the service last started'), stat('Through MCP', String(byMcp), 'hosted endpoint and npm server'), stat('Clients', String(clients), 'Claude, Cursor, SDK, curl, …')),
      card(
        'Live feed',
        el('div', { class: 'chips', style: 'display:flex;gap:6px;flex-wrap:wrap' }, chip('all', 'All'), chip('mcp', 'MCP'), chip('calls', 'Calls'), chip('chain', 'On-chain')),
        rows.length ? el('div', { class: 'row-list' }, ...rows.map((r) => r.node)) : el('p', { class: 'empty' }, 'Nothing yet. Ask Claude something through the Antibody Guard connector, and it appears here.'),
        el('p', { class: 'hint' }, 'Updates every 10 seconds. The feed is kept in memory and starts again when the service restarts; on-chain events are permanent.'),
      ),
    );
  },
};
