import { el } from '../../ui.js';
import { head, stat, card, icon, shortAddr } from '../kit.js';
import { loopsOf, secs, median } from '../../guard.js';
import { chainName, ruleName } from './common.js';

/** What GuardReactive knows about one attacker, from the loops the service has indexed. */
export function attackerSummary(s, address) {
  const a = address.toLowerCase();
  const seen = loopsOf(s).filter((l) => l.subject && l.subject.toLowerCase() === a);
  // how it was caught: the earliest decision that was not a lesson learned elsewhere
  const caught = [...seen].sort((x, y) => (x.reactive?.ts ?? 0) - (y.reactive?.ts ?? 0)).find((l) => l.rule !== 'CrossChainQuarantine') ?? null;
  const done = seen.filter((l) => l.callback?.tx);
  const vaults = new Set(done.map((l) => `${l.destChain}:${String(l.vault ?? l.callback.tx).toLowerCase()}`));
  const times = done.map((l) => l.seconds).filter((x) => x !== null && x !== undefined);
  return { seen, caught, vaults: vaults.size, median: median(times) };
}

export default {
  id: 'attackers',
  path: '/app/attackers',
  title: 'Attackers',
  icon: 'incidents',
  render(ctx) {
    const s = ctx.state;
    const lessons = s.guard?.lessons ?? [];
    const total = (s.vaults ?? []).length;
    return el(
      'div',
      { style: 'display:grid;gap:16px' },
      head('Known', 'attackers.', 'Every address quarantined on any watched vault is a lesson in GuardReactive: it is quarantined on every other vault, and a vault watched later is immunized with it. Open an attacker to see where it is blocked.'),
      el('section', { class: 'stat-row' }, stat('Lessons', String(lessons.length), 'in GuardReactive on Lasna'), stat('Vaults', String(total), 'each blocks every lesson')),
      card(
        'Lessons',
        null,
        lessons.length
          ? el(
              'div',
              { class: 'row-list' },
              ...lessons.map((a, i) => {
                const x = attackerSummary(s, a);
                const how = x.caught ? `${ruleName(x.caught.rule)} on ${chainName(x.caught.destChain)}` : x.seen.length ? 'Learned elsewhere' : 'Learned before the indexing window';
                const reach = x.vaults ? `on ${x.vaults} vault${x.vaults === 1 ? '' : 's'}${x.median !== null ? ` · ${secs(x.median)}` : ''}` : '';
                return el(
                  'a',
                  { class: 'row-i attacker-row', href: `/app/attackers/${a}`, 'data-nav': '', 'aria-label': `Attacker ${a}` },
                  el('span', { class: 'mono muted' }, `#${i + 1}`),
                  el('span', { class: 'grow attacker-main' }, el('span', { class: 'mono' }, shortAddr(a)), el('span', { class: 'attacker-how' }, how)),
                  reach ? el('span', { class: 'meta attacker-reach' }, reach) : null,
                  el('span', { class: 'pill plain bad' }, 'quarantined'),
                  el('span', { class: 'chev', 'aria-hidden': 'true' }, icon('chevron')),
                );
              }),
            )
          : el('p', { class: 'empty' }, 'No attacker seen yet.'),
      ),
    );
  },
};
