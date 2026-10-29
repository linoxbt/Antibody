// Sign-in. With an Antibody install behind the page: the owner's Sui wallet
// (Wallet Standard, no SDK) or an operator token. On the public site there is
// nothing to sign in to, so it offers the recorded demo.
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

const say = (text, kind = '') => {
  $('msg').textContent = text;
  $('msg').className = `auth-msg ${kind}`;
};
const done = () => {
  setDemo(false);
  location.replace(next);
};

// ---- wallets ---------------------------------------------------------------------
const wallets = [];

async function signInWith(w, btn) {
  btn.disabled = true;
  const hint = btn.querySelector('small');
  try {
    hint.textContent = 'connecting…';
    const account = await connect(w);
    hint.textContent = 'approve in wallet…';
    const ch = await api('/api/auth/challenge', { address: account.address });
    const signature = await signMessage(w, account, ch.message);
    hint.textContent = 'checking…';
    await api('/api/auth/wallet', { address: account.address, message: ch.message, signature });
    done();
  } catch (e) {
    say(cancelled(e) ? 'Cancelled.' : e.message, 'err');
    hint.textContent = '';
    btn.disabled = false;
  }
}

function renderWallets() {
  const host = $('wallets');
  if (!wallets.length) {
    const phone = /Android|iPhone|iPad/i.test(navigator.userAgent);
    host.replaceChildren(el('div', { class: 'wallet-empty' }, phone ? 'No wallet here. Open this page in your wallet app’s browser, or ' : 'No Sui wallet found. ', el('a', { href: 'https://slush.app', target: '_blank', rel: 'noopener' }, phone ? 'get Slush' : 'Get Slush'), '.'));
    return;
  }
  host.replaceChildren(
    ...wallets.map((w) => {
      const b = el('button', { class: 'wallet-btn', type: 'button' }, w.icon ? el('img', { src: w.icon, alt: '', width: 32, height: 32 }) : el('span', { class: 'wi' }, w.name[0] ?? '?'), w.name, el('small', {}));
      b.addEventListener('click', () => signInWith(w, b));
      return b;
    }),
  );
}

discoverWallets((ws) => {
  wallets.splice(0, wallets.length, ...ws.filter((w) => w.features['sui:signPersonalMessage']));
  if (wallets.length) renderWallets();
});

// ---- operator token ----------------------------------------------------------------
async function operator(token) {
  try {
    await api('/api/auth/operator', { token });
    done();
  } catch (e) {
    say(e.message, 'err');
  }
}
$('op-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('op-token').value.trim();
  if (t) operator(t);
  else $('op-token').focus();
});

$('demo').addEventListener('click', () => setDemo(true));

// ---- boot ----------------------------------------------------------------------------
(async () => {
  const fromHash = /(?:^|[#&])token=([^&]+)/.exec(location.hash)?.[1];
  if (fromHash) history.replaceState(null, '', location.pathname + location.search); // keep the token out of history
  const st = await authStatus();
  document.body.dataset.node = st ? 'on' : 'off';
  if (st?.mode) document.body.dataset.mode = st.mode;
  if (!st) return;
  if (st.authenticated) return location.replace(next);
  $('demo').href = next;
  $('demo').replaceChildren('or enter the demo');
  // Wallets register within a tick of app-ready; show the empty state only after that.
  setTimeout(renderWallets, 600);
  if (params.has('expired')) say('Session ended. Sign in again.', 'err');
  if (fromHash) operator(decodeURIComponent(fromHash));
})();
