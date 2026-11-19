// My vault: deploy your own GuardVault from your wallet, run it, and have GuardReactive watch it.
// Works for any vault your connected wallet owns (including the demo vaults, for their owner).
import { el } from '../../ui.js';
import { head, card, shortAddr } from '../kit.js';
import { loadWallet, walletIfLoaded, abi, CHAIN_ID, PROXY, ETH, label32, wei, isAddr, myDeployed, rememberVault, errorText } from '../../walletapi.js';
import { chainName, addr, tx } from './common.js';

// topic0 of the vault's PaymentExecuted and PaymentRefused events
const EXECUTED = '0x56cc168be8d9018731d9202799f179ed7ec9fe83ea7b6129d6d3300634d3e698';
const REFUSED = '0xc3362e52288f4143b4db4ab75ca48535a04d3406210327bbaa171f1f2d91bf44';
const CODES = ['None', 'Frozen', 'Quarantined', 'UnknownPayee', 'LabelMismatch', 'OverCap', 'OverDailyLimit', 'Duplicate', 'TransferFailed'];
let selected = null; // { chain, address }
let details = null; // read from the chain for the selected vault
let busy = false;
const log = []; // the last few actions, newest first

const field = (id, placeholder, value = '') => el('input', { id, placeholder, value, autocomplete: 'off', style: 'width:100%;background:var(--glass);color:var(--text);border:1px solid var(--line-2);border-radius:12px;padding:9px 12px;font:14px var(--sans)' });
const val = (id) => document.getElementById(id)?.value?.trim() ?? '';
const row = (...kids) => el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center' }, ...kids);
const btn = (text, fn, primary = false) => {
  const b = el('button', { class: `btn ${primary ? 'btn-primary' : 'btn-ghost'} btn-sm`, type: 'button', ...(busy ? { disabled: true } : {}) }, text);
  b.addEventListener('click', fn);
  return b;
};

async function readVault(ctx, v) {
  const w = await loadWallet();
  const pub = w.publicClient(CHAIN_ID[v.chain]);
  const A = await abi('GuardVault');
  const r = (functionName, args = []) => pub.readContract({ address: v.address, abi: A, functionName, args });
  const [owner, agent, guardian, frozen, limit, balance, proposals] = await Promise.all([r('owner'), r('agent'), r('guardian'), r('frozen'), r('dailyLimit', [ETH]), pub.getBalance({ address: v.address }), r('proposalCount')]);
  // Ask GuardReactive on Lasna directly: the indexer lags a few seconds behind a fresh watch.
  let watched = (ctx.state.vaults ?? []).some((x) => x.address.toLowerCase() === v.address.toLowerCase());
  const guard = ctx.state.guard?.address;
  if (guard) {
    try {
      const w0 = await w.publicClient(CHAIN_ID.lasna).readContract({ address: guard, abi: await abi('GuardReactive'), functionName: 'watched', args: [BigInt(CHAIN_ID[v.chain]), v.address] });
      watched = Boolean(w0[0]);
    } catch { /* keep the indexer's answer */ }
  }
  return { owner, agent, guardian, frozen, limit, balance, proposals, watched };
}

async function act(ctx, what, fn) {
  if (busy) return;
  busy = true;
  ctx.rerender();
  try {
    const r = await fn();
    const refused = r?.events?.find?.((e) => e === 'PaymentRefused');
    log.unshift({ what, ok: r?.receipt?.status !== 'reverted', hash: r?.hash, chain: r?.chain ?? selected?.chain, note: r?.note });
    ctx.toast(`${what}: ${r?.receipt?.status === 'reverted' ? 'reverted' : r?.note ?? 'done'}`);
  } catch (e) {
    const msg = errorText(e);
    log.unshift({ what, ok: false, note: msg });
    ctx.toast(`${what}: ${msg}`);
  } finally {
    busy = false;
    log.splice(6);
    if (selected) details = await readVault(ctx, selected).catch(() => details);
    await ctx.src.refresh().catch(() => {});
    ctx.rerender();
  }
}

async function vaultCall(fn, args, value) {
  const w = await loadWallet();
  const r = await w.write(CHAIN_ID[selected.chain], selected.address, await abi('GuardVault'), fn, args, value);
  return { ...r, chain: selected.chain };
}

export default {
  id: 'myvault',
  path: '/app/my-vault',
  title: 'My vault',
  icon: 'payees',
  async render(ctx) {
    const s = ctx.state;
    const w = walletIfLoaded();
    const acct = w?.account();
    const intro = head('My', 'vault.', 'Deploy your own GuardVault on Base Sepolia or Ethereum Sepolia from your wallet, register payees, set a daily limit, and have GuardReactive watch it. From then on, every lesson protects it too.');
    if (!acct?.connected) {
      return el(
        'div',
        { style: 'display:grid;gap:16px' },
        intro,
        card('Connect a wallet', null, el('p', { class: 'muted', style: 'margin:0 0 14px' }, 'Any wallet that WalletConnect supports, through Reown. You will need a little test ETH on Base Sepolia or Ethereum Sepolia.'), row(btn('Connect wallet', async () => (await loadWallet()).open(), true))),
      );
    }
    const me = acct.address.toLowerCase();
    const owned = [
      ...(s.vaults ?? []).filter((v) => String(v.owner ?? '').toLowerCase() === me).map((v) => ({ chain: v.chain, address: v.address, watched: true })),
      ...myDeployed().filter((v) => v.owner?.toLowerCase() === me && !(s.vaults ?? []).some((x) => x.address.toLowerCase() === v.address.toLowerCase())).map((v) => ({ ...v, watched: false })),
    ];
    if (!selected && owned[0]) selected = { chain: owned[0].chain, address: owned[0].address };
    if (selected && !details) details = await readVault(ctx, selected).catch(() => null);

    const deployCard = card(
      'Deploy a new vault',
      null,
      el('div', { style: 'display:grid;gap:10px' },
        row(el('label', { class: 'small muted' }, 'Chain '), (() => { const sel = el('select', { id: 'd-chain', style: 'background:var(--glass);color:var(--text);border:1px solid var(--line-2);border-radius:10px;padding:8px' }, el('option', { value: 'baseSepolia' }, 'Base Sepolia'), el('option', { value: 'sepolia' }, 'Ethereum Sepolia')); return sel; })()),
        field('d-agent', `agent address (default: your wallet, ${shortAddr(acct.address)})`),
        row(field('d-delay', 'payee delay in seconds (60)', '60'), field('d-fund', 'fund with ETH (0.003)', '0.003')),
        row(btn('Deploy GuardVault', () => act(ctx, 'deploy GuardVault', async () => {
          const chain = val('d-chain') || 'baseSepolia';
          const agent = val('d-agent') || acct.address;
          if (!isAddr(agent)) throw new Error('the agent must be an address');
          const code = await abi('GuardVault.code');
          const r = await (await loadWallet()).deploy(CHAIN_ID[chain], await abi('GuardVault'), code.bytecode, [PROXY[chain], agent, BigInt(val('d-delay') || '60')], wei(val('d-fund') || '0'));
          rememberVault({ chain, address: r.address, owner: acct.address });
          selected = { chain, address: r.address };
          details = null;
          return { ...r, chain, note: `deployed at ${shortAddr(r.address)}` };
        }), true)),
      ),
    );

    const list = owned.length
      ? card('Your vaults', null, el('div', { class: 'row-list' }, ...owned.map((v) => {
          const on = selected && v.address.toLowerCase() === selected.address.toLowerCase();
          const a = el('a', { class: 'row-i', href: '#', style: on ? 'background:var(--accent-wash)' : '' }, el('span', { class: `dot ${v.watched ? 'g' : 'y'}` }), el('span', { class: 'grow' }, `${chainName(v.chain)} · `, el('code', {}, shortAddr(v.address))), el('span', { class: 'meta' }, v.watched ? 'watched by GuardReactive' : 'not watched yet'));
          a.addEventListener('click', (e) => (e.preventDefault(), (selected = { chain: v.chain, address: v.address }), (details = null), ctx.rerender()));
          return a;
        })))
      : null;

    let manage = null;
    if (selected && details) {
      const d = details;
      const guard = s.guard?.address ?? '';
      const isGuardian = String(d.guardian).toLowerCase() === guard.toLowerCase();
      const isOwner = String(d.owner).toLowerCase() === me;
      const isAgent = String(d.agent).toLowerCase() === me;
      manage = el(
        'div',
        { style: 'display:grid;gap:16px' },
        card(
          `${chainName(selected.chain)} vault`,
          el('span', { class: `pill ${d.frozen ? 'bad' : 'ok'}` }, d.frozen ? 'frozen' : 'active'),
          el('dl', { class: 'kv-card' },
            el('dt', {}, 'address'), el('dd', {}, addr(s, selected.chain, selected.address)),
            el('dt', {}, 'balance'), el('dd', {}, `${(Number(d.balance) / 1e18).toFixed(5)} ETH`),
            el('dt', {}, 'daily limit'), el('dd', {}, `${(Number(d.limit) / 1e18).toString()} ETH`),
            el('dt', {}, 'proposals'), el('dd', {}, String(d.proposals)),
            el('dt', {}, 'owner'), el('dd', {}, isOwner ? 'you' : shortAddr(d.owner)),
            el('dt', {}, 'agent'), el('dd', {}, isAgent ? 'you' : shortAddr(d.agent)),
          ),
        ),
        card(
          'Reactive protection',
          el('span', { class: `pill ${d.watched ? 'ok' : 'rec'}` }, d.watched ? 'watched' : 'not yet'),
          el('div', { class: 'row-list' },
            el('div', { class: 'row-i' }, el('span', { class: `dot ${isGuardian ? 'g' : 'y'}` }), el('span', { class: 'grow' }, '1. GuardReactive is the vault’s guardian'), isGuardian ? el('span', { class: 'meta' }, 'done') : btn('Set guardian', () => act(ctx, 'set guardian', () => vaultCall('setGuardian', [guard])), true)),
            el('div', { class: 'row-i' }, el('span', { class: `dot ${d.watched ? 'g' : 'y'}` }), el('span', { class: 'grow' }, '2. GuardReactive watches it (and immunizes it with every lesson)'), d.watched ? el('span', { class: 'meta' }, 'done') : btn('Ask Reactive to watch', () => act(ctx, 'watch request', async () => {
              const res = await fetch('/api/watch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chain: selected.chain, vault: selected.address }) });
              const j = await res.json();
              if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
              return { hash: j.tx, chain: 'lasna', note: 'GuardReactive now watches it' };
            }), isGuardian)),
          ),
          el('p', { class: 'hint', style: 'margin-top:10px' }, 'Keep a little ETH in the vault: Reactive’s callbacks (freeze, quarantine) are paid from its balance.'),
        ),
        isOwner
          ? card('Payees and limits', el('span', { class: 'pill plain rec' }, 'owner'),
              el('div', { style: 'display:grid;gap:10px' },
                row(field('p-label', 'label, e.g. alice'), field('p-addr', 'address 0x…'), field('p-cap', 'cap in ETH, e.g. 0.002')),
                row(
                  btn('Request payee', () => act(ctx, `request payee ${val('p-label')}`, () => { if (!isAddr(val('p-addr'))) throw new Error('not an address'); return vaultCall('requestPayee', [label32(val('p-label')), val('p-addr'), wei(val('p-cap'))]); }), true),
                  btn('Activate', () => act(ctx, `activate payee ${val('p-label')}`, () => vaultCall('activatePayee', [label32(val('p-label'))]))),
                  btn('Remove', () => act(ctx, `remove payee ${val('p-label')}`, () => vaultCall('removePayee', [label32(val('p-label'))]))),
                ),
                el('p', { class: 'hint' }, 'A new payee waits for the vault’s delay; then activate it (anyone may). Removing is immediate. GuardReactive vetoes a payee change towards a known attacker.'),
                row(field('l-eth', 'daily limit in ETH'), btn('Set daily limit', () => act(ctx, `daily limit ${val('l-eth')}`, () => vaultCall('setDailyLimit', [ETH, wei(val('l-eth'))])))),
                row(field('s-label', 'schedule: payee label'), field('s-eth', 'ETH'), field('s-secs', 'every N seconds (≥ 600)'), btn('Add recurring payment', () => act(ctx, 'add schedule', () => vaultCall('setSchedule', [label32(val('s-label')), ETH, wei(val('s-eth')), BigInt(val('s-secs') || '600'), 0n])))),
              ))
          : null,
        isAgent || isOwner
          ? card('Propose a payment', el('span', { class: 'pill plain rec' }, isAgent ? 'you are the agent' : 'agent only'),
              el('div', { style: 'display:grid;gap:10px' },
                row(field('x-to', 'to 0x…'), field('x-eth', 'ETH'), field('x-label', 'label')),
                row(
                  btn('Dry run', () => act(ctx, 'dry run', async () => {
                    const w = await loadWallet();
                    const code = await w.publicClient(CHAIN_ID[selected.chain]).readContract({ address: selected.address, abi: await abi('GuardVault'), functionName: 'check', args: [val('x-to'), ETH, wei(val('x-eth')), label32(val('x-label'))] });
                    return { note: Number(code) === 0 ? 'would be paid' : `would be refused: ${CODES[Number(code)]}` };
                  })),
                  isAgent ? btn('Propose', () => act(ctx, 'propose payment', async () => {
                    const r = await vaultCall('proposePayment', [val('x-to'), ETH, wei(val('x-eth')), label32(val('x-label'))]);
                    const topics = r.receipt.logs.map((l) => l.topics[0]);
                    const refused = r.receipt.logs.find((l) => l.topics[0] === REFUSED);
                    return { ...r, note: topics.includes(EXECUTED) ? 'paid' : refused ? `refused: ${CODES[Number(BigInt(refused.topics[3]))]}` : 'sent' };
                  }), true) : null,
                ),
                el('p', { class: 'hint' }, 'Try a look-alike address: the vault refuses it, and GuardReactive quarantines it on every vault, yours and everyone else’s.'),
              ))
          : null,
        isOwner
          ? card('Owner controls', null, el('div', { style: 'display:grid;gap:10px' },
              row(d.frozen ? btn('Unfreeze', () => act(ctx, 'unfreeze', () => vaultCall('unfreeze', [])), true) : btn('Freeze now', () => act(ctx, 'freeze', () => vaultCall('freezeNow', [label32('owner')])))),
              row(field('r-addr', 'release a quarantined address 0x…'), btn('Release', () => act(ctx, 'release', () => vaultCall('release', [val('r-addr')])))),
              row(field('w-to', 'withdraw to 0x…'), field('w-eth', 'ETH'), btn('Withdraw', () => act(ctx, 'withdraw', () => vaultCall('withdraw', [val('w-to'), ETH, wei(val('w-eth'))])))),
            ))
          : null,
      );
    }

    return el(
      'div',
      { style: 'display:grid;gap:16px' },
      intro,
      list,
      manage,
      log.length ? card('Recent actions', null, el('div', { class: 'row-list' }, ...log.map((l) => el('div', { class: 'row-i' }, el('span', { class: `dot ${l.ok ? 'g' : 'r'}` }), el('span', { class: 'grow' }, l.what, l.note ? el('span', { class: 'muted' }, ` · ${l.note}`) : null), l.hash ? tx(s, l.chain, l.hash, 'transaction') : null)))) : null,
      deployCard,
    );
  },
};
