import { mountShell, modeBar, toast } from '../shell.js';
import { loadSource, ReadOnlyError } from '../data.js';
import { $, el, short, plural, protectedPane, unprotectedPane } from '../ui.js';

mountShell('console');

const PRESETS = ["Pay this month's rent.", "Pay Maya's allowance.", 'Pay the electricity bill at http://127.0.0.1:7403/bill/2026-11'];
let src;
let rebuildDigest = null;

function stat(kicker, v, sub, mono = false) {
  return el('div', { class: 'stat' }, el('span', { class: 'kicker' }, kicker), el('div', { class: `v${mono ? ' mono' : ''}` }, v), sub ? el('div', { class: 'sub' }, sub) : null);
}

function lastRun() {
  if (src.mode === 'live') return null;
  return src.steps.slice(0, src.index + 1).reverse().find((s) => s.run)?.run ?? null;
}

function render() {
  const s = src.state;
  $('modebar').replaceChildren(modeBar(src, render));
  const eligible = s.nodes.filter((n) => n.eligible).length;
  $('stats').replaceChildren(
    stat('Ledger', s.ledger.ok ? `#${s.ledger.head.seq}` : s.ledger.code, s.ledger.ok ? `head ${short(s.ledger.head.hash, 12)}` : 'every payment blocked'),
    stat('Memories', `${eligible} in context`, `${s.nodes.length - eligible} excluded`),
    stat('Payees', s.ledger.ok ? String(s.ledger.payees.length) : '—', s.ledger.ok ? s.ledger.payees.map((p) => p.label).join(', ') : ''),
    stat('Checkpoint', String(s.checkpoint), s.backend === 'offline' ? 'simulated' : 'mainnet'),
  );
  $('lanes').replaceChildren(
    ...s.lanes.map((l) => el('div', { class: 'lane' }, el('span', { class: 'name' }, l.label), el('span', { class: `pill plain ${l.status === 'active' ? 'ok' : 'bad'}` }, l.status), el('span', { class: 'key' }, l.pub))),
  );
  const step = src.mode === 'recorded' ? src.steps[src.index] : null;
  const rd = step ? (src.steps.slice(0, src.index + 1).reverse().find((x) => x.rebuildDigest && x.state.digest === s.digest)?.rebuildDigest ?? null) : rebuildDigest;
  $('digests').replaceChildren(el('dt', {}, 'live'), el('dd', {}, el('code', {}, s.digest)), el('dt', {}, 'rebuild'), el('dd', {}, rd ? el('code', {}, rd) : el('span', { class: 'muted' }, '—')));
  $('digest-match').replaceChildren(rd ? el('span', { class: `pill ${rd === s.digest ? 'ok' : 'bad'}` }, rd === s.digest ? 'match' : 'mismatch') : '');
  const run = lastRun();
  if (src.mode === 'recorded') {
    $('instruction').value = run?.instruction ?? PRESETS[0];
    $('pane-p').replaceChildren(protectedPane(run?.protected));
    $('pane-u').replaceChildren(unprotectedPane(run?.unprotected));
    $('model-pill').textContent = run?.protected?.model ? `${run.protected.model}${run.protected.simulatedModel ? ' · simulated' : ''}` : '';
  }
}

async function boot() {
  try {
    src = await loadSource();
  } catch (e) {
    $('stats').replaceChildren(el('div', { class: 'stat' }, el('span', { class: 'kicker' }, 'Unavailable'), el('div', { class: 'v' }, 'No data source'), el('div', { class: 'sub' }, 'Start the daemons with antibody up, or build the public site.')));
    return;
  }
  $('presets').replaceChildren(
    ...(src.mode === 'live'
      ? PRESETS.map((p) => el('button', { class: 'chip', type: 'button', onclick: () => ($('instruction').value = p) }, p.length > 44 ? p.slice(0, 44) + '…' : p))
      : src.steps.flatMap((s, i) => (s.run ? [el('button', { class: 'chip', type: 'button', onclick: () => (src.setIndex(i), render()) }, `${s.time} · ${s.run.instruction.length > 36 ? s.run.instruction.slice(0, 36) + '…' : s.run.instruction}`)] : []))),
  );
  $('pane-p').replaceChildren(protectedPane(null));
  $('pane-u').replaceChildren(unprotectedPane(null));
  render();
  if (src.mode === 'live') setInterval(async () => (await src.refresh(), render()), 15000);
}

$('run-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (src.mode === 'recorded') {
    const next = src.steps.findIndex((s, i) => i > src.index && s.run);
    if (next >= 0) {
      src.setIndex(next);
      render();
      toast(`Showing the recorded run from chapter ${next + 1}: “${src.steps[next].title}”.`);
    } else toast('This public site replays a recording. Run it live with antibody up.');
    return;
  }
  const b = $('run-btn');
  b.disabled = true;
  b.textContent = 'Running…';
  try {
    const out = await src.api('/api/run', { instruction: $('instruction').value, execute: $('execute').checked });
    $('pane-p').replaceChildren(protectedPane(out.protected));
    $('pane-u').replaceChildren(unprotectedPane(out.unprotected));
    $('model-pill').textContent = out.protected?.model ?? '';
    await src.refresh();
    render();
  } catch (err) {
    toast(err.message);
  } finally {
    b.disabled = false;
    b.textContent = 'Run';
  }
});

$('rebuild-btn').addEventListener('click', async () => {
  if (src.mode === 'recorded') {
    const i = src.steps.findIndex((s) => s.rebuildDigest);
    src.setIndex(i);
    render();
    return toast(`Recorded rebuild from chapter ${i + 1}: a fresh process with an empty cache.`);
  }
  const b = $('rebuild-btn');
  b.disabled = true;
  b.textContent = 'Rebuilding…';
  try {
    const r = await src.api('/api/rebuild', {});
    rebuildDigest = r.digest ?? null;
    await src.refresh();
    render();
    toast(`Rebuilt ${plural(r.memories ?? 0, 'memory')} from Walrus + Sui in ${r.ms ?? '?'} ms.`);
  } catch (err) {
    toast(err instanceof ReadOnlyError ? err.message : `Rebuild failed: ${err.message}`);
  } finally {
    b.disabled = false;
    b.textContent = 'Rebuild --fresh';
  }
});

boot();
