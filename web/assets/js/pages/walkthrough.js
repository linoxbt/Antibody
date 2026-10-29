import { mountShell } from '../shell.js';
import { loadDemo } from '../data.js';
import { $, el, short, plural, protectedPane, unprotectedPane, renderGraph } from '../ui.js';

mountShell('walkthrough');

let demo;
let i = 0;
let timer = null;
const DWELL = 11000;

function setChapter(n, push = true) {
  i = Math.max(0, Math.min(demo.steps.length - 1, n));
  if (push) history.replaceState(null, '', `#chapter-${i + 1}`);
  render();
}

function ledgerDelta(prev, cur) {
  if (!cur.ledger.ok) return [];
  const before = prev?.ledger.ok ? prev.ledger.records.length : 0;
  return cur.ledger.records.slice(before);
}

function evidence(step, prev) {
  const s = step.state;
  const out = [];
  if (step.run) {
    out.push(
      el(
        'section',
        { class: 'card' },
        el('div', { class: 'card-title' }, el('div', {}, el('h3', {}, 'Split screen'), el('p', {}, `“${step.run.instruction}” — same model, same memories.`))),
        el('div', { class: 'split' }, el('div', { class: 'pane protected' }, el('div', { class: 'pane-head' }, el('span', { class: 'kicker' }, 'Steward + Antibody')), protectedPane(step.run.protected)), el('div', { class: 'pane unprotected' }, el('div', { class: 'pane-head' }, el('span', { class: 'kicker' }, 'Unprotected agent')), unprotectedPane(step.run.unprotected))),
      ),
    );
  }
  if (step.rebuildDigest) {
    const ok = step.rebuildDigest === s.digest;
    out.push(
      el(
        'section',
        { class: 'card gold' },
        el('div', { class: 'card-title' }, el('div', {}, el('h3', {}, 'Projection digests'), el('p', {}, 'Live process versus a fresh process that read only Walrus and Sui.')), el('span', { class: `pill ${ok ? 'ok' : 'bad'}` }, ok ? 'match' : 'mismatch')),
        el('dl', { class: 'kv' }, el('dt', {}, 'live'), el('dd', {}, el('code', {}, s.digest)), el('dt', {}, 'rebuild'), el('dd', {}, el('code', {}, step.rebuildDigest))),
      ),
    );
  }
  const graphHost = el('div', { class: 'graph-wrap graph' });
  const qs = s.ledger.ok ? s.ledger.quarantines : [];
  out.push(
    el(
      'section',
      { class: 'card' },
      el('div', { class: 'card-title' }, el('div', {}, el('h3', {}, 'Memory at this moment'), el('p', {}, `${plural(s.nodes.length, 'memory')} · ${s.nodes.filter((n) => !n.eligible).length} excluded · ${step.highlight !== undefined ? `highlighting quarantine #${step.highlight}` : 'coloured by trust class'}`)), el('a', { class: 'btn btn-ghost btn-sm', href: `/graph?step=${i + 1}` }, 'Open in explorer')),
      graphHost,
    ),
  );
  queueMicrotask(() => renderGraph(graphHost, s.nodes, { highlightSeq: step.highlight ?? null, quarantines: qs, nodeW: 196, colW: 236 }));
  const added = ledgerDelta(prev?.state, s);
  const newInc = s.incidents.filter((x) => !(prev?.state.incidents ?? []).some((p) => p.id === x.id && p.status === x.status));
  if (added.length || newInc.length) {
    out.push(
      el(
        'section',
        { class: added.length && newInc.length ? 'grid-2' : '' },
        added.length
          ? el('div', { class: 'card' }, el('div', { class: 'card-title' }, el('div', {}, el('h3', {}, 'Written to the ledger'), el('p', {}, 'Hash-chained records on Walrus.'))), el('div', { class: 'feed' }, ...added.map((r) => el('div', { class: 'item' }, el('div', { class: 'item-head' }, el('span', { class: 'mono small' }, `#${r.seq}`), el('span', { class: 'tag record' }, r.type), el('code', {}, short(r.blobId, 14)))))))
          : null,
        newInc.length
          ? el('div', { class: 'card' }, el('div', { class: 'card-title' }, el('div', {}, el('h3', {}, 'Sentinel'), el('p', {}, 'Incidents raised by the ingest worker.'))), el('div', { class: 'feed' }, ...newInc.map((x) => el('div', { class: 'item' }, el('div', { class: 'item-head' }, el('span', { class: `pill plain ${x.status === 'open' ? 'rec' : 'bad'}` }, x.status.replace('-', ' ')), el('span', { class: 'mono small' }, `score ${x.score}`)), el('p', {}, x.rules.map((r) => r.split(':')[0]).filter((v, k, a) => a.indexOf(v) === k).join(' · '))))))
          : null,
      ),
    );
  }
  return out;
}

function render() {
  const step = demo.steps[i];
  $('chapters').replaceChildren(
    ...demo.steps.map((s, k) =>
      el('li', {}, el('button', { class: `chapter${k === i ? ' on' : ''}${k < i ? ' done' : ''}`, 'aria-current': k === i ? 'step' : null, onclick: () => (stop(), setChapter(k)) }, el('span', { class: 'time' }, s.time), el('span', { class: 'ttl' }, s.title))),
    ),
  );
  $('wt-time').textContent = `Chapter ${i + 1} of ${demo.steps.length} · ${step.time}`;
  $('wt-title').textContent = step.title;
  $('wt-text').textContent = step.text;
  $('bar').style.width = `${((i + 1) / demo.steps.length) * 100}%`;
  $('prev').disabled = i === 0;
  $('next').disabled = i === demo.steps.length - 1;
  $('evidence').replaceChildren(...evidence(step, demo.steps[i - 1]));
}

function stop() {
  clearInterval(timer);
  timer = null;
  $('play').textContent = 'Autoplay';
}

$('play').addEventListener('click', () => {
  if (timer) return stop();
  $('play').textContent = 'Pause';
  if (i === demo.steps.length - 1) setChapter(0);
  timer = setInterval(() => (i >= demo.steps.length - 1 ? stop() : setChapter(i + 1)), DWELL);
});
$('prev').addEventListener('click', () => (stop(), setChapter(i - 1)));
$('next').addEventListener('click', () => (stop(), setChapter(i + 1)));
document.addEventListener('keydown', (e) => {
  if (!demo || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if (e.key === 'ArrowRight') (stop(), setChapter(i + 1));
  if (e.key === 'ArrowLeft') (stop(), setChapter(i - 1));
});

(async () => {
  try {
    demo = await loadDemo();
  } catch {
    $('evidence').replaceChildren(el('div', { class: 'card' }, el('h3', {}, 'No recording on this server'), el('p', { class: 'muted' }, 'Generate one with npx tsx scripts/build-site.ts, or use the live console.'), el('a', { class: 'btn btn-gold', href: '/console', style: 'margin-top:12px' }, 'Open the console')));
    return;
  }
  const m = /chapter-(\d+)/.exec(location.hash);
  setChapter(m ? Number(m[1]) - 1 : 0, false);
})();
