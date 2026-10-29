// Sign-in: Sui wallets found through the Wallet Standard (no SDK, no CDN),
// the operator link from `antibody login`, or the read-only recorded demo.
import { sky, armReveals } from '../motion.js';
import { api, authStatus, setDemo } from '../data.js';
import { $, el } from '../ui.js';

sky();
armReveals();

const params = new URLSearchParams(location.search);
const next = (() => {
  const n = params.get('next') ?? '';
  return n.startsWith('/app') && !n.startsWith('//') ? n : '/app';
})();
let node = null;

const say = (text, kind = '') => {
  const m = $('msg');
  m.textContent = text;
  m.className = `auth-msg ${kind}`;
};
const done = () => {
  setDemo(false);
  say('Signed in.', 'ok');
  location.replace(next);
};

// ---- Wallet Standard ------------------------------------------------------------
const wallets = [];
const isSui = (w) => w?.chains?.some((c) => String(c).startsWith('sui:')) && w.features?.['standard:connect'] && w.features?.['sui:signPersonalMessage'];
function register(...ws) {
  for (const w of ws) if (isSui(w) && !wallets.includes(w)) wallets.push(w);
  renderWallets();
  return () => {};
}
addEventListener('wallet-standard:register-wallet', (e) => {
  try {
    e.detail({ register });
  } catch {
    /* a misbehaving wallet must not break the page */
  }
});
dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register } }));

async function signInWith(w, btn) {
  if (!node) return say('Wallet sign-in needs a running Antibody node: run antibody up, then open its console.', 'err');
  btn.disabled = true;
  btn.classList.add('busy');
  const hint = btn.querySelector('small');
  try {
    hint.textContent = 'connecting';
    const { accounts } = await w.features['standard:connect'].connect();
    const account = accounts.find((a) => a.chains?.some((c) => String(c).startsWith('sui:'))) ?? accounts[0];
    if (!account) throw new Error('the wallet shared no account');
    hint.textContent = 'sign in wallet';
    const ch = await api('/api/auth/challenge', { address: account.address });
    const { signature } = await w.features['sui:signPersonalMessage'].signPersonalMessage({ message: new TextEncoder().encode(ch.message), account });
    hint.textContent = 'verifying';
    await api('/api/auth/wallet', { address: account.address, message: ch.message, signature });
    done();
  } catch (e) {
    say(/reject|denied|cancel/i.test(e.message ?? '') ? 'Request cancelled in the wallet.' : e.message, 'err');
    hint.textContent = 'detected';
    btn.disabled = false;
    btn.classList.remove('busy');
  }
}

function renderWallets() {
  const host = $('wallets');
  if (!wallets.length) {
    host.replaceChildren(el('div', { class: 'wallet-empty' }, 'No Sui wallet detected. Install ', el('a', { href: 'https://slush.app', target: '_blank', rel: 'noopener' }, 'Slush'), ' or another Sui wallet, then reload.'));
    return;
  }
  host.replaceChildren(
    ...wallets.map((w) => {
      const b = el('button', { class: 'wallet-btn', type: 'button' }, w.icon ? el('img', { src: w.icon, alt: '', width: 32, height: 32 }) : el('span', { class: 'wi' }, w.name[0] ?? '?'), `Continue with ${w.name}`, el('small', {}, node === false ? 'needs a node' : 'detected'));
      b.addEventListener('click', () => signInWith(w, b));
      return b;
    }),
  );
}
// Wallets register within a tick of app-ready; show the empty state only after that.
setTimeout(renderWallets, 600);

// ---- operator link ----------------------------------------------------------------
async function operator(token) {
  if (!node) return say('The operator link works on the machine running antibody up.', 'err');
  try {
    say('Signing in…');
    await api('/api/auth/operator', { token });
    done();
  } catch (e) {
    say(e.message, 'err');
  }
}
$('op-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('op-token').value.trim();
  if (!t) return $('op-token').focus();
  operator(t);
});

// ---- demo -------------------------------------------------------------------------
$('demo').href = next;
$('demo').addEventListener('click', () => setDemo(true));

// ---- boot -------------------------------------------------------------------------
(async () => {
  const fromHash = /(?:^|[#&])token=([^&]+)/.exec(location.hash)?.[1];
  if (fromHash) history.replaceState(null, '', location.pathname + location.search); // keep the token out of history
  const st = await authStatus();
  node = !!st;
  $('node-state').textContent = st ? 'Node online' : 'Public demo site';
  if (!st) {
    $('op-form').querySelectorAll('input, button').forEach((x) => (x.disabled = true));
    say('This public site has no Antibody node behind it. Explore the recorded demo, or run antibody up locally to sign in.');
  }
  renderWallets();
  if (st?.authenticated) return location.replace(next);
  if (params.has('signedout')) say('Signed out.');
  if (params.has('expired')) say('Your session ended. Sign in again.', 'err');
  if (fromHash && st) operator(decodeURIComponent(fromHash));
})();
