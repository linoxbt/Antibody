import { el, short, plural } from '../../ui.js';
import { head, card, command } from '../kit.js';
import { discoverWallets, connect, signMessage, signTransaction, cancelled } from '../../wallets.js';

let rebuildDigest = null;
let rebuilding = false;
let revokeLane = 'wallet-objects';
let walletName = null;
let revoking = null; // status text while the owner's wallet is busy
let lastRevoked = null; // lane revoked from this console, awaiting rotation
const found = [];
discoverWallets((ws) => found.splice(0, found.length, ...ws));

/** FR-16: the owner's wallet signs the removal; control records lane.revoke once the chain shows it. */
async function revokeWithWallet(ctx) {
  const src = ctx.src;
  const w = found.find((x) => x.name === walletName) ?? found[0];
  if (src.mode === 'recorded') return src.api(); // read-only demo: raises the standard notice
  if (!w) throw new Error('No Sui wallet detected in this browser. Install one, or use the command below.');
  if (!confirm(`Revoke antibody:${revokeLane}?\n\nThe owner wallet removes this lane's key on-chain. It is forward-only: memories that key already wrote stay readable to it. Steward's ${revokeLane} lane stops until you rotate in a new key.`)) return;
  const step = (t) => ((revoking = t), ctx.rerender());
  try {
    step('Preparing the owner transaction…');
    const p = await src.api('/api/revoke/prepare', { lane: revokeLane });
    step(`Connect the owner account in ${w.name}…`);
    const account = await connect(w);
    if (account.address.toLowerCase() !== p.owner.toLowerCase()) throw new Error(`Connect the account owner (${p.owner.slice(0, 8)}…${p.owner.slice(-4)}) in ${w.name}; it shared ${account.address.slice(0, 8)}….`);
    step(`Approve in ${w.name}…`);
    const signed = p.mode === 'message' ? { signature: await signMessage(w, account, p.message) } : await signTransaction(w, account, p.txBytes, p.chain);
    step(p.mode === 'message' ? 'Applying on the fixture chain…' : 'Submitting through Tatum and verifying on-chain…');
    const r = await src.api('/api/revoke/submit', { id: p.id, signature: signed.signature, ...(signed.bytes ? { bytes: signed.bytes } : {}) });
    lastRevoked = r.lane;
    await src.refresh();
    ctx.toast(`lane.revoke written as ledger #${r.seq}${r.simulated ? ' (simulated)' : ` · tx ${r.digest.slice(0, 10)}…`}. Quarantines unchanged.`);
  } catch (e) {
    if (cancelled(e)) ctx.toast('Cancelled in the wallet.');
    else throw e;
  } finally {
    revoking = null;
    ctx.rerender();
  }
}

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

    const activeLanes = s.lanes.filter((x) => x.status === 'active').map((x) => x.lane);
    const walletSel = () => {
      const sel = el('select', { 'aria-label': 'Wallet', style: 'height:40px;font-size:14px' }, ...found.map((w) => el('option', { value: w.name, ...(w.name === walletName ? { selected: true } : {}) }, w.name)));
      sel.addEventListener('change', () => ((walletName = sel.value), ctx.rerender()));
      return sel;
    };
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
          s.crossCheck
            ? el('p', { class: 'hint', style: 'margin:-6px 0 12px;display:flex;gap:8px;align-items:center' }, el('span', { class: `dot ${s.crossCheck.agreed ? 'g' : 'r'}` }), s.crossCheck.agreed ? `Delegate set confirmed by a second RPC (${s.crossCheck.secondary})` : `Second RPC disagrees: ${s.crossCheck.detail ?? 'unknown'}`)
            : null,
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
          card(
            'Revoke a lane',
            el('span', { class: 'pill plain' }, 'owner wallet'),
            el(
              'div',
              { style: 'display:grid;gap:10px' },
              laneSel,
              found.length > 1 ? walletSel() : null,
              el('button', { class: 'btn btn-primary', type: 'button', ...(revoking || !activeLanes.includes(revokeLane) ? { disabled: true } : {}), onclick: () => ctx.act(() => revokeWithWallet(ctx)) }, revoking ? 'Waiting…' : found.length ? `Revoke with ${(found.find((x) => x.name === walletName) ?? found[0]).name}` : 'Revoke with owner wallet'),
              revoking ? el('p', { class: 'hint', role: 'status' }, revoking) : el('p', { class: 'hint' }, activeLanes.includes(revokeLane) ? 'Writes signed by that key after the revocation checkpoint are excluded. Quarantines are untouched.' : `antibody:${revokeLane} has no active key. Rotate one in:`),
              !activeLanes.includes(revokeLane) || lastRevoked === revokeLane ? command(`antibody rotate --lane ${revokeLane}`) : el('details', {}, el('summary', { class: 'small muted', style: 'cursor:pointer' }, 'or from the command line'), el('div', { style: 'margin-top:10px' }, command(`antibody revoke --lane ${revokeLane} --rotate`))),
            ),
          ),
        ),
      ),
      l.ok && (l.revocations.length || l.rotations.length)
        ? card('History', null, el('div', { class: 'row-list' }, ...[...l.revocations.map((r) => ['r', `revoked ${r.lane}`, r]), ...l.rotations.map((r) => ['g', `rotated ${r.lane}`, r])].map(([d, t, r]) => el('div', { class: 'row-i' }, el('span', { class: `dot ${d}` }), el('span', { class: 'grow' }, `${t} · ${short(r.pub, 14)}`), el('span', { class: 'meta' }, `#${r.seq}`)))))
        : null,
    );
  },
};
