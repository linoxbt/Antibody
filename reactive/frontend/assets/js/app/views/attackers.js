import { el } from '../../ui.js';
import { head, stat, card } from '../kit.js';
import { loopsOf, secs } from '../../guard.js';
import { addr, chainName, ruleName } from './common.js';

export default {
  id: 'attackers',
  path: '/app/attackers',
  title: 'Attackers',
  icon: 'incidents',
  render(ctx) {
    const s = ctx.state;
    const lessons = s.guard?.lessons ?? [];
    const loops = loopsOf(s);
    return el(
      'div',
      { style: 'display:grid;gap:16px' },
      head('Known', 'attackers.', 'Every address quarantined on any watched vault is a lesson in GuardReactive: it is quarantined on every other vault, and a vault watched later is immunized with it.'),
      el('section', { class: 'stat-row' }, stat('Lessons', String(lessons.length), 'in GuardReactive on Lasna'), stat('Vaults', String((s.vaults ?? []).length), 'each blocks every lesson')),
      card(
        'Lessons',
        null,
        lessons.length
          ? el(
              'div',
              { class: 'feed' },
              ...lessons.map((a, i) => {
                const seen = loops.filter((l) => l.subject && l.subject.toLowerCase() === a.toLowerCase());
                return el(
                  'div',
                  { class: 'item' },
                  el('div', { class: 'item-head' }, el('span', { class: 'mono' }, `#${i + 1}`), addr(s, 'baseSepolia', a), el('span', { class: 'pill plain bad' }, 'quarantined')),
                  seen.length
                    ? el('p', { class: 'small muted', style: 'margin:6px 0 0' }, seen.map((l) => `${ruleName(l.rule)} on ${chainName(l.destChain)} (${secs(l.seconds)})`).join(' · '))
                    : el('p', { class: 'small muted', style: 'margin:6px 0 0' }, 'learned before the current indexing window'),
                );
              }),
            )
          : el('p', { class: 'empty' }, 'No attacker seen yet.'),
      ),
    );
  },
};
