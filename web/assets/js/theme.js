// Dark (default) and soft light. The choice is remembered per browser.
import { svg } from './ui.js';

const KEY = 'antibody.theme';
const META = { dark: '#030407', light: '#f7f6f2' };

export const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

export function setTheme(t) {
  if (t === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* storage unavailable: this page only */
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META[t]);
  dispatchEvent(new CustomEvent('themechange', { detail: t }));
}

const SUN = ['M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0', 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'];
const MOON = ['M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'];
const icon = (paths) => svg('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, ...paths.map((d) => svg('path', { d })));

/** A button that flips the theme; shows the sun in dark (go light) and the moon in light. */
export function themeButton() {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'theme-btn';
  const paint = () => {
    const light = theme() === 'light';
    b.replaceChildren(icon(light ? MOON : SUN));
    b.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to soft light theme');
    b.title = light ? 'Dark theme' : 'Soft light theme';
  };
  b.addEventListener('click', () => setTheme(theme() === 'light' ? 'dark' : 'light'));
  addEventListener('themechange', paint);
  paint();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META[theme()]);
  return b;
}
