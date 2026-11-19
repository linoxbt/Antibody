import { el } from '../../ui.js';
import { head, stat, card } from '../kit.js';
import { loopsOf, median, secs } from '../../guard.js';
import { loopTable, ruleName, RULE_TAG } from './common.js';

let filter = 'all';

export default {
  id: 'loops',
  path: '/app/loops',
  title: 'Loops',
  icon: 'memory',
  render(ctx) {
    const s = ctx.state;
    const all = loopsOf(s);
    const rules = ['all', ...new Set(all.map((l) => l.rule))];
    const rows = all.filter((l) => filter === 'all' || l.rule === filter);
    const timed = all.filter((l) => l.origin?.tx && typeof l.seconds === 'number').map((l) => l.seconds).sort((a, b) => a - b);
    const chips = el('div', { class: 'chips' }, ...rules.map((r) => el('button', { class: 'chip', type: 'button', 'aria-pressed': String(r === filter), style: r === filter ? 'border-color:var(--line-accent);color:var(--text);background:var(--accent-wash)' : '', onclick: () => ((filter = r), ctx.rerender()) }, r === 'all' ? 'all' : ruleName(r))));
    return el(
      'div',
      { style: 'display:grid;gap:16px' },
      head('Every', 'loop.', 'Each row is one decision by GuardReactive on Reactive Lasna, linked to the transaction that caused it and the callback that carried it out. Time runs from the origin’s block to the callback’s block.'),
      el(
        'section',
        { class: 'stat-row' },
        stat('Loops', String(all.length), `${s.liveLoops?.length ?? 0} live · ${s.recorded?.length ?? 0} recorded`),
        stat('Median', timed.length ? secs(median(timed)) : '—', 'origin → callback'),
        stat('Fastest', timed.length ? secs(timed[0]) : '—', 'Base Sepolia makes 5 blocks a second'),
        stat('Slowest', timed.length ? secs(timed.at(-1)) : '—', 'Ethereum Sepolia: 12-second blocks'),
      ),
      card('Origin → reaction → callback', chips, rows.length ? loopTable(s, rows) : el('p', { class: 'empty' }, 'No loops of this kind yet.')),
    );
  },
};
export { RULE_TAG };
