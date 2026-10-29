import { el } from '../../ui.js';
import { head, card, command, avatar } from '../kit.js';
import { signOut } from '../../data.js';

function resetBtn(ctx) {
  const b = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Reset sandbox');
  b.addEventListener('click', () =>
    ctx.act(async () => {
      if (!confirm('Reset your sandbox? Its ledger, memories and keys are replaced with a fresh household.')) return;
      b.disabled = true;
      await ctx.src.api('/api/sandbox/reset', {});
      await ctx.src.refresh();
      ctx.toast('Fresh sandbox ready.');
      ctx.rerender();
    }),
  );
  return b;
}

const DEP_NAMES = { relayer: 'Walrus Memory relayer', chain: 'Sui RPC', 'chain-crosscheck': 'Second Sui RPC' };
const ago = (t) => (t ? new Date(t).toLocaleString() : 'never');

function healthList(h) {
  const deps = Object.entries(h.deps ?? {});
  if (!deps.length) return el('p', { class: 'hint' }, 'No network calls yet (or a simulated backend, where nothing leaves this machine).');
  return el('dl', { class: 'kv-card' }, ...deps.flatMap(([k, d]) => [el('dt', {}, DEP_NAMES[k] ?? k), el('dd', {}, d.ok ? `ok · last answer ${ago(d.lastOkAt)}` : `failing ${d.failures}× after retries · ${d.lastError ?? ''} · since ${ago(d.lastErrorAt)}`)]));
}

export default {
  id: 'settings',
  path: '/app/settings',
  title: 'Settings',
  icon: 'settings',
  render(ctx) {
    const s = ctx.state;
    const recorded = ctx.src.mode === 'recorded';
    const sess = ctx.session;
    const kv = (...pairs) => el('dl', { class: 'kv-card' }, ...pairs.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
    const code = (v) => (v ? el('code', {}, v) : el('span', { class: 'muted' }, '—'));
    const out = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, recorded ? 'Leave the demo' : 'Sign out');
    out.addEventListener('click', async () => {
      await signOut();
      location.replace('/login?signedout=1');
    });

    return el(
      'div',
      { style: 'display:grid;gap:16px' },
      head('Settings', null, 'This session and the node behind it.'),
      el(
        'div',
        { class: 'grid-2' },
        card(
          'Session',
          out,
          recorded
            ? kv(['Mode', 'Recorded demo · read-only'], ['Data', 'demo.json, recorded from the offline run (simulated)'], ['Live', el('span', {}, 'Run ', el('code', {}, 'antibody up'), ' and sign in with the owner wallet.')])
            : kv(
                ['Signed in with', sess?.method === 'wallet' ? 'Owner wallet (Sui personal message)' : 'Operator link'],
                ['Address', sess?.address ? el('span', { style: 'display:inline-flex;gap:10px;align-items:center' }, avatar(sess.address, true), el('code', {}, sess.address)) : el('span', { class: 'muted' }, 'none (operator)')],
                ['Expires', sess?.expiresAt ? new Date(sess.expiresAt).toLocaleString() : '—'],
              ),
        ),
        card(
          'Node',
          el('span', { class: `pill ${s.simulated ? 'rec' : 'live'}` }, s.simulated ? 'simulated' : 'mainnet'),
          kv(['Backend', s.backend], ['Chain reads', s.chain], ['Delegate set', s.crossCheck ? `cross-checked with ${s.crossCheck.secondary}${s.crossCheck.agreed === false ? ' (DISAGREES: payments blocked)' : ''}` : 'single reader (set ANTIBODY_CROSSCHECK_RPC_URL for a second)'], ['Account', code(s.account.id)], ['Owner', code(s.account.owner)], ['Steward wallet', code(s.wallet)], ['Checkpoint', String(s.checkpoint)]),
        ),
      ),
      !recorded && s.health ? card('Connections', el('span', { class: `pill ${s.health.degraded ? 'bad' : 'live'}` }, s.health.degraded ? 'degraded' : 'healthy'), healthList(s.health)) : null,
      s.banners?.length ? card('Notices', null, ...s.banners.map((b) => el('p', { class: 'hint', style: 'font-size:14px' }, b.replace(/━+/g, '').trim()))) : null,
      s.sandbox ? card('Sandbox', null, el('div', { style: 'display:grid;gap:12px;justify-items:start' }, el('p', { class: 'hint', style: 'font-size:14px' }, 'Your own simulated Antibody, owned by your wallet. Reset it to start the story again with fresh keys.'), resetBtn(ctx))) : card('Command line', null, el('div', { style: 'display:grid;gap:10px' }, el('p', { class: 'hint' }, 'Everything here is also available from the CLI.'), command('antibody status'), command('antibody login'))),
    );
  },
};
