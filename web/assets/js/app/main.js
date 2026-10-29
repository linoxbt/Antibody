// The signed-in console: session gate, sidebar shell, client-side router.
// Live mode talks to the control process behind a console session; the
// recorded demo replays demo.json read-only (the public site has no node).
import '../pwa.js';
import { sky } from '../motion.js';
import { authStatus, demoChosen, liveSource, recordedSource, signOut, AuthRequired, ReadOnlyError } from '../data.js';
import { el, short } from '../ui.js';
import { icon, avatar } from './kit.js';
import { themeSwitch } from '../theme.js';
import overview from './views/overview.js';
import steward from './views/steward.js';
import memory from './views/memory.js';
import payees from './views/payees.js';
import ledger from './views/ledger.js';
import incidents from './views/incidents.js';
import keys from './views/keys.js';
import settings from './views/settings.js';

const VIEWS = [overview, steward, memory, payees, ledger, incidents, keys, settings];
const SECTIONS = [
  ['Workspace', ['overview', 'steward', 'memory', 'payees']],
  ['Control', ['ledger', 'incidents', 'keys']],
];
const byPath = (path) => VIEWS.find((v) => v.path === path.replace(/\/+$/, '')) ?? (path.replace(/\/+$/, '') === '/app' ? overview : null);

let src = null;
let session = null;
let current = null;
let toastTimer;

function toast(msg, ms = 4200) {
  let t = document.querySelector('.toast');
  if (!t) document.body.append((t = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' })));
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function toLogin(reason = '') {
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace(`/login?next=${next}${reason ? `&${reason}=1` : ''}`);
}

/** Every failure inside a view lands here: expired sessions go to sign-in, the rest become toasts. */
function fail(e) {
  if (e instanceof AuthRequired) return toLogin('expired');
  toast(e instanceof ReadOnlyError ? e.message : e?.message ?? String(e));
}

function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  route();
  closeSide();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

const ctx = {
  get src() {
    return src;
  },
  get state() {
    return src.state;
  },
  get session() {
    return session;
  },
  params: () => new URLSearchParams(location.search),
  navigate,
  toast,
  fail,
  rerender: () => route({ keepScroll: true }),
  async act(fn) {
    try {
      return await fn();
    } catch (e) {
      fail(e);
      return undefined;
    }
  },
};

// ---- shell ------------------------------------------------------------------------
const side = el('aside', { class: 'side', id: 'side', 'aria-label': 'Console navigation' });
const scrim = el('div', { class: 'scrim', 'aria-hidden': 'true' });
const crumbs = el('div', { class: 'crumbs' });
const tbRight = el('div', { class: 'tb-right' });
const themeCtl = el('div', { class: 'side-theme' }, themeSwitch());
const view = el('main', { class: 'view', id: 'view', tabindex: '-1' });
const demoBar = el('div', { class: 'demo-bar hidden' });
const burger = el('button', { class: 'icon-btn burger-app', type: 'button', 'aria-label': 'Open navigation', 'aria-controls': 'side', 'aria-expanded': 'false' }, icon('menu'));

function openSide(open) {
  side.classList.toggle('open', open);
  scrim.classList.toggle('open', open);
  burger.setAttribute('aria-expanded', String(open));
}
const closeSide = () => openSide(false);
burger.addEventListener('click', () => openSide(!side.classList.contains('open')));
scrim.addEventListener('click', closeSide);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeSide());

function link(v) {
  const s = src.state;
  let count = null;
  if (v.id === 'incidents') {
    const open = s.incidents.filter((i) => i.status === 'open').length;
    count = open ? el('span', { class: 'count' }, String(open)) : null;
  }
  if (v.id === 'payees' && s.ledger.ok) count = el('span', { class: 'count calm' }, String(s.ledger.payees.length));
  const a = el('a', { class: 'nav-i', href: v.path, ...(current === v ? { 'aria-current': 'page' } : {}) }, icon(v.icon), v.title, count);
  a.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    navigate(v.path);
  });
  return a;
}

function renderSide() {
  const s = src.state;
  const who = session?.address ?? (src.mode === 'recorded' ? 'demo' : 'operator');
  const signOutBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': src.mode === 'recorded' ? 'Leave the demo' : 'Sign out', title: src.mode === 'recorded' ? 'Leave the demo' : 'Sign out' }, icon('logout'));
  signOutBtn.addEventListener('click', async () => {
    await signOut();
    location.replace('/login?signedout=1');
  });
  side.replaceChildren(
    el('div', { class: 'side-brand' }, el('a', { class: 'brand', href: '/', 'aria-label': 'Antibody home' }, el('img', { src: '/assets/img/mark.svg', alt: '', width: 26, height: 26 }), el('span', { class: 'wordmark' }, 'antibody')), el('span', { class: 'chip-v' }, 'console')),
    el('div', { class: 'acct' }, avatar(s.account.id ?? 'acct'), el('div', {}, el('b', {}, 'Steward'), el('small', {}, s.account.id ? short(s.account.id, 14) : 'MemWal account'))),
    ...SECTIONS.flatMap(([title, ids]) => [el('div', { class: 'side-sec' }, title), ...ids.map((id) => link(VIEWS.find((v) => v.id === id)))]),
    el('div', { class: 'side-spacer' }),
    link(settings),
    themeCtl,
    el('div', { class: 'me', style: 'margin-top:8px' }, avatar(who, true), el('div', {}, el('b', {}, session?.address ? short(session.address, 12) : src.mode === 'recorded' ? 'Demo visitor' : 'Operator'), el('small', {}, src.mode === 'recorded' ? 'read-only' : session?.method === 'wallet' ? 'owner wallet' : 'operator link')), signOutBtn),
  );
}

function renderTop() {
  crumbs.replaceChildren(el('span', { class: 'root' }, 'Console'), el('span', { class: 'sep', 'aria-hidden': 'true' }, '/'), el('b', {}, current.title));
  const s = src.state;
  const parts = [];
  if (src.mode === 'recorded') {
    const sel = el('select', { class: 'step-select', 'aria-label': 'Recorded moment' }, ...src.steps.map((st, i) => el('option', { value: String(i), ...(i === src.index ? { selected: true } : {}) }, `${i + 1} · ${st.time} · ${st.title}`)));
    sel.addEventListener('change', () => {
      src.setIndex(Number(sel.value));
      route({ keepScroll: true });
    });
    parts.push(el('span', { class: 'pill rec' }, 'Recorded'), sel);
  } else {
    parts.push(el('span', { class: 'pill live' }, s.sandbox ? 'Sandbox · simulated' : s.backend === 'offline' ? 'Live · simulated' : 'Live · mainnet'));
    const r = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Refresh', title: 'Refresh' }, icon('refresh'));
    r.addEventListener('click', () => ctx.act(async () => (await src.refresh(), route({ keepScroll: true }), toast('Refreshed from Walrus + Sui.'))));
    parts.push(r);
  }
  tbRight.replaceChildren(...parts);
  // A dependency still failing after retries: say so plainly (payments that depend on it are blocked, fail closed).
  const down = Object.entries(s.health?.deps ?? {}).filter(([, d]) => !d.ok);
  const NAMES = { relayer: 'Walrus Memory relayer', chain: 'Sui RPC', 'chain-crosscheck': 'second Sui RPC' };
  demoBar.classList.toggle('hidden', src.mode !== 'recorded' && down.length === 0);
  demoBar.classList.toggle('degraded', src.mode !== 'recorded' && down.length > 0);
  if (src.mode === 'recorded') demoBar.replaceChildren(el('span', { class: 'dot b' }), 'Recorded demo · read-only', el('span', { class: 'long' }, ' · simulated data from the offline run.'), el('a', { href: '/login' }, 'Sign in live →'));
  else if (down.length) demoBar.replaceChildren(el('span', { class: 'dot r' }), `Degraded: ${down.map(([k]) => NAMES[k] ?? k).join(' and ')} not answering`, el('span', { class: 'long' }, ` · ${down[0][1].lastError ?? ''} · payments that need it are blocked until it recovers.`), el('a', { href: '/app/settings' }, 'Details →'));
}

async function route({ keepScroll = false } = {}) {
  const v = byPath(location.pathname);
  if (!v) return navigate('/app', { replace: true });
  current = v;
  document.title = `${v.title} · Antibody`;
  renderSide();
  renderTop();
  const y = scrollY;
  try {
    const node = await v.render(ctx);
    view.replaceChildren(node);
    // restart the entrance animation
    view.style.animation = 'none';
    void view.offsetWidth;
    view.style.animation = keepScroll ? 'none' : '';
  } catch (e) {
    if (e instanceof AuthRequired) return toLogin('expired');
    view.replaceChildren(el('div', { class: 'card' }, el('h3', {}, 'This view failed to load'), el('p', { class: 'muted' }, e.message)));
  }
  if (keepScroll) window.scrollTo({ top: y, behavior: 'instant' });
}

addEventListener('popstate', () => route());
// The lineage graph switches layout at 760px: redraw when the window crosses it.
let narrow = innerWidth < 760;
addEventListener('resize', () => {
  if (src && narrow !== innerWidth < 760) (narrow = !narrow), route({ keepScroll: true });
});
// In-view links marked data-nav route without a reload.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[data-nav]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});

// ---- boot --------------------------------------------------------------------------
(async () => {
  sky();
  const st = await authStatus();
  try {
    if (st?.authenticated) {
      session = st;
      src = await liveSource();
    } else if (demoChosen()) {
      src = await recordedSource();
    } else {
      return toLogin();
    }
  } catch (e) {
    if (e instanceof AuthRequired) return toLogin('expired');
    document.getElementById('app').replaceChildren(el('div', { class: 'loading' }, el('div', { class: 'card', style: 'max-width:480px' }, el('h3', {}, 'No data to show'), el('p', { class: 'muted' }, src ? e.message : 'The recorded demo is missing on this server. Build it with npx tsx scripts/build-site.ts, or sign in to a live node.'), el('a', { class: 'btn btn-primary', href: '/login', style: 'margin-top:12px' }, 'Back to sign in'))));
    return;
  }
  document.getElementById('app').replaceChildren(
    el('div', { class: 'app-root' }, side, scrim, el('div', { class: 'main' }, el('header', { class: 'topbar' }, burger, crumbs, tbRight), demoBar, view)),
  );
  await route();
  if (src.mode === 'live') {
    // Keep the live view current without stomping on in-progress input.
    setInterval(async () => {
      if (document.hidden || document.activeElement?.matches('input, select, textarea')) return;
      try {
        await src.refresh();
        route({ keepScroll: true });
      } catch (e) {
        if (e instanceof AuthRequired) toLogin('expired');
      }
    }, 20_000);
  }
})();
