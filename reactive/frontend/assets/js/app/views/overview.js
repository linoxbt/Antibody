import { el } from '../../ui.js';
import { icon, stat, card, navLink, shortAddr } from '../kit.js';
import { loopsOf, median, secs } from '../../guard.js';
import { chainName, ruleName, ruleText, tx } from './common.js';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default {
  id: 'overview',
  path: '/app',
  title: 'Overview',
  icon: 'overview',
  render(ctx) {
    const s = ctx.state;
    const loops = loopsOf(s);
    const timed = loops.filter((l) => l.origin?.tx && typeof l.seconds === 'number').map((l) => l.seconds);
    const frozen = (s.vaults ?? []).filter((v) => v.frozen);
    const debt = Number(s.guard?.debt ?? 0) > 0;
    const status = !s.live
      ? 'Showing the recorded evidence: the Guard service is not answering right now.'
      : debt
        ? 'GuardReactive owes fees on Lasna: it will not react until its debt is settled.'
        : frozen.length
          ? `Frozen: ${frozen.map((v) => chainName(v.chain)).join(' and ')}. Only the owner can unfreeze.`
          : `${s.vaults.length} vaults active · GuardReactive watching ${s.guard.chains} chains · ${s.guard.lessons.length} known attackers · updated ${new Date(s.updatedAt).toLocaleTimeString()}`;
    return el(
      'div',
      { style: 'display:grid;gap:16px' },
      el(
        'div',
        { class: 'view-head greet' },
        el('div', {}, el('h1', {}, `${greeting()}.`, ' ', el('span', { class: 'tail' }, frozen.length ? 'A vault is frozen.' : 'The agent is guarded.')), el('div', { class: 'health' }, el('span', { class: `dot ${!s.live ? 'b' : debt || frozen.length ? 'r' : 'g'}` }), status)),
        el('div', { class: 'actions' }, navLink('/app/scorer', 'Try the AI scorer', 'btn btn-primary btn-sm')),
      ),
      el(
        'section',
        { class: 'stat-row', 'aria-label': 'Status' },
        stat('Vaults', `${(s.vaults ?? []).length - frozen.length} of ${(s.vaults ?? []).length} active`, (s.vaults ?? []).map((v) => chainName(v.chain)).join(' · ')),
        stat('Known attackers', String(s.guard?.lessons?.length ?? 0), 'quarantined on every vault'),
        stat('Median time', timed.length ? secs(median(timed)) : '—', `origin block → callback block · ${timed.length} loops`),
        stat('GuardReactive', s.live ? (debt ? 'in debt' : 'healthy') : 'recorded', s.live ? `${Number(s.guard.reserves).toFixed(3)} lREACT reserves` : 'Reactive Lasna'),
      ),
      el(
        'div',
        { class: 'grid-main' },
        card(
          'Recent loops',
          navLink('/app/loops', 'All loops →', 'small muted'),
          loops.length
            ? el(
                'div',
                { class: 'row-list' },
                ...loops.slice(0, 7).map((l) =>
                  el(
                    'a',
                    { class: 'row-i', href: '/app/loops', 'data-nav': '', title: ruleText(l.rule) },
                    el('span', { class: `dot ${l.rule === 'ScheduledPayment' ? 'g' : l.rule === 'PayeeVeto' || l.rule === 'CrossChainQuarantine' ? 'y' : 'r'}` }),
                    el('span', { class: 'grow' }, `${ruleName(l.rule)} `, el('span', { class: 'muted' }, l.subject ? shortAddr(l.subject) : 'vault'), ` · ${chainName(l.destChain)}`),
                    el('span', { class: 'meta' }, secs(l.seconds)),
                    el('span', { class: `pill plain ${l.callback?.tx ? 'ok' : 'rec'}` }, l.callback?.tx ? 'done' : 'pending'),
                  ),
                ),
              )
            : el('p', { class: 'empty' }, 'No loops yet.'),
        ),
        el(
          'div',
          { style: 'display:grid;gap:16px' },
          card(
            'Vaults',
            navLink('/app/vaults', 'Details →', 'small muted'),
            el('div', { class: 'row-list' }, ...(s.vaults ?? []).map((v) => el('a', { class: 'row-i', href: '/app/vaults', 'data-nav': '' }, el('span', { class: `dot ${v.frozen ? 'r' : v.frozen === false ? 'g' : 'b'}` }), el('span', { class: 'grow' }, chainName(v.chain)), el('span', { class: 'meta' }, v.balance !== null ? `${Number(v.balance).toFixed(4)} ETH` : 'recorded')))),
          ),
          card(
            'The AI',
            navLink('/app/scorer', 'Try it →', 'small muted'),
            s.evidence?.ai?.report
              ? el('p', { class: 'small', style: 'margin:0' }, 'Qwen scored a phishing email ', el('b', {}, `${s.evidence.ai.report.score}/100`), ' and reported its address; Reactive quarantined it on both vaults. ', tx(s, 'baseSepolia', s.evidence.ai.report.tx, 'Report →'))
              : el('p', { class: 'empty' }, 'The AI scorer reports to the RiskOracle; Reactive enforces.'),
          ),
        ),
      ),
      el(
        'div',
        { class: 'actions-grid' },
        ...[
          ['/app/loops', 'memory', 'Follow a loop', 'Origin → reaction on Lasna → callback, with timings.'],
          ['/app/attackers', 'incidents', 'Known attackers', 'Learned once, blocked on every chain.'],
          ['/app/scorer', 'steward', 'Try the AI scorer', 'Paste a message; watch Reactive act on it.'],
        ].map(([href, ic, t, d]) => el('a', { class: 'action', href, 'data-nav': '' }, icon(ic), el('b', {}, t), el('span', {}, d))),
      ),
    );
  },
};
