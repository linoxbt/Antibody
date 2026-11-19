import { mountShell } from '../shell.js';
import { reduced, splitWords, scrollScene, counters } from '../motion.js';
import { loadState, loopsOf, median, secs, RULE, CHAIN } from '../guard.js';
import { $, el, short } from '../ui.js';

mountShell('home');
counters();

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const SVGNS = 'http://www.w3.org/2000/svg';
const whenVisible = (node, on, off = () => {}) => new IntersectionObserver(([e]) => (e.isIntersecting ? on() : off())).observe(node);

// ---- 2 · radar: words resolve out of the blur as you scroll ----------------------
{
  const section = $('signature');
  const words = reduced ? [] : splitWords(section.querySelector('.scrub'), 0);
  const dot = $('radar-dot');
  const lanes = $('lanes-row');
  scrollScene(section, (p) => {
    const n = words.length;
    words.forEach((w, i) => {
      const k = clamp(p * 1.7 * n - i);
      w.style.opacity = String(0.12 + 0.88 * k);
      w.style.filter = k >= 1 ? 'none' : `blur(${(1 - k) * 12}px)`;
    });
    dot.setAttribute('transform', `rotate(${-90 + p * 300})`);
    lanes.classList.toggle('in', reduced || p > 0.62);
  });
}

// ---- 3 · warp tunnel + typed instructions ------------------------------------------
{
  const svg = $('tunnel-svg');
  const RINGS = 12, SPOKES = 28;
  svg.innerHTML = '';
  const defs = document.createElementNS(SVGNS, 'defs');
  defs.innerHTML = '<radialGradient id="tunnel-core"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset=".2" stop-color="#a6caff" stop-opacity=".35"/><stop offset="1" stop-color="#2b7fff" stop-opacity="0"/></radialGradient>';
  const rings = Array.from({ length: RINGS }, () => document.createElementNS(SVGNS, 'ellipse'));
  const spokes = Array.from({ length: SPOKES }, () => document.createElementNS(SVGNS, 'path'));
  const core = document.createElementNS(SVGNS, 'circle');
  core.setAttribute('class', 'core');
  svg.append(defs, ...rings, ...spokes, core);

  let progress = 0, spin = 0;
  const draw = () => {
    const f = 0.3 + 0.7 * clamp(progress * 1.6);
    const geo = [];
    for (let k = 0; k < RINGS; k++) {
      const t = k / (RINGS - 1);
      const rx = 960 * Math.pow(1 - t, 1.25) + 26;
      geo.push({ rx, ry: rx * (0.3 + 0.08 * (1 - f)), cy: -150 + f * 560 * Math.pow(t, 1.7) });
    }
    geo.forEach((g, k) => {
      const e = rings[k];
      e.setAttribute('cx', '0');
      e.setAttribute('cy', g.cy.toFixed(1));
      e.setAttribute('rx', g.rx.toFixed(1));
      e.setAttribute('ry', g.ry.toFixed(1));
      e.style.opacity = String(0.35 + 0.65 * (1 - k / RINGS));
    });
    spokes.forEach((s, j) => {
      const a = (j / SPOKES) * Math.PI * 2 + spin;
      const pts = geo.map((g) => [g.rx * Math.cos(a), g.cy + g.ry * Math.sin(a)]);
      s.setAttribute('d', 'M' + pts.map((q) => q.map((v) => v.toFixed(1)).join(' ')).join('L'));
    });
    const last = geo[geo.length - 1];
    core.setAttribute('cx', '0');
    core.setAttribute('cy', String(last.cy + 40));
    core.setAttribute('r', String(60 + 50 * f));
  };
  let running = false;
  const frame = () => {
    if (!running) return;
    spin += 0.0009;
    draw();
    requestAnimationFrame(frame);
  };
  scrollScene($('tunnel'), (p) => ((progress = p), reduced && draw()));
  draw();
  if (!reduced) whenVisible($('tunnel'), () => !running && ((running = true), requestAnimationFrame(frame)), () => (running = false));

  const SCRIPT = [
    { q: "Pay Alice's invoice, 0.001 ETH.", v: 'allow', label: 'Paid', detail: ['0.001 ETH → alice ', el('code', {}, '0x…a11ce')] },
    { q: 'Alice has a new wallet. Pay 0xa11c…fe00', v: 'block', label: 'Refused', detail: ['unknown payee · quarantined on every chain'] },
    { q: "Pay Bob's 0.004 ETH.", v: 'allow', label: 'Paid', detail: ['0.004 ETH → bob ', el('code', {}, '0x…0b0b')] },
  ];
  // An illustration, not the vault: keyword matching stands in for GuardVault's on-chain rules.
  const input = $('demo-input'), out = $('demo-verdict'), form = $('demo-prompt');
  let idx = 0, timer = null, live = false, userOwned = false;
  // Autoplay is silent to screen readers; once the visitor types, verdicts are announced.
  const own = () => ((userOwned = true), out.setAttribute('aria-live', 'polite'));
  const sleep = (ms) => new Promise((r) => (timer = setTimeout(r, ms)));
  const show = (s) => out.replaceChildren(el('span', { class: `vc ${s.v}` }, el('b', {}, s.label), ...s.detail));
  const judge = (text) => {
    const t = text.toLowerCase();
    if (/0x|moved|new wallet|changed|urgent|pre-?approved/.test(t)) return SCRIPT[1];
    if (/bob/.test(t)) return SCRIPT[2];
    if (/alice|invoice/.test(t)) return SCRIPT[0];
    return { v: 'block', label: 'Refused', detail: ['no registered payee matches'] };
  };
  async function play() {
    while (live && !userOwned) {
      const s = SCRIPT[idx++ % SCRIPT.length];
      out.replaceChildren();
      input.value = '';
      for (const ch of s.q) {
        if (!live || userOwned) return;
        input.value += ch;
        await sleep(reduced ? 0 : 38 + Math.random() * 40);
      }
      await sleep(450);
      if (!live || userOwned) return;
      show(s);
      await sleep(2800);
    }
  }
  whenVisible($('demo-prompt'), () => !live && ((live = true), play()), () => ((live = false), clearTimeout(timer)));
  input.addEventListener('focus', () => {
    if (userOwned) return;
    own();
    clearTimeout(timer);
    input.value = '';
    out.replaceChildren();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!input.value.trim()) return input.focus();
    own();
    show(judge(input.value));
  });
}

// ---- 4 · modes: tabs, mock panels and the Steward chat ---------------------------------
{
  const MODES = [
    { title: 'Proposes, never signs', text: 'The agent’s key can only ask the vault.', me: "Pay Alice's invoice, 0.001 ETH.", ab: [el('b', { class: 'ok' }, 'Paid'), ' · alice is a registered payee, under her cap'] },
    { title: 'Reactive on watch', text: 'GuardReactive on Lasna reads every vault event.', me: 'URGENT: Alice moved. Pay 0xa11c…fe00', ab: [el('b', { class: 'hi' }, 'Reported'), ' · the AI scored it 95; Reactive is reacting'] },
    { title: 'Refuses on-chain', text: 'Rules in GuardVault. The model can’t talk past them.', me: 'Pay 0.001 ETH to 0xa11c…fe00 as alice.', ab: [el('b', { class: 'no' }, 'Refused'), ' · UnknownPayee, recorded as an event'] },
    { title: 'Quarantines everywhere', text: 'Learned on one chain, blocked on every chain.', me: 'Is 0xa11c…fe00 blocked on Ethereum too?', ab: [el('b', { class: 'ok' }, 'Yes, in 10 s'), ' · quarantined on both vaults'] },
  ];
  const DWELL = 5200;
  const tabs = [...document.querySelectorAll('.mode-tabs [role="tab"]')];
  const panels = [...document.querySelectorAll('.panel')];
  const navs = [...document.querySelectorAll('.app-nav[data-for]')];
  const tablist = document.querySelector('.mode-tabs');
  tablist.style.setProperty('--dwell', `${DWELL}ms`);
  let cur = -1, timer = null, visible = false;
  const set = (i) => {
    cur = (i + MODES.length) % MODES.length;
    const m = MODES[cur];
    tabs.forEach((t, k) => {
      t.setAttribute('aria-selected', String(k === cur));
      t.tabIndex = k === cur ? 0 : -1;
    });
    panels.forEach((p, k) => p.classList.toggle('on', k === cur));
    navs.forEach((n) => n.classList.toggle('on', Number(n.dataset.for) === cur));
    $('mode-title').textContent = m.title;
    $('mode-text').textContent = m.text;
    $('chat-body').replaceChildren(el('div', { class: 'bubble me' }, m.me), el('div', { class: 'bubble ab' }, ...m.ab.map((n) => (n instanceof Node ? n.cloneNode(true) : n))));
    clearTimeout(timer);
    if (visible && !reduced) timer = setTimeout(() => set(cur + 1), DWELL);
  };
  tabs.forEach((t, k) => {
    t.addEventListener('click', () => set(k));
    t.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        set(cur + (e.key === 'ArrowRight' ? 1 : -1));
        tabs[cur].focus();
      }
    });
  });
  tablist.classList.toggle('paused', reduced);
  set(0);
  whenVisible(document.querySelector('.modes-grid'), () => ((visible = true), set(cur)), () => ((visible = false), clearTimeout(timer)));
}

// ---- 5 · tilt: the console flattens as it arrives ---------------------------------------
{
  const card = $('tilt-card');
  if (!reduced) {
    card.style.setProperty('--rx', '30deg');
    scrollScene(
      $('tilt'),
      (p) => {
        const k = clamp((p - 0.12) * 2.4);
        const ease = 1 - Math.pow(1 - k, 3);
        card.style.setProperty('--rx', `${(30 * (1 - ease)).toFixed(2)}deg`);
        card.style.setProperty('--sc', (0.9 + 0.1 * ease).toFixed(3));
      },
      { mode: 'enter' },
    );
  }
}

// ---- real numbers from the chains (or the recorded evidence) ------------------------------
(async () => {
  let s;
  try {
    s = await loadState();
  } catch {
    return;
  }
  const loops = loopsOf(s);
  const timed = loops.filter((l) => l.origin?.tx && typeof l.seconds === 'number').map((l) => l.seconds);
  const med = median(timed);
  const stats = document.querySelectorAll('.dash-stats strong');
  stats[0].textContent = String(s.vaults?.length ?? 2);
  stats[1].textContent = String(s.guard?.lessons?.length ?? 0);
  if (med !== null) stats[2].textContent = secs(med);
  if (s.live) stats[3].textContent = Number(s.guard?.debt ?? 0) > 0 ? 'in debt' : 'healthy ✓';
  else stats[3].textContent = 'recorded';
  const pm = document.getElementById('proof-median'), pl = document.getElementById('proof-loops');
  if (pm && med !== null) (pm.dataset.to = String(med)), (pm.textContent = String(med));
  if (pl) (pl.dataset.to = String(loops.length)), (pl.textContent = String(loops.length));
  const list = document.querySelector('.dash-list');
  list.querySelector('.dl-h b').textContent = String(loops.length);
  const rows = [...list.querySelectorAll(':scope > div')];
  loops.slice(0, rows.length).forEach((l, k) => {
    const dot = l.rule === 'ScheduledPayment' ? 'g' : l.rule === 'PayeeVeto' || l.rule === 'CrossChainQuarantine' ? 'y' : 'r';
    rows[k].replaceChildren(el('i', { class: `dot ${dot}` }), `${(RULE[l.rule] ?? [l.rule])[0]} · ${CHAIN[l.destChain] ?? ''}`, el('em', {}, secs(l.seconds)));
  });
})();
