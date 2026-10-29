import { el, short, plural } from '../../ui.js';
import { head, card, command } from '../kit.js';

let rebuildDigest = null;
let rebuilding = false;
let revokeLane = 'wallet-objects';

export default {
  id: 'keys',
  path: '/app/keys',
  title: 'Keys',
  icon: 'keys',
  render(ctx) {
    const src = ctx.src;
    const s = src.state;
    const l = s.ledger;
    const recorded = src.mode === 'recorded';
    const rd = recorded ? (src.steps.slice(0, src.index + 1).reverse().find((x) => x.rebuildDigest && x.state.digest === s.digest)?.rebuildDigest ?? null) : rebuildDigest;

    const rebuild = el('button', { class: 'btn btn-primary btn-sm', type: 'button', ...(rebuilding ? { disabled: true } : {}) }, rebuilding ? 'Rebuilding…' : 'Rebuild --fresh');
    rebuild.addEventListener('click', () => {
      if (recorded) {
        const i = src.steps.findIndex((x) => x.rebuildDigest);
        src.setIndex(i);
        ctx.rerender();
        return ctx.toast(`Recorded rebuild from chapter ${i + 1}: a fresh process with an empty cache.`);
      }
      ctx.act(async () => {
        rebuilding = true;
        ctx.rerender();
        try {
          const r = await src.api('/api/rebuild', {});
          rebuildDigest = r.digest ?? null;
          await src.refresh();
          ctx.toast(`Rebuilt ${plural(r.memories ?? 0, 'memory')} from Walrus + Sui in ${r.ms ?? '?'} ms.`);
        } finally {
          rebuilding = false;
          ctx.rerender();
        }
      });
    });

    const laneSel = el('select', { 'aria-label': 'Lane to revoke', style: 'height:40px;font-size:14px' }, ...['user', 'agent', 'wallet-objects'].map((x) => el('option', { value: x, ...(x === revokeLane ? { selected: true } : {}) }, `antibody:${x}`)));
    laneSel.addEventListener('change', () => ((revokeLane = laneSel.value), ctx.rerender()));

    return el(
      'div',
      { style: 'display:grid;gap:16px' },
      head('Lane', 'keys.', 'Four delegate keys, one per lane, registered on the MemWal account on Sui. Revoking one is forward-only.'),
      el(
        'div',
        { class: 'grid-main' },
        card(
          'Lanes',
          el('span', { class: 'pill plain' }, `${s.lanes.filter((x) => x.status === 'active').length} / ${s.lanes.length} active`),
          ...s.lanes.map((x) => el('div', { class: 'lane' }, el('span', { class: 'name' }, x.label), el('span', { class: `pill plain ${x.status === 'active' ? 'ok' : 'bad'}` }, x.status), el('span', { class: 'key' }, x.pub))),
        ),
        el(
          'div',
          { style: 'display:grid;gap:16px' },
          el(
            'section',
            { class: 'card glow' },
            el('div', { class: 'card-title' }, el('h3', {}, 'Restoration'), rd ? el('span', { class: `pill ${rd === s.digest ? 'ok' : 'bad'}` }, rd === s.digest ? 'match' : 'mismatch') : null),
            el('dl', { class: 'kv' }, el('dt', {}, 'live'), el('dd', {}, el('code', {}, s.digest)), el('dt', {}, 'rebuild'), el('dd', {}, rd ? el('code', {}, rd) : el('span', { class: 'muted' }, 'not run yet'))),
            el('div', { style: 'margin-top:16px' }, rebuild),
          ),
          card('Revoke a lane', null, el('div', { style: 'display:grid;gap:10px' }, laneSel, el('p', { class: 'hint' }, 'Needs the owner wallet. Everything that key signed after the revocation checkpoint is excluded; a new key takes over.'), command(`antibody revoke --lane ${revokeLane} --rotate`))),
        ),
      ),
      l.ok && (l.revocations.length || l.rotations.length)
        ? card('History', null, el('div', { class: 'row-list' }, ...[...l.revocations.map((r) => ['r', `revoked ${r.lane}`, r]), ...l.rotations.map((r) => ['g', `rotated ${r.lane}`, r])].map(([d, t, r]) => el('div', { class: 'row-i' }, el('span', { class: `dot ${d}` }), el('span', { class: 'grow' }, `${t} · ${short(r.pub, 14)}`), el('span', { class: 'meta' }, `#${r.seq}`)))))
        : null,
    );
  },
};
