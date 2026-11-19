// Public actions: anything here is permissionless on-chain, so any connected wallet may do it.
// One page per action; the semi-hamburger at the top right lists them.
import { el } from '../../ui.js';
import { head, card, shortAddr, icon, pageMenu } from '../kit.js';
import { loadWallet, walletIfLoaded, abi, CHAIN_ID, SYSTEM, label32, wei, isAddr, errorText } from '../../walletapi.js';
import { chainName, tx } from './common.js';

let busy = false;
const log = [];
const field = (id, placeholder) => el('input', { id, placeholder, autocomplete: 'off', style: 'width:100%;background:var(--glass);color:var(--text);border:1px solid var(--line-2);border-radius:12px;padding:9px 12px;font:14px var(--sans)' });
const val = (id) => document.getElementById(id)?.value?.trim() ?? '';
const row = (...kids) => el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center' }, ...kids);
const vaultSelect = (id, vaults) => el('select', { id, style: 'background:var(--glass);color:var(--text);border:1px solid var(--line-2);border-radius:10px;padding:8px;max-width:100%' }, ...vaults.map((v, i) => el('option', { value: String(i) }, `${chainName(v.chain)} · ${shortAddr(v.address)}${v.kind === 'demo' ? ' (demo)' : ''}`)));

/** The pages, in menu order: [path, title, one line]. */
const PAGES = [
  ['/app/actions/top-up', 'Top up GuardReactive', 'Add lREACT to the reserves that pay for every reaction'],
  ['/app/actions/retry', 'Retry a lost callback', 'Ask again for a freeze or quarantine that never landed'],
  ['/app/actions/activate-payee', 'Activate a due payee', 'Make a payee live once its delay has passed'],
];

async function act(ctx, what, fn) {
  if (busy) return;
  busy = true;
  try {
    const r = await fn();
    log.unshift({ what, ok: true, hash: r.hash, chain: r.chain });
    ctx.toast(`${what}: done`);
  } catch (e) {
    const msg = errorText(e);
    log.unshift({ what, ok: false, note: msg });
    ctx.toast(`${what}: ${msg}`);
  } finally {
    busy = false;
    log.splice(6);
    await ctx.src.refresh().catch(() => {});
    ctx.rerender();
  }
}

/** The frame every actions page shares: title, the page menu, the wallet prompt, and the recent actions. */
function frame(ctx, title, tail, sub, ...body) {
  const s = ctx.state;
  const connected = walletIfLoaded()?.account().connected;
  const h = head(title, tail, sub);
  h.classList.add('has-menu');
  h.append(pageMenu('Public actions', [['/app/actions', 'All public actions', 'What anyone may do, and why'], ...PAGES]));
  return el(
    'div',
    { style: 'display:grid;gap:16px' },
    h,
    !connected ? card('Connect a wallet', null, el('p', { class: 'muted', style: 'margin:0 0 12px' }, 'Each action is a plain transaction from your wallet.'), row((() => { const b = el('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Connect wallet'); b.addEventListener('click', async () => (await loadWallet()).open()); return b; })())) : null,
    ...body,
    log.length ? card('Recent actions', null, el('div', { class: 'row-list' }, ...log.map((l) => el('div', { class: 'row-i' }, el('span', { class: `dot ${l.ok ? 'g' : 'r'}` }), el('span', { class: 'grow' }, l.what, l.note ? el('span', { class: 'muted' }, ` · ${l.note}`) : null), l.hash ? tx(s, l.chain, l.hash, 'transaction') : null)))) : null,
  );
}

function button(ctx, text, fn) {
  const connected = walletIfLoaded()?.account().connected;
  const b = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', ...(busy ? { disabled: true } : {}) }, text);
  b.addEventListener('click', async () => (connected ? fn() : (await loadWallet()).open()));
  return b;
}

const sub = { parent: 'actions', icon: 'refresh' };

export const topUp = {
  ...sub,
  id: 'actions-top-up',
  path: '/app/actions/top-up',
  title: 'Top up GuardReactive',
  render(ctx) {
    const s = ctx.state;
    const guard = s.guard?.address;
    return frame(
      ctx,
      'Top',
      'up.',
      'GuardReactive pays for every reaction in lREACT. Anyone can add to its reserves.',
      card(
        'Top up GuardReactive',
        el('span', { class: 'pill plain rec' }, 'Reactive Lasna'),
        el('p', { class: 'muted', style: 'margin:0 0 12px' }, `Deposits go to its reserves through the system contract (depositTo). Reserves now: ${s.guard?.reserves ? Number(s.guard.reserves).toFixed(3) : '—'} lREACT.`),
        row(field('t-amt', 'lREACT, e.g. 0.2'), button(ctx, 'Deposit', () => act(ctx, `deposit ${val('t-amt')} lREACT`, async () => {
          const W = await loadWallet();
          const r = await W.write(CHAIN_ID.lasna, SYSTEM, [{ type: 'function', name: 'depositTo', stateMutability: 'payable', inputs: [{ name: 'contract', type: 'address' }], outputs: [] }], 'depositTo', [guard], wei(val('t-amt')));
          return { ...r, chain: 'lasna' };
        }))),
      ),
    );
  },
};

export const retry = {
  ...sub,
  id: 'actions-retry',
  path: '/app/actions/retry',
  title: 'Retry a lost callback',
  render(ctx) {
    const s = ctx.state;
    const guard = s.guard?.address;
    const vaults = s.vaults ?? [];
    const pick = (id) => vaults[Number(val(id) || 0)];
    return frame(
      ctx,
      'Retry a',
      'callback.',
      'Reactive Network does not retry callbacks. If a freeze or quarantine was requested but the vault never confirmed it within ten minutes, anyone can ask again.',
      card(
        'Retry a lost callback',
        el('span', { class: 'pill plain rec' }, 'Reactive Lasna'),
        el('div', { style: 'display:grid;gap:10px' },
          row(vaultSelect('r-vault', vaults), button(ctx, 'Retry freeze', () => act(ctx, 'retry freeze', async () => {
            const v = pick('r-vault');
            const r = await (await loadWallet()).write(CHAIN_ID.lasna, guard, await abi('GuardReactive'), 'retryFreeze', [BigInt(CHAIN_ID[v.chain]), v.address]);
            return { ...r, chain: 'lasna' };
          }))),
          row(field('r-acct', 'address to quarantine again 0x…'), button(ctx, 'Retry quarantine', () => act(ctx, 'retry quarantine', async () => {
            const v = pick('r-vault');
            if (!isAddr(val('r-acct'))) throw new Error('not an address');
            const r = await (await loadWallet()).write(CHAIN_ID.lasna, guard, await abi('GuardReactive'), 'retryQuarantine', [BigInt(CHAIN_ID[v.chain]), v.address, val('r-acct')]);
            return { ...r, chain: 'lasna' };
          }))),
          el('p', { class: 'hint' }, 'The contract refuses a retry that is not due, and the console checks first, so a wasted click costs nothing.'),
        ),
      ),
    );
  },
};

export const activatePayee = {
  ...sub,
  id: 'actions-activate-payee',
  path: '/app/actions/activate-payee',
  title: 'Activate a due payee',
  render(ctx) {
    const s = ctx.state;
    const vaults = s.vaults ?? [];
    const pick = (id) => vaults[Number(val(id) || 0)];
    return frame(
      ctx,
      'Activate a',
      'payee.',
      'A payee change takes effect after the vault’s delay, once someone activates it. Anyone may, so an owner does not have to come back.',
      card(
        'Activate a due payee',
        null,
        row(vaultSelect('a-vault', vaults), field('a-label', 'payee label'), button(ctx, 'Activate', () => act(ctx, `activate ${val('a-label')}`, async () => {
          const v = pick('a-vault');
          const r = await (await loadWallet()).write(CHAIN_ID[v.chain], v.address, await abi('GuardVault'), 'activatePayee', [label32(val('a-label'))]);
          return { ...r, chain: v.chain };
        }))),
      ),
    );
  },
};

export default {
  id: 'actions',
  path: '/app/actions',
  title: 'Public actions',
  icon: 'refresh',
  render(ctx) {
    return frame(
      ctx,
      'Public',
      'actions.',
      'Nothing here needs permission: any wallet can keep Antibody Guard running. Pick an action, or use the menu at the top right.',
      el(
        'div',
        { class: 'action-index' },
        ...PAGES.map(([href, title, line]) =>
          el('a', { href, 'data-nav': '', class: 'card action-link' }, el('div', { class: 'grow' }, el('h3', { style: 'margin:0 0 4px' }, title), el('p', { class: 'muted', style: 'margin:0' }, line)), el('span', { class: 'chev', 'aria-hidden': 'true' }, icon('chevron'))),
        ),
      ),
    );
  },
};
