// The Antibody Guard console: sidebar shell and client-side router, as in Antibody's console. It is
// public and read-only: state comes from the Guard service (the three chains, live) or, when the service
// cannot be reached, from the evidence recorded at build time.
import { sky } from '../motion.js';
import { loadState } from '../guard.js';
import { el, short } from '../ui.js';
import { icon, avatar } from './kit.js';
import { themeSwitch } from '../theme.js';
import overview from './views/overview.js';
import loops from './views/loops.js';
import vaults from './views/vaults.js';
import attackers from './views/attackers.js';
import memory from './views/memory.js';
import activityView from './views/activity.js';
import developers from './views/developers.js';
import events from './views/events.js';
import scorer from './views/scorer.js';
import contracts from './views/contracts.js';
import myvault from './views/myvault.js';
import actions, { topUp, retry, activatePayee } from './views/actions.js';
import attacker, { isAttackerPath } from './views/attacker.js';
import { loadWallet, walletIfLoaded, onWalletChange, hadWallet } from '../walletapi.js';

const VIEWS = [overview, activityView, loops, vaults, memory, attackers, events, scorer, contracts, myvault, actions, developers];
const SECTIONS = [
  ['Guard', ['overview', 'activity', 'loops', 'vaults', 'memory', 'attackers']],
  ['Reactive', ['events', 'scorer', 'contracts']],
  ['Wallet', ['myvault', 'actions']],
  ['Build', ['developers']],
];
// pages reached from a view (not in the sidebar): an attacker's detail page, each public action
const PAGES = [topUp, retry, activatePayee];
const byPath = (path) => {
  const p = path.replace(/\/+$/, '');
  if (isAttackerPath(p)) return attacker;
  return [...VIEWS, ...PAGES].find((v) => v.path === p) ?? (p === '/app' ? overview : null);
};

/** The data source: refresh() reloads state from the service (or the recorded evidence). */
const src = {
  state: null,
  get mode() {
    return this.state?.live ? 'live' : 'recorded';
  },
  async refresh() {
    this.state = await loadState();
  },
};
let current = null;
let navigated = false;
let toastTimer;

// One permanent polite live region (there before anything is announced); the toast is its visual twin.
const live = el('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
const toastEl = el('div', { class: 'toast', 'aria-hidden': 'true' });
document.body.append(live, toastEl);

function announce(msg) {
  live.textContent = '';
  // set in a later frame, so a repeated message is announced again
  requestAnimationFrame(() => (live.textContent = msg));
}

function toast(msg, ms = 4200) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  announce(msg);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

/** Every failure inside a view lands here, as a toast. */
function fail(e) {
  toast(e?.message ?? String(e));
}

function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  closeSide();
  route({ focus: true });
  window.scrollTo({ top: 0, behavior: 'instant' });
}

const ctx = {
  get src() {
    return src;
  },
  get state() {
    return src.state;
  },
  params: () => new URLSearchParams(location.search),
  /** True while rendering for a real navigation (read the URL again), false for a re-render. */
  get navigated() {
    return navigated;
  },
  navigate,
  toast,
  fail,
  rerender: () => route({ keepScroll: true, preserve: true }),
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

// Up to 960px the sidebar is a drawer: closed, it is out of the tab order and the accessibility tree.
const drawerMq = matchMedia('(max-width: 960px)');
function openSide(open, returnFocus = false) {
  const was = side.classList.contains('open');
  side.classList.toggle('open', open);
  scrim.classList.toggle('open', open);
  side.inert = drawerMq.matches && !open;
  burger.setAttribute('aria-expanded', String(open));
  burger.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  if (open) (side.querySelector('[aria-current="page"]') ?? side.querySelector('a, button'))?.focus();
  else if (was && returnFocus) burger.focus();
}
const closeSide = (returnFocus = false) => openSide(false, returnFocus);
burger.addEventListener('click', () => openSide(!side.classList.contains('open')));
scrim.addEventListener('click', () => closeSide(true));
document.addEventListener('keydown', (e) => e.key === 'Escape' && side.classList.contains('open') && closeSide(true));
drawerMq.addEventListener('change', () => closeSide());
closeSide();

function link(v) {
  const s = src.state;
  let count = null;
  if (v.id === 'attackers') count = el('span', { class: 'count calm' }, String(s.guard?.lessons?.length ?? 0));
  if (v.id === 'loops') count = el('span', { class: 'count calm' }, String((s.liveLoops?.length ?? 0) + (s.recorded?.length ?? 0)));
  if (v.id === 'vaults' && s.vaults?.some((x) => x.frozen)) count = el('span', { class: 'count' }, 'frozen');
  const a = el('a', { class: 'nav-i', href: v.path, ...(current === v || current?.parent === v.id ? { 'aria-current': 'page' } : {}) }, icon(v.icon), v.title, count);
  a.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    navigate(v.path);
  });
  return a;
}

function renderSide() {
  const s = src.state;
  side.replaceChildren(
    el('div', { class: 'side-brand' }, el('a', { class: 'brand', href: '/', 'aria-label': 'Antibody Guard home' }, el('img', { src: '/assets/img/mark.svg', alt: '', width: 26, height: 26 }), el('span', { class: 'wordmark' }, 'antibody'))),
    el('div', { class: 'acct' }, avatar(s.guard?.address ?? 'guard'), el('div', {}, el('b', {}, 'GuardReactive'), el('small', {}, s.guard?.address ? `${short(s.guard.address, 10)} · Lasna` : 'Reactive Lasna'))),
    ...SECTIONS.flatMap(([title, ids]) => [el('div', { class: 'side-sec' }, title), ...ids.map((id) => link(VIEWS.find((v) => v.id === id)))]),
    el('div', { class: 'side-spacer' }),
    themeCtl,
    el('div', { class: 'me', style: 'margin-top:8px' }, avatar('visitor', true), el('div', {}, el('b', {}, 'Visitor'), el('small', {}, 'read-only · testnets'))),
  );
}

function renderTop() {
  crumbs.replaceChildren(el('span', { class: 'root' }, 'Console'), el('span', { class: 'sep', 'aria-hidden': 'true' }, '/'), el('b', {}, current.title));
  const s = src.state;
  const parts = [];
  const acct = walletIfLoaded()?.account();
  const wb = el('button', { class: `btn ${acct?.connected ? 'btn-ghost' : 'btn-primary'} btn-sm`, type: 'button', 'aria-label': acct?.connected ? 'Wallet' : 'Connect wallet' }, acct?.connected ? `${short(acct.address, 6)}…${acct.address.slice(-4)}` : 'Connect wallet');
  wb.addEventListener('click', () => ctx.act(async () => (await loadWallet()).open()));
  parts.push(wb);
  if (src.mode === 'live') parts.push(el('span', { class: 'pill live' }, el('span', { class: 'pl' }, 'Live · 3 testnets'), el('span', { class: 'ps', 'aria-hidden': 'true' }, 'Live')));
  else parts.push(el('span', { class: 'pill rec' }, el('span', { class: 'pl' }, 'Recorded evidence'), el('span', { class: 'ps', 'aria-hidden': 'true' }, 'Rec')));
  const r = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Refresh', title: 'Refresh' }, icon('refresh'));
  r.addEventListener('click', () => ctx.act(async () => (await src.refresh(), route({ keepScroll: true, preserve: true }), toast(src.mode === 'live' ? 'Refreshed from Base Sepolia, Ethereum Sepolia and Lasna.' : 'The Guard service is not answering: showing the recorded evidence.'))));
  parts.push(r);
  tbRight.replaceChildren(...parts);
  demoBar.classList.toggle('hidden', src.mode === 'live');
  if (src.mode !== 'live') demoBar.replaceChildren(el('span', { class: 'dot b' }), 'Recorded evidence · read-only', el('span', { class: 'long' }, ` · the Guard service is not answering right now; everything below happened on-chain and links to the explorers.`));
}

// The focused control is found again after a re-render by id, data-id/data-key, or label + text.
const keyOf = (e) => (e.id ? { id: e.id } : { tag: e.tagName, data: e.getAttribute('data-id') ?? e.getAttribute('data-key'), label: e.getAttribute('aria-label'), text: e.textContent.trim().slice(0, 80) });
function findKey(k) {
  if (k.id) return document.getElementById(k.id);
  const all = [...document.querySelectorAll(k.tag)];
  if (k.data !== null) return all.find((e) => (e.getAttribute('data-id') ?? e.getAttribute('data-key')) === k.data);
  return all.find((e) => e.getAttribute('aria-label') === k.label && e.textContent.trim().slice(0, 80) === k.text);
}

/** Open <details> (by summary text) and the focused control, captured before a re-render. */
function uiState() {
  const a = document.activeElement;
  return {
    open: new Set([...view.querySelectorAll('details[open] > summary')].map((s) => s.textContent)),
    focus: a && a !== document.body && a !== view && document.getElementById('app').contains(a) ? keyOf(a) : null,
    // what the person has typed or chosen: a re-render of the same view must not wipe a half-filled form
    values: new Map([...view.querySelectorAll('input[id], select[id], textarea[id]')].filter((x) => x.value !== x.defaultValue).map((x) => [x.id, x.value])),
  };
}
function restoreUi({ open, focus, values }) {
  for (const s of view.querySelectorAll('details > summary')) if (open.has(s.textContent)) s.parentElement.open = true;
  for (const [id, value] of values ?? []) {
    const x = document.getElementById(id);
    if (x && view.contains(x)) x.value = value;
  }
  const f = focus && findKey(focus);
  if (f && !f.disabled) f.focus({ preventScroll: true });
}

function focusView() {
  const h = view.querySelector('h1');
  if (h) h.tabIndex = -1;
  (h ?? view).focus({ preventScroll: true });
}

/** Render the current path. keepScroll + preserve: a re-render of the same view; focus: a navigation (move focus, announce). */
async function route({ keepScroll = false, preserve = false, focus = false } = {}) {
  const v = byPath(location.pathname);
  if (!v) return navigate('/app', { replace: true });
  const ui = preserve && current === v ? uiState() : null;
  current = v;
  navigated = !keepScroll;
  document.title = `${v.title} · Antibody Guard`;
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
    view.replaceChildren(el('div', { class: 'card' }, el('h3', {}, 'This view failed to load'), el('p', { class: 'muted' }, e.message)));
  } finally {
    navigated = false;
  }
  if (keepScroll) window.scrollTo({ top: y, behavior: 'instant' });
  if (ui) restoreUi(ui);
  if (focus) {
    focusView();
    announce(`${v.title} loaded`);
  }
}

/** One auto-refresh tick: fetch state, re-render only if it changed (keeping focus, open details and scroll). */
const fingerprint = (s) => JSON.stringify({ ...s, updatedAt: null, evidence: null });
async function refreshNow() {
  const before = fingerprint(src.state);
  try {
    await src.refresh();
  } catch {
    return false;
  }
  if (fingerprint(src.state) === before) return false;
  await route({ keepScroll: true, preserve: true });
  return true;
}

addEventListener('popstate', () => route({ focus: true }));
// In-view links marked data-nav route without a reload.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[data-nav]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});

document.querySelector('.skip')?.addEventListener('click', (e) => {
  e.preventDefault();
  focusView();
});

function bootError(title, text) {
  const retry = el('button', { class: 'btn btn-primary', type: 'button' }, 'Retry');
  retry.addEventListener('click', () => location.reload());
  document.getElementById('app').replaceChildren(
    el('div', { class: 'loading' }, el('div', { class: 'card', role: 'alert', style: 'max-width:480px' }, el('h3', {}, title), el('p', { class: 'muted' }, text), el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin-top:12px' }, retry, el('a', { class: 'btn btn-ghost', href: '/' }, 'Back to the overview')))),
  );
}

// ---- boot --------------------------------------------------------------------------
(async () => {
  sky();
  try {
    await src.refresh();
  } catch (e) {
    return bootError(navigator.onLine ? 'No data to show' : 'You are offline', navigator.onLine ? `Neither the Guard service nor the recorded evidence answered: ${e.message}` : 'Reconnect, then retry.');
  }
  document.getElementById('app').replaceChildren(
    el('div', { class: 'app-root' }, side, scrim, el('div', { class: 'main' }, el('header', { class: 'topbar' }, burger, crumbs, tbRight), demoBar, view)),
  );
  await route();
  // A wallet connected on an earlier visit is restored in the background; any change re-renders.
  onWalletChange(() => route({ keepScroll: true, preserve: true }));
  if (hadWallet()) loadWallet().then(() => route({ keepScroll: true, preserve: true })).catch(() => {});
  // Keep the view current without stomping on in-progress input.
  setInterval(() => {
    if (document.hidden || document.activeElement?.matches('input, select, textarea')) return;
    refreshNow();
  }, 10_000);
})();
