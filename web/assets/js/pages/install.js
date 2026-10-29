import { mountShell } from '../shell.js';
import { svg } from '../ui.js';

mountShell('install');

// Copy buttons on every command block.
const icon = (d) => svg('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, ...d.map((p) => svg('path', { d: p })));
const COPY = ['M9 9h10v11H9z', 'M5 15V4h10'];
const DONE = ['M5 12.5l4.5 4.5L19 7.5'];
for (const pre of document.querySelectorAll('pre[data-copy]')) {
  const text = pre.textContent;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'copy';
  b.setAttribute('aria-label', 'Copy');
  b.append(icon(COPY));
  b.addEventListener('click', async () => {
    try {
      // Comments stripped, and nothing but plain ASCII-safe text: no stray invisible characters.
      await navigator.clipboard.writeText(text.replace(/\s+#[^\n]*$/gm, '').replace(/[\u0080-\u009f\u200b-\u200f\u2060\ufeff]/g, '').trim());
      b.replaceChildren(icon(DONE));
      setTimeout(() => b.replaceChildren(icon(COPY)), 1400);
    } catch {
      /* clipboard blocked: the text is selectable */
    }
  });
  pre.append(b);
}

// Table of contents follows the reader.
const links = [...document.querySelectorAll('.toc a')];
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) if (e.isIntersecting) links.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `#${e.target.id}`));
  },
  { rootMargin: '-30% 0px -60% 0px' },
);
document.querySelectorAll('.doc section[id]').forEach((s) => io.observe(s));

// Troubleshooting search: matches the message and the fix; opens matches.
const search = document.getElementById('ts-search');
const items = [...document.querySelectorAll('details.ts')];
search.addEventListener('input', () => {
  const q = search.value.trim().toLowerCase();
  let shown = 0;
  for (const d of items) {
    const hit = !q || d.textContent.toLowerCase().includes(q);
    d.hidden = !hit;
    d.open = !!q && hit;
    shown += hit ? 1 : 0;
  }
  document.querySelectorAll('.ts-group').forEach((g) => (g.hidden = ![...g.querySelectorAll('details.ts')].some((d) => !d.hidden)));
  document.getElementById('ts-none').classList.toggle('hidden', shown > 0);
});
// Open the entry a link points at, e.g. /install#troubleshooting from the installer.
if (location.hash === '#troubleshooting') search.focus({ preventScroll: true });
