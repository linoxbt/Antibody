// One attacker: how it was caught, where it is blocked (read from each vault just now), and every decision.
import { el } from '../../ui.js';
import { head, stat, card, icon, shortAddr } from '../kit.js';
import { secs, addrLink } from '../../guard.js';
import { chainName, ruleName, ruleText, loopTable, ext } from './common.js';
import { attackerSummary } from './attackers.js';

const RPC = { baseSepolia: 'https://sepolia.base.org', sepolia: 'https://ethereum-sepolia-rpc.publicnode.com' };
const QUARANTINED = '0x7abb7002'; // quarantined(address)
const cache = new Map(); // `${vault}:${address}` -> { at, value }

/** vault.quarantined(address), straight from the chain (cached for a minute). */
async function quarantinedOn(chain, vault, address) {
  const k = `${vault}:${address}`.toLowerCase();
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  let value = null;
  try {
    const data = QUARANTINED + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    const res = await fetch(RPC[chain], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: vault, data }, 'latest'] }), signal: AbortSignal.timeout(8000) });
    const j = await res.json();
    if (typeof j.result === 'string') value = BigInt(j.result) !== 0n;
  } catch {
    value = null;
  }
  cache.set(k, { at: Date.now(), value });
  return value;
}

export const isAttackerPath = (path) => /^\/app\/attackers\/0x[0-9a-fA-F]{40}$/.test(path.replace(/\/+$/, ''));

export default {
  id: 'attacker',
  parent: 'attackers',
  path: '/app/attackers/:address',
  title: 'Attacker',
  icon: 'incidents',
  async render(ctx) {
    const s = ctx.state;
    const address = location.pathname.replace(/\/+$/, '').split('/').pop();
    const known = (s.guard?.lessons ?? []).some((a) => a.toLowerCase() === address.toLowerCase());
    const x = attackerSummary(s, address);
    // every contract GuardReactive guards: the vaults and the memories (both answer quarantined(address))
    const vaults = [...(s.vaults ?? []), ...(s.memories ?? []).map((m) => ({ ...m, memory: true }))];
    const status = await Promise.all(vaults.map((v) => quarantinedOn(v.chain, v.address, address)));
    const blocked = status.filter((b) => b === true).length;
    const back = el('a', { class: 'btn btn-ghost btn-sm', href: '/app/attackers', 'data-nav': '' }, icon('back'), 'All attackers');
    const timeline = [...x.seen].sort((a, b) => (b.reactive?.ts ?? 0) - (a.reactive?.ts ?? 0));

    return el(
      'div',
      { style: 'display:grid;gap:16px' },
      head('Attacker', shortAddr(address), known ? 'A lesson in GuardReactive: quarantined on every watched vault, on every chain, and on every vault watched later.' : 'This address is not a lesson in GuardReactive.', back),
      el(
        'section',
        { class: 'stat-row' },
        stat('Caught by', x.caught ? ruleName(x.caught.rule) : 'Learned elsewhere', x.caught ? `on ${chainName(x.caught.destChain)}` : 'before the indexing window'),
        stat('Blocked on', `${blocked} of ${vaults.length}`, 'vaults and memories, read from each chain just now'),
        stat('Spread', x.median !== null ? secs(x.median) : '—', 'median, origin to callback'),
      ),
      x.caught ? card('How it was caught', null, el('p', { class: 'muted', style: 'margin:0' }, ruleText(x.caught.rule))) : null,
      card(
        'Address',
        null,
        el('p', { class: 'mono', style: 'margin:0 0 10px;word-break:break-all' }, address),
        el('div', { style: 'display:flex;gap:14px;flex-wrap:wrap' }, ext(addrLink(s.explorers, 'baseSepolia', address), 'Base Sepolia explorer'), ext(addrLink(s.explorers, 'sepolia', address), 'Ethereum Sepolia explorer')),
      ),
      card(
        'Where it is blocked',
        el('span', { class: 'pill plain rec' }, 'on-chain'),
        el(
          'div',
          { class: 'row-list' },
          ...vaults.map((v, i) =>
            el(
              'div',
              { class: 'row-i' },
              el('span', { class: `dot ${status[i] === true ? 'g' : status[i] === false ? 'r' : 'y'}` }),
              el('span', { class: 'grow' }, `${chainName(v.chain)} · `, ext(addrLink(s.explorers, v.chain, v.address), shortAddr(v.address)), v.memory ? el('span', { class: 'muted' }, ' (memory)') : null, v.kind === 'demo' ? el('span', { class: 'muted' }, ' (demo)') : null),
              el('span', { class: 'meta' }, status[i] === true ? 'quarantined' : status[i] === false ? 'not quarantined' : 'could not read'),
            ),
          ),
        ),
      ),
      card('Every decision', el('span', { class: 'muted small' }, `${timeline.length} in the indexing window`), timeline.length ? loopTable(s, timeline) : el('p', { class: 'empty' }, 'No decision about this address in the current indexing window (the last two hours, plus the recorded phases).')),
    );
  },
};
