// Owner approval page, served once by the CLI (antibody setup|revoke|rotate --wallet).
// It hands each prepared request to the owner's wallet and posts the signature back.
import { $, el } from '../ui.js';
import { discoverWallets, connect, signMessage, signTransaction, cancelled } from '../wallets.js';

const base = location.pathname;
const wallets = [];
let req = null;
let busy = false;

const say = (text, kind = '') => {
  $('msg').textContent = text;
  $('msg').className = `auth-msg ${kind}`;
};
const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '');

async function post(body) {
  const r = await fetch(`${base}/result`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-antibody-ui': '1' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
}

async function approve(w, btn) {
  if (!req || busy) return;
  busy = true;
  const hint = btn.querySelector('small');
  const id = req.id;
  try {
    hint.textContent = 'connecting…';
    const account = await connect(w);
    if (req.owner && account.address.toLowerCase() !== req.owner.toLowerCase()) throw new Error(`Connect the account owner (${short(req.owner)}) in ${w.name}; it shared ${short(account.address)}.`);
    hint.textContent = 'approve in wallet…';
    const signed = req.kind === 'message' ? { signature: await signMessage(w, account, req.message) } : await signTransaction(w, account, req.txBytes, req.chain);
    await post({ id, signature: signed.signature, ...(signed.bytes ? { bytes: signed.bytes } : {}), address: account.address });
    say('Signed. The command line is submitting it…');
    req = null;
    render();
  } catch (e) {
    if (cancelled(e)) {
      await post({ id, cancelled: true }).catch(() => {});
      say('Cancelled. Nothing was signed; the command line stopped.', 'err');
      req = null;
      render();
    } else say(e.message, 'err');
  } finally {
    busy = false;
    hint.textContent = '';
  }
}

function render() {
  $('req').hidden = !req;
  if (req) {
    $('title').replaceChildren(req.title.charAt(0).toUpperCase() + req.title.slice(1), el('span', { class: 'tail' }, '.'));
    $('lead').textContent = req.kind === 'transaction' ? 'Your wallet will show one Sui transaction. Check it, then approve.' : 'Simulated install: your wallet signs a one-time authorization message (no transaction, no gas).';
    $('details').replaceChildren(...[['Owner', req.owner ? short(req.owner) : 'the wallet you choose'], ...req.lines.map((l) => { const i = l.indexOf(': '); return i > 0 ? [l.slice(0, i), l.slice(i + 2)] : ['', l]; })].flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, el('code', {}, v))]));
  }
  const host = $('wallets');
  if (!req) return host.replaceChildren();
  if (!wallets.length) return host.replaceChildren(el('div', { class: 'wallet-empty' }, 'No Sui wallet found in this browser. ', el('a', { href: 'https://slush.app', target: '_blank', rel: 'noopener' }, 'Get Slush'), ', then reload.'));
  host.replaceChildren(
    ...wallets.map((w) => {
      const b = el('button', { class: 'wallet-btn', type: 'button' }, w.icon ? el('img', { src: w.icon, alt: '', width: 32, height: 32 }) : el('span', { class: 'wi' }, w.name[0] ?? '?'), w.name, el('small', {}));
      b.addEventListener('click', () => approve(w, b));
      return b;
    }),
  );
}

async function poll() {
  try {
    const r = await (await fetch(`${base}/request`, { cache: 'no-store' })).json();
    if (r.done) {
      $('title').replaceChildren(r.done.ok ? 'Done' : 'Stopped', el('span', { class: 'tail' }, '.'));
      $('lead').textContent = r.done.text;
      req = null;
      render();
      say(r.done.ok ? 'You can close this tab.' : '', r.done.ok ? '' : 'err');
      return;
    }
    if (r.id && (!req || req.id !== r.id) && !busy) {
      req = r;
      say('');
      render();
    }
  } catch {
    $('lead').textContent = 'The command line is no longer waiting. You can close this tab.';
    req = null;
    render();
    return;
  }
  setTimeout(poll, 1000);
}

discoverWallets((ws) => (wallets.splice(0, wallets.length, ...ws), render()));
poll();
