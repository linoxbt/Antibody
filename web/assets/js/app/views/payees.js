import { el } from '../../ui.js';
import { head, card, command, amount, shortAddr, avatar, usd } from '../kit.js';

const CANONICAL = /^0x[0-9a-f]{64}$/;
let draft = { label: '', address: '', coin: 'USDC', cap: '' };

/** Shell-safe single-quoting for the generated command. */
const q = (s) => (/^[A-Za-z0-9._:-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

export default {
  id: 'payees',
  path: '/app/payees',
  title: 'Payees',
  icon: 'payees',
  render(ctx) {
    const s = ctx.state;
    const l = s.ledger;
    const payees = l.ok ? l.payees : [];

    const out = el('div', {});
    const hint = el('p', { class: 'hint' });
    const field = (key, label, { full = false, ...attrs } = {}) => {
      const i = el('input', { value: draft[key], autocomplete: 'off', spellcheck: 'false', ...attrs });
      i.addEventListener('input', () => ((draft[key] = i.value), update()));
      return el('label', { class: full ? 'full' : '' }, label, i);
    };
    // Sandbox: the server holds this world's (simulated) user key, so adding is a button.
    const addBtn = (disabled) =>
      el('button', {
        class: 'btn btn-primary', type: 'button', ...(disabled ? { disabled: true } : {}),
        onclick: () =>
          ctx.act(async () => {
            const r = await ctx.src.api('/api/sandbox/payee', { label: draft.label.trim(), address: draft.address.trim(), cap: draft.cap.trim() });
            draft = { label: '', address: '', coin: 'USDC', cap: '' };
            await ctx.src.refresh();
            ctx.toast(`Payee signed into your ledger as #${r.seq}.`);
            ctx.rerender();
          }),
      }, 'Add payee');
    function update() {
      const addr = draft.address.trim();
      const problems = [];
      if (!draft.label.trim()) problems.push('a label');
      if (!CANONICAL.test(addr)) problems.push('a canonical address (0x + 64 lowercase hex; names are never resolved)');
      if (!/^\d+(\.\d+)?$/.test(draft.cap.trim())) problems.push('a per-payment cap');
      hint.textContent = problems.length ? `Needs ${problems.join(', ')}.` : s.sandbox ? 'Signed into your sandbox ledger with its user lane key.' : 'Run this where your user key lives. You confirm the last six characters of the address before it is signed.';
      hint.className = `hint${problems.length && (draft.label || draft.address || draft.cap) ? ' err' : ''}`;
      if (s.sandbox) return out.replaceChildren(addBtn(problems.length > 0));
      out.replaceChildren(problems.length ? el('pre', { class: 'quote', style: 'opacity:.5' }, 'antibody payee add --label … --address 0x… --coin USDC --cap …') : command(`antibody payee add --label ${q(draft.label.trim())} --address ${addr} --coin ${q(draft.coin.trim() || 'USDC')} --cap ${draft.cap.trim()}`));
    }
    update();

    return el(
      'div',
      { style: 'display:grid;gap:16px' },
      head('Signed', 'payees.', 'Steward can only pay addresses on this list, up to each cap. The list lives in the ledger, signed by your user key.'),
      l.ok
        ? card(
            'Payees',
            el('span', { class: 'pill plain' }, `${payees.length} active`),
            payees.length
              ? el(
                  'div',
                  { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Table, scrolls sideways' },
                  el(
                    'table',
                    { class: 'table' },
                    el('thead', {}, el('tr', {}, el('th', {}, 'Payee'), el('th', {}, 'Address'), el('th', {}, 'Cap per payment'), el('th', {}, 'Signed'), el('th', {}, ''))),
                    el(
                      'tbody',
                      {},
                      ...payees.map((p) =>
                        el(
                          'tr',
                          {},
                          el('td', { class: 'nowrap' }, el('span', { style: 'display:inline-flex;align-items:center;gap:10px;color:var(--text)' }, avatar(p.address, true), p.label)),
                          el('td', { class: 'nowrap' }, el('code', { title: p.address }, shortAddr(p.address))),
                          el('td', { class: 'nowrap' }, amount(p.capPerTx, p.coinType), ' ', usd(amount(p.capPerTx, p.coinType).split(' ')[0], p.coinType.split('::').at(-1), s.rates)),
                          el('td', { class: 'mono nowrap' }, `ledger #${p.seq}`),
                          el('td', { class: 'nowrap' }, s.sandbox ? null : el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: (e) => (e.currentTarget.replaceWith(command(`antibody payee remove ${p.payeeId}`)), undefined) }, 'Remove…')),
                        ),
                      ),
                    ),
                  ),
                )
              : el('p', { class: 'empty' }, 'No payees yet. Until you add one, every payment is blocked.'),
          )
        : card('Payees', el('span', { class: 'pill bad' }, l.code), el('p', { class: 'empty' }, 'The ledger does not verify, so no payee is trusted and every payment is blocked.')),
      el(
        'div',
        { class: 'grid-2' },
        el('section', { class: 'card glow' }, el('div', { class: 'card-title' }, el('h3', {}, 'Add a payee')), el('div', { class: 'form-grid' }, field('label', 'Label', { placeholder: 'landlord' }), field('cap', 'Cap per payment', { placeholder: '500', inputmode: 'decimal' }), field('address', 'Address', { placeholder: '0x…', full: true }), field('coin', 'Coin', { placeholder: 'USDC' })), el('div', { style: 'margin-top:14px;display:grid;gap:10px' }, out, hint)),
        s.sandbox
          ? card('In your own install', null, el('p', { class: 'hint', style: 'font-size:14.5px;line-height:1.6' }, 'Payees are signed with the user lane key. Here the sandbox server holds a simulated one for you. On your own install that key never leaves your machine, so a payee can only be added from your terminal.'))
          : card(
          'Why not a button?',
          null,
          el('p', { class: 'hint', style: 'font-size:14.5px;line-height:1.6' }, 'Payees are the one thing Steward must never be talked into. They are signed with the user lane key, which stays on your machine and never touches this console, the model, or the control process.'),
          el('p', { class: 'hint', style: 'font-size:14.5px;line-height:1.6;margin-top:10px' }, 'A compromised console can therefore show you a payee, but never create one.'),
        ),
      ),
    );
  },
};
