// Public site shell: navigation (with mobile drawer), footer, toast,
// starfield and motion. The signed-in console has its own shell (app/main.js).
import { el } from './ui.js';
import { sky, armReveals } from './motion.js';
import { themeSwitch } from './theme.js';

export const REPO = 'https://github.com/linoxbt/Antibody';

const PAGES = [
  { href: '/', id: 'home', label: 'Overview', hint: '00' },
  { href: '/walkthrough', id: 'walkthrough', label: 'Walkthrough', hint: '01' },
  { href: '/security', id: 'security', label: 'Security', hint: '02' },
  { href: '/install', id: 'install', label: 'Install', hint: '03' },
  { href: '/login', id: 'login', label: 'Sign in', hint: '04' },
];
const NAV_LINKS = ['walkthrough', 'security', 'install'];

function brand() {
  return el('a', { class: 'brand', href: '/', 'aria-label': 'Antibody home' }, el('img', { src: '/assets/img/mark.svg', alt: '', width: 30, height: 30 }), el('span', { class: 'wordmark' }, 'antibody'));
}

export function mountShell(current) {
  const here = (p) => (p.id === current ? { 'aria-current': 'page' } : {});
  const burger = el('button', { class: 'burger', 'aria-label': 'Open menu', 'aria-expanded': 'false', 'aria-controls': 'drawer' }, el('span'), el('span'), el('span'));
  const drawer = el(
    'nav',
    { class: 'drawer', id: 'drawer', 'aria-label': 'Site', 'aria-hidden': 'true' },
    ...PAGES.map((p) => el('a', { href: p.href, ...here(p) }, p.label, el('span', {}, p.hint))),
    el('div', { class: 'drawer-theme' }, el('span', {}, 'Appearance'), themeSwitch()),
    el('a', { class: 'btn btn-primary', href: '/app' }, 'Open console'),
    el('a', { class: 'btn btn-ghost', href: REPO, target: '_blank', rel: 'noopener', style: 'margin-top:10px' }, 'View on GitHub'),
  );
  const header = el(
    'header',
    { class: 'nav' },
    el(
      'div',
      { class: 'wrap' },
      brand(),
      el('nav', { class: 'nav-links', 'aria-label': 'Primary' }, ...PAGES.filter((p) => NAV_LINKS.includes(p.id)).map((p) => el('a', { href: p.href, ...here(p) }, p.label))),
      el('nav', { class: 'nav-links', 'aria-label': 'Resources' }, el('a', { href: REPO, target: '_blank', rel: 'noopener' }, 'GitHub')),
      el('div', { class: 'nav-cta' }, el('a', { class: 'btn btn-ghost btn-sm', href: '/login' }, 'Sign in'), el('a', { class: 'btn btn-primary btn-sm', href: '/app' }, 'Open console')),
      burger,
    ),
  );
  const setOpen = (open) => {
    drawer.classList.toggle('open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    document.body.classList.toggle('no-scroll', open);
    header.classList.toggle('scrolled', open || scrollY > 8);
    if (open) drawer.querySelector('a')?.focus();
  };
  burger.addEventListener('click', () => setOpen(burger.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.classList.contains('open')) {
      setOpen(false);
      burger.focus();
    }
  });
  matchMedia('(min-width: 1081px)').addEventListener('change', (m) => m.matches && setOpen(false));
  const onScroll = () => header.classList.toggle('scrolled', scrollY > 8 || drawer.classList.contains('open'));
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
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
          el('div', {}, brand(), el('p', {}, 'An immune system for agent memory.')),
          col('Product', [['Walkthrough', '/walkthrough'], ['Security', '/security'], ['Install', '/install'], ['Console', '/app']]),
          col('Operate', [['Mainnet runbook', `${REPO}/blob/main/docs/demo-live.md`, true], ['Attack set', `${REPO}/blob/main/docs/attack-set-results.md`, true], ['Design notes', `${REPO}/blob/main/docs/design-notes.md`, true]]),
          col('Project', [['Source', REPO, true], ['Article', `${REPO}/blob/main/docs/blog.md`, true], ['Total Recall', 'https://tatum.io/hackathon/total-recall', true]]),
        ),
        el('div', { class: 'giant', 'aria-hidden': 'true' }, 'antibody'),
        el('div', { class: 'legal' }, el('span', {}, `© ${new Date().getFullYear()} Antibody · MIT · demo data is simulated · `, el('a', { href: '/privacy' }, 'Privacy & terms')), themeSwitch()),
      ),
    ),
  );
  sky();
  armReveals();
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
