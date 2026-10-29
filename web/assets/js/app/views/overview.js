import { el } from '../../ui.js';
import { icon, stat, card, navLink, shortAddr, decisionVerdict, usd } from '../kit.js';

/** The proposal a decision memory recorded: amount, coin symbol, recipient, label. */
export function proposal(n) {
  const m = /pay (\S+) \(\d+ base units\) of \S+::(\w+) to (0x[0-9a-f]+) labelled "([^"]*)"/.exec(n.text);
  const x402 = /Proposal \(x402 /.test(n.text);
  return m ? { amount: m[1], symbol: m[2], to: m[3], label: m[4], x402 } : null;
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** Sandbox only: drop the next poisoned coin on this visitor's Steward and let the sentinel see it. */
function attackButton(ctx) {
  const b = el('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Send a poisoned coin');
  b.addEventListener('click', () =>
    ctx.act(async () => {
      b.disabled = true;
      try {
        const r = await ctx.src.api('/api/sandbox/attack', {});
        await ctx.src.refresh();
        const inc = r.items[0]?.incident;
        ctx.toast(`${r.coin.name} landed in Steward's wallet: ${inc ? (inc.status === 'auto-quarantined' ? 'a lesson caught it and quarantined it.' : 'the sentinel flagged it. Now ask Steward to pay rent.') : 'observed.'}`, 6000);
        ctx.rerender();
      } finally {
        b.disabled = false;
      }
    }),
  );
  return b;
}

export default {
  id: 'overview',
  path: '/app',
  title: 'Overview',
  icon: 'overview',
  render(ctx) {
    const s = ctx.state;
    const eligible = s.nodes.filter((n) => n.eligible).length;
    const open = s.incidents.filter((i) => i.status === 'open');
    const qs = s.ledger.ok ? s.ledger.quarantines.filter((q) => !q.released) : [];
    const decisions = s.nodes.filter((n) => n.kind === 'decision').slice(-5).reverse();
    const healthy = s.ledger.ok && s.lanes.every((l) => l.status === 'active');

    const rb = ctx.src.mode === 'recorded' ? ctx.src.steps.slice(0, ctx.src.index + 1).reverse().find((x) => x.rebuildDigest && x.state.digest === s.digest)?.rebuildDigest : null;

    return el(
      'div',
      { style: 'display:grid;gap:16px' },
      el(
        'div',
        { class: 'view-head greet' },
        el(
          'div',
          {},
          el('h1', {}, `${greeting()}.`, ' ', el('span', { class: 'tail' }, healthy ? 'Steward is guarded.' : 'Payments are held.')),
          el('div', { class: 'health' }, el('span', { class: `dot ${healthy ? 'g' : 'r'}` }), healthy ? `Ledger #${s.ledger.head.seq} verified · ${s.lanes.length} lanes active · checkpoint ${s.checkpoint}` : s.ledger.ok ? 'A lane is revoked: rotate it from Keys.' : `Ledger unreadable (${s.ledger.code}): every payment is blocked until it verifies.`),
        ),
        el('div', { class: 'actions' }, s.sandbox ? attackButton(ctx) : null, navLink('/app/steward', 'Run Steward', `btn ${s.sandbox ? 'btn-ghost' : 'btn-primary'} btn-sm`)),
      ),
      el(
        'section',
        { class: 'stat-row', 'aria-label': 'Status' },
        stat('Ledger', s.ledger.ok ? `#${s.ledger.head.seq}` : s.ledger.code, s.ledger.ok ? `${s.ledger.records.length} records` : 'fail closed'),
        stat('Memory', `${eligible} in context`, `${s.nodes.length - eligible} excluded`),
        stat('Payees', s.ledger.ok ? String(s.ledger.payees.length) : '—', s.ledger.ok ? s.ledger.payees.map((p) => p.label).join(', ') || 'none yet' : ''),
        stat('Incidents', String(open.length), open.length ? 'awaiting review' : `${qs.length} quarantined`),
      ),
      el(
        'div',
        { class: 'grid-main' },
        card(
          'Recent decisions',
          navLink('/app/memory', 'Lineage →', 'small muted'),
          decisions.length
            ? el(
                'div',
                { class: 'row-list' },
                ...decisions.map((n) => {
                  const v = decisionVerdict(n);
                  const p = proposal(n);
                  const ok = v.startsWith('ALLOW');
                  return el(
                    'a',
                    { class: 'row-i', href: `/app/memory?node=${encodeURIComponent(n.id)}`, 'data-nav': '' },
                    el('span', { class: `dot ${ok ? 'g' : 'r'}` }),
                    el('span', { class: 'grow' }, p ? `${p.amount} ${p.symbol} → ${p.label} ` : 'payment ', p ? el('span', { class: 'muted' }, shortAddr(p.to)) : null),
                    p ? usd(p.amount, p.symbol, s.rates) : null,
                    p?.x402 ? el('span', { class: 'tag record' }, 'x402') : null,
                    el('span', { class: `pill plain ${ok ? 'ok' : 'bad'}` }, ok ? 'allowed' : v.replace('BLOCK ', '').toLowerCase().replaceAll('_', ' ')),
                  );
                }),
              )
            : el('p', { class: 'empty' }, 'No payments decided yet.'),
        ),
        el(
          'div',
          { style: 'display:grid;gap:16px' },
          card(
            'Restoration',
            rb ? el('span', { class: `pill ${rb === s.digest ? 'ok' : 'bad'}` }, rb === s.digest ? 'match' : 'mismatch') : null,
            el('dl', { class: 'kv' }, el('dt', {}, 'digest'), el('dd', {}, el('code', {}, `${s.digest.slice(0, 20)}…`)), el('dt', {}, 'coverage'), el('dd', {}, `${s.coverage.retrieved} / ${s.coverage.inventory} blobs`)),
            el('div', { style: 'margin-top:14px' }, navLink('/app/keys', 'Rebuild and compare →', 'small muted')),
          ),
          card(
            'Sentinel',
            navLink('/app/incidents', 'All →', 'small muted'),
            s.incidents.length
              ? el('div', { class: 'row-list' }, ...s.incidents.slice(0, 3).map((i) => el('a', { class: 'row-i', href: '/app/incidents', 'data-nav': '' }, el('span', { class: `dot ${i.status === 'open' ? 'y' : 'r'}` }), el('span', { class: 'grow' }, `${shortAddr(i.objectId)} · ${i.status.replace('-', ' ')}`), el('span', { class: 'meta' }, `score ${i.score}`))))
              : el('p', { class: 'empty' }, 'Nothing suspicious in the wallet.'),
          ),
        ),
      ),
      el(
        'div',
        { class: 'actions-grid' },
        ...[
          ['/app/steward', 'steward', 'Ask Steward', 'Run an instruction beside an unprotected agent.'],
          ['/app/memory', 'memory', 'Trace a memory', 'See what a poisoned source reached.'],
          ['/app/payees', 'payees', 'Manage payees', 'Only signed payees can be paid.'],
        ].map(([href, ic, t, d]) => el('a', { class: 'action', href, 'data-nav': '' }, icon(ic), el('b', {}, t), el('span', {}, d))),
      ),
    );
  },
};
