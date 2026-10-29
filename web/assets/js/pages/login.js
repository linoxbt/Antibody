// Sign-in: Sui wallets found through the Wallet Standard (no SDK, no CDN),
// the operator link from `antibody login`, or the read-only recorded demo.
import { sky, armReveals } from '../motion.js';
import { api, authStatus, setDemo } from '../data.js';
import { $, el } from '../ui.js';
import { discoverWallets, connect, signMessage, cancelled } from '../wallets.js';
import { themeSwitch } from '../theme.js';

sky();
armReveals();
$('theme-slot').append(themeSwitch());

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

// ---- wallets ---------------------------------------------------------------------
const wallets = [];
async function signInWith(w, btn) {
  if (!node) return say('Wallet sign-in needs a running Antibody node: run antibody up, then open its console.', 'err');
  btn.disabled = true;
  btn.classList.add('busy');
  const hint = btn.querySelector('small');
  try {
    hint.textContent = 'connecting';
    const account = await connect(w);
    hint.textContent = 'sign in wallet';
    const ch = await api('/api/auth/challenge', { address: account.address });
    const signature = await signMessage(w, account, ch.message);
    hint.textContent = 'verifying';
    await api('/api/auth/wallet', { address: account.address, message: ch.message, signature });
    done();
  } catch (e) {
    say(cancelled(e) ? 'Request cancelled in the wallet.' : e.message, 'err');
    hint.textContent = 'detected';
    btn.disabled = false;
    btn.classList.remove('busy');
  }
}

function renderWallets() {
  if (node === false && wallets.length) $('wallet-seen').replaceChildren(el('span', { class: 'seen' }, `${wallets.map((w) => w.name).join(', ')} detected, ready for your node.`));
  const host = $('wallets');
  if (!wallets.length) {
    host.replaceChildren(el('div', { class: 'wallet-empty' }, 'No Sui wallet detected. Install ', el('a', { href: 'https://slush.app', target: '_blank', rel: 'noopener' }, 'Slush'), ' or another Sui wallet, then reload.'));
    return;
  }
  host.replaceChildren(
    ...wallets.map((w) => {
      const b = el('button', { class: 'wallet-btn', type: 'button' }, w.icon ? el('img', { src: w.icon, alt: '', width: 32, height: 32 }) : el('span', { class: 'wi' }, w.name[0] ?? '?'), `Continue with ${w.name}`, el('small', {}, 'detected'));
      b.addEventListener('click', () => signInWith(w, b));
      return b;
    }),
  );
}
discoverWallets((ws) => {
  wallets.splice(0, wallets.length, ...ws.filter((w) => w.features['sui:signPersonalMessage']));
  if (wallets.length) renderWallets();
});
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
  document.body.dataset.node = st ? 'on' : 'off';
  $('node-state').textContent = st ? 'Node online · signing is free and moves no funds' : 'Public demo site';
  renderWallets();
  if (st?.authenticated) return location.replace(next);
  if (params.has('signedout')) say('Signed out.');
  if (params.has('expired')) say('Your session ended. Sign in again.', 'err');
  if (fromHash && st) operator(decodeURIComponent(fromHash));
})();
