// Site shell: navigation (with mobile drawer), footer, toast, scroll reveal,
// and the live/recorded mode bar used by the console pages.
import { el } from './ui.js';

export const REPO = 'https://github.com/linoxbt/Antibody';

const PAGES = [
  { href: '/', id: 'home', label: 'Overview', hint: 'Product' },
  { href: '/walkthrough', id: 'walkthrough', label: 'Walkthrough', hint: '8 chapters' },
  { href: '/console', id: 'console', label: 'Console', hint: 'Run' },
  { href: '/graph', id: 'graph', label: 'Blast radius', hint: 'Lineage' },
  { href: '/ledger', id: 'ledger', label: 'Ledger', hint: 'Control' },
  { href: '/incidents', id: 'incidents', label: 'Incidents', hint: 'Sentinel' },
  { href: '/security', id: 'security', label: 'Security', hint: 'Guarantees' },
];

function brand() {
  return el(
    'a',
    { class: 'brand', href: '/', 'aria-label': 'Antibody home' },
    el('img', { src: '/assets/img/mark.svg', alt: '', width: 30, height: 30 }),
    el('span', { class: 'wordmark' }, 'Antibody', el('small', {}, 'Memory provenance')),
  );
}

export function mountShell(current) {
  const link = (p) => el('a', { href: p.href, ...(p.id === current ? { 'aria-current': 'page' } : {}) }, p.label);
  const burger = el('button', { class: 'burger', 'aria-label': 'Open menu', 'aria-expanded': 'false', 'aria-controls': 'drawer' }, el('span'), el('span'), el('span'));
  const drawer = el(
    'nav',
    { class: 'drawer', id: 'drawer', 'aria-label': 'Site', 'aria-hidden': 'true' },
    ...PAGES.map((p) => el('a', { href: p.href, ...(p.id === current ? { 'aria-current': 'page' } : {}) }, p.label, el('span', {}, p.hint))),
    el('a', { class: 'btn btn-gold', href: REPO, target: '_blank', rel: 'noopener' }, 'View on GitHub'),
  );
  const header = el(
    'header',
    { class: 'nav' },
    el(
      'div',
      { class: 'wrap' },
      brand(),
      el('nav', { class: 'nav-links', 'aria-label': 'Primary' }, ...PAGES.slice(1).map(link)),
      el('div', { class: 'nav-cta' }, el('a', { class: 'btn btn-ghost btn-sm', href: REPO, target: '_blank', rel: 'noopener' }, 'GitHub')),
      burger,
    ),
  );
  const setOpen = (open) => {
    drawer.classList.toggle('open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    document.body.classList.toggle('no-scroll', open);
    if (open) drawer.querySelector('a')?.focus();
  };
  burger.addEventListener('click', () => setOpen(burger.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.classList.contains('open')) {
      setOpen(false);
      burger.focus();
    }
  });
  matchMedia('(min-width: 1041px)').addEventListener('change', (m) => m.matches && setOpen(false));
  document.body.prepend(header, drawer);

  const col = (title, links) => el('div', {}, el('h4', {}, title), ...links.map(([t, h, ext]) => el('a', { href: h, ...(ext ? { target: '_blank', rel: 'noopener' } : {}) }, t)));
  document.body.append(
    el(
      'footer',
      { class: 'footer' },
      el(
        'div',
        { class: 'wrap' },
        el(
          'div',
          { class: 'footer-grid' },
          el('div', {}, brand()),
          col('Product', [['Walkthrough', '/walkthrough'], ['Console', '/console'], ['Blast radius', '/graph'], ['Security model', '/security']]),
          col('Operate', [['Ledger', '/ledger'], ['Incidents', '/incidents'], ['Mainnet runbook', `${REPO}/blob/main/docs/demo-live.md`, true], ['Attack set results', `${REPO}/blob/main/docs/attack-set-results.md`, true]]),
          col('Project', [['Source code', REPO, true], ['Design notes', `${REPO}/blob/main/docs/design-notes.md`, true], ['Article', `${REPO}/blob/main/docs/blog.md`, true], ['Total Recall hackathon', 'https://tatum.io/hackathon/total-recall', true]]),
        ),
        el('div', { class: 'legal' }, el('span', {}, `© ${new Date().getFullYear()} Antibody · MIT licensed`), el('span', {}, 'Demo data is simulated.')),
      ),
    ),
  );
  revealOnScroll();
}

let toastTimer;
export function toast(msg, ms = 4200) {
  let t = document.querySelector('.toast');
  if (!t) document.body.append((t = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' })));
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function revealOnScroll() {
  const els = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.documentElement.classList.add('reveal-armed');
  const io = new IntersectionObserver((entries) => entries.forEach((en) => en.isIntersecting && (en.target.classList.add('in'), io.unobserve(en.target))), { rootMargin: '0px 0px -8% 0px' });
  els.forEach((e) => io.observe(e));
}

/** Live/recorded indicator; in recorded mode a step selector drives the page. */
export function modeBar(src, onChange) {
  if (src.mode === 'live') {
    const s = src.state;
    return el('div', { class: 'modebar' }, el('span', { class: 'pill live' }, 'Live'), el('span', { class: 'muted small' }, s.backend === 'offline' ? 'simulated' : 'mainnet'));
  }
  const sel = el('select', { 'aria-label': 'Recorded moment' }, ...src.steps.map((s, i) => el('option', { value: String(i), ...(i === src.index ? { selected: true } : {}) }, `${i + 1} · ${s.time} · ${s.title}`)));
  sel.addEventListener('change', () => {
    src.setIndex(Number(sel.value));
    onChange();
  });
  return el('div', { class: 'modebar' }, el('span', { class: 'pill rec' }, 'Recorded'), sel);
}
