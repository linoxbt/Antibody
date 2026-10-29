// Small building blocks shared by the console views.
import { el, svg, short } from '../ui.js';

// 24px stroke icons, drawn for Antibody.
const PATHS = {
  overview: ['M4 4h7v7H4z', 'M13 4h7v4h-7z', 'M13 10h7v10h-7z', 'M4 13h7v7H4z'],
  steward: ['M12 3l2.2 5.3L20 9.5l-4.4 3.8L17 19l-5-3-5 3 1.4-5.7L4 9.5l5.8-1.2z'],
  memory: ['M6 6m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0', 'M18 6m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0', 'M12 18m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0', 'M8.5 6h7', 'M7.2 8.2l3.6 7.5', 'M16.8 8.2l-3.6 7.5'],
  payees: ['M9 8m-3.5 0a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0', 'M3 20c.6-3.4 3-5.5 6-5.5s5.4 2.1 6 5.5', 'M16 4.5a3.5 3.5 0 0 1 0 7', 'M18 14.8c1.7.8 2.8 2.6 3 5.2'],
  ledger: ['M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z', 'M5 17a3 3 0 0 1 3-3h11', 'M9 8h6'],
  incidents: ['M12 3l8 3v6c0 4.5-3.3 8-8 9-4.7-1-8-4.5-8-9V6z', 'M12 8v5', 'M12 16v.5'],
  keys: ['M8 15m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0', 'M11 12l8-8', 'M16 7l2.5 2.5', 'M14 9l2 2'],
  settings: ['M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0', 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1'],
  logout: ['M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3', 'M10 8l-4 4 4 4', 'M6 12h10'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  refresh: ['M20 11a8 8 0 0 0-14.7-4.4L4 8', 'M4 4v4h4', 'M4 13a8 8 0 0 0 14.7 4.4L20 16', 'M20 20v-4h-4'],
  copy: ['M9 9h10v11H9z', 'M5 15V4h10'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
  play: ['M8 5v14l11-7z'],
};

export function icon(name) {
  return svg('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, ...(PATHS[name] ?? []).map((d) => svg('path', { d })));
}

/** A deterministic gradient tile for an address or id. */
export function avatar(seed, round = false) {
  let h = 0;
  for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const a = h % 360, b = (a + 40 + (h >> 9) % 80) % 360;
  const label = String(seed).replace(/^0x/, '').slice(0, 1).toUpperCase();
  return el('span', { class: `avatar${round ? ' round' : ''}`, style: `background:linear-gradient(135deg,hsl(${a} 90% 78%),hsl(${b} 85% 60%))`, 'aria-hidden': 'true' }, label);
}

export function head(title, tail, sub, ...actions) {
  return el(
    'div',
    { class: 'view-head' },
    el('div', {}, el('h1', {}, title, tail ? ' ' : '', tail ? el('span', { class: 'tail' }, tail) : null), sub ? el('p', {}, sub) : null),
    actions.length ? el('div', { class: 'actions' }, ...actions) : null,
  );
}

export function stat(kicker, v, sub, mono = false) {
  return el('div', { class: 'stat' }, el('span', { class: 'kicker' }, kicker), el('div', { class: `v${mono ? ' mono' : ''}` }, v), sub ? el('div', { class: 'sub' }, sub) : null);
}

export function card(title, right, ...body) {
  return el('section', { class: 'card' }, el('div', { class: 'card-title' }, el('h3', {}, title), right ?? null), ...body);
}

/** A shell command with a copy button. Commands that need a human key are run, not clicked. */
export function command(text) {
  const btn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Copy command', title: 'Copy' }, icon('copy'));
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.replaceChildren(icon('check'));
      setTimeout(() => btn.replaceChildren(icon('copy')), 1400);
    } catch {
      /* clipboard blocked: the text is selectable */
    }
  });
  return el('div', { class: 'cmd' }, el('pre', { class: 'quote' }, text), btn);
}

export const navLink = (href, text, cls = '') => el('a', { href, 'data-nav': '', class: cls }, text);

/** Base units → display, for coins whose decimals we know from the type. */
export function amount(base, coinType = '') {
  const decimals = /::usdc::USDC$/i.test(coinType) ? 6 : /::sui::SUI$/.test(coinType) ? 9 : null;
  if (decimals === null) return `${base} base units`;
  const b = BigInt(base);
  const d = 10n ** BigInt(decimals);
  const frac = (b % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${b / d}${frac ? '.' + frac : ''} ${coinType.split('::').at(-1)}`;
}

/** "≈ $450.00" from the node's display rates (Tatum Data API), or nothing when the coin isn't priced. */
export function usd(amountDisplay, symbol, rates) {
  const r = rates?.[symbol];
  const n = Number(amountDisplay);
  if (!r || !Number.isFinite(n)) return null;
  const v = n * r.usd;
  const text = `≈ $${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return el('span', { class: 'muted small', title: `${r.source} · 1 ${symbol} = $${r.usd}${r.simulated ? ' · simulated' : ''}` }, text);
}

export const shortAddr = (a) => (a && a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a ?? '');

/** The verdict a decision memory recorded, e.g. "ALLOW" or "BLOCK LABEL_MISMATCH". */
export function decisionVerdict(n) {
  return /Payment decision: (\w+)( \w+)?/.exec(n.text)?.slice(1).join('').trim() ?? '';
}

export { short };
