// Motion: the starfield behind every page, blur-in word reveals, scroll-linked
// scenes and counters. Everything degrades to static, fully visible content
// when scripts are off or the visitor prefers reduced motion.

export const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

/** A canvas starfield with twinkle, scroll parallax and the odd shooting star. */
export function sky() {
  const host = document.createElement('div');
  host.className = 'sky';
  host.setAttribute('aria-hidden', 'true');
  const c = document.createElement('canvas');
  host.append(c);
  document.body.prepend(host);
  const ctx = c.getContext('2d');
  if (!ctx) return;
  let w = 0, h = 0, stars = [], meteor = null, nextMeteor = 3000;
  let ink = '#fff';
  const readInk = () => (ink = getComputedStyle(document.documentElement).getPropertyValue('--star').trim() || '#fff');
  readInk();
  addEventListener('themechange', () => (readInk(), reduced && draw(0)));
  const depth = 1.6;

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = innerWidth;
    h = innerHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round((w * h * depth) / 7000);
    stars = Array.from({ length: n }, () => {
      const big = Math.random() > 0.94;
      return { x: Math.random() * w, y: Math.random() * h * depth, r: big ? 0.9 + Math.random() * 0.9 : 0.25 + Math.random() * 0.7, a: 0.25 + Math.random() * 0.6, tw: 0.0006 + Math.random() * 0.0018, ph: Math.random() * 6.283, z: 0.04 + Math.random() * 0.22 };
    });
  }

  function draw(t) {
    ctx.clearRect(0, 0, w, h);
    const sy = scrollY, span = h * depth;
    ctx.fillStyle = ink;
    for (const s of stars) {
      let y = (s.y - sy * s.z) % span;
      if (y < 0) y += span;
      if (y > h) continue;
      const a = reduced ? s.a : s.a * (0.55 + 0.45 * Math.sin(t * s.tw + s.ph));
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.arc(s.x, y, s.r, 0, 6.283);
      ctx.fill();
      if (s.r > 0.9) {
        ctx.globalAlpha = a * 0.18;
        ctx.beginPath();
        ctx.arc(s.x, y, s.r * 4, 0, 6.283);
        ctx.fill();
      }
    }
    if (!reduced) {
      if (!meteor && t > nextMeteor) meteor = { x: w * (0.2 + Math.random() * 0.7), y: h * Math.random() * 0.4, vx: -(4 + Math.random() * 3), vy: 2 + Math.random() * 1.5, life: 0 };
      if (meteor) {
        meteor.life += 1;
        meteor.x += meteor.vx;
        meteor.y += meteor.vy;
        const g = ctx.createLinearGradient(meteor.x, meteor.y, meteor.x - meteor.vx * 18, meteor.y - meteor.vy * 18);
        g.addColorStop(0, ink);
        g.addColorStop(1, 'transparent');
        ctx.globalAlpha = clamp(1 - meteor.life / 70);
        ctx.strokeStyle = g;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(meteor.x, meteor.y);
        ctx.lineTo(meteor.x - meteor.vx * 18, meteor.y - meteor.vy * 18);
        ctx.stroke();
        if (meteor.life > 70) (meteor = null), (nextMeteor = t + 6000 + Math.random() * 9000);
      }
    }
    ctx.globalAlpha = 1;
  }

  resize();
  addEventListener('resize', resize);
  if (reduced) {
    draw(0);
    addEventListener('scroll', () => draw(0), { passive: true });
    addEventListener('resize', () => draw(0));
    return;
  }
  const frame = (t) => {
    draw(t);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Wrap each word of a heading in a span so it can blur in; a .tail moves as one unit. */
export function splitWords(node, step = 70) {
  let i = 0;
  const walk = (n) => {
    for (const ch of [...n.childNodes]) {
      if (ch.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment();
        for (const part of ch.textContent.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) frag.append(part);
          else {
            const s = document.createElement('span');
            s.className = 'w';
            s.textContent = part;
            s.style.transitionDelay = `${i++ * step}ms`;
            frag.append(s);
          }
        }
        ch.replaceWith(frag);
      } else if (ch.nodeType === Node.ELEMENT_NODE && ch.classList.contains('tail')) {
        ch.classList.add('w');
        ch.style.transitionDelay = `${i++ * step}ms`;
      } else if (ch.nodeType === Node.ELEMENT_NODE && ch.tagName !== 'BR') walk(ch);
    }
  };
  walk(node);
  return [...node.querySelectorAll('.w')];
}

/** Arm reveal-on-scroll for .reveal blocks and .words headings. */
export function armReveals(root = document) {
  if (reduced || !('IntersectionObserver' in window)) return;
  root.querySelectorAll('.words').forEach((h) => splitWords(h));
  document.documentElement.classList.add('motion');
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add('in'), io.unobserve(e.target))),
    { rootMargin: '0px 0px -10% 0px' },
  );
  root.querySelectorAll('.reveal, .words').forEach((e) => io.observe(e));
}

/** Call fn(progress 0..1) as a tall element scrolls through the viewport. */
export function scrollScene(el, fn, { mode = 'sticky' } = {}) {
  let queued = false;
  const update = () => {
    queued = false;
    const r = el.getBoundingClientRect();
    if (r.bottom < -200 || r.top > innerHeight + 200) return;
    const p = mode === 'sticky' ? clamp(-r.top / Math.max(1, r.height - innerHeight)) : clamp((innerHeight - r.top) / (innerHeight + r.height));
    fn(p);
  };
  const onScroll = () => {
    if (!queued) (queued = true), requestAnimationFrame(update);
  };
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll);
  update();
  return update;
}

/** Count .count elements from data-from down (or up) to data-to once visible. */
export function counters(root = document) {
  const els = root.querySelectorAll('.count');
  if (reduced || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) =>
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      io.unobserve(e.target);
      const from = Number(e.target.dataset.from ?? 0), to = Number(e.target.dataset.to ?? 0), t0 = performance.now(), dur = 1600;
      const tick = (t) => {
        const k = clamp((t - t0) / dur), ease = 1 - Math.pow(1 - k, 3);
        e.target.textContent = String(Math.round(from + (to - from) * ease));
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
  );
  els.forEach((e) => io.observe(e));
}
