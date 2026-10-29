// Antibody web view. Memory text is attacker-controlled: everything is
// rendered with textContent / DOM nodes, never innerHTML.

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) e.append(c instanceof Node ? c : String(c));
  return e;
}

function svg(tag, attrs = {}) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

const short = (s, n = 10) => (s && s.length > n + 3 ? `${s.slice(0, n)}…` : s ?? '');

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-antibody-ui': '1' }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

let state = null;
let selected = null;
let highlightSeq = null;
let rebuildDigest = null;

// ---------------------------------------------------------------------------

function renderBanners() {
  const b = $('banners');
  b.replaceChildren(...state.banners.map((t) => el('div', {}, t)));
}

function renderDigests() {
  $('digest-live').textContent = state.digest;
  $('digest-live').title = state.digest;
  const m = $('digest-match');
  if (rebuildDigest) {
    $('digest-rebuild').textContent = rebuildDigest;
    $('digest-rebuild').title = rebuildDigest;
    const same = rebuildDigest === state.digest;
    m.className = `pill ${same ? 'ok' : 'bad'}`;
    m.textContent = same ? 'digests match: quarantine survived restoration' : 'digests differ';
  } else {
    m.className = 'pill';
    m.textContent = '';
  }
}

function renderLanes() {
  $('lanes').replaceChildren(
    ...state.lanes.map((l) =>
      el('div', { class: 'lane' }, el('span', { class: 'name' }, l.label), el('span', { class: `status ${l.status}` }, l.status), el('code', { title: l.pub }, l.pub)),
    ),
  );
  $('account').replaceChildren(
    el('div', {}, 'account ', el('code', {}, state.account.id)),
    el('div', {}, 'wallet ', el('code', {}, state.wallet ?? '—')),
    el('div', {}, `checkpoint ${state.checkpoint} · chain ${state.chain}`),
  );
}

function verdictBlock(d) {
  const v = d.verdict;
  const ok = v.decision === 'ALLOW';
  const rules = el('ul', { class: 'rules' }, ...v.rules.map((r) => el('li', { class: r.pass ? 'pass' : 'fail' }, `${r.rule} `, el('span', { class: 'muted' }, r.detail))));
  return el(
    'div',
    {},
    el('div', { class: `verdict ${ok ? 'allow' : 'block'}` }, ok ? 'ALLOW' : `BLOCK ${v.code}`),
    el('div', {}, v.reasons.join('; ')),
    rules,
    el('div', { class: 'small muted' }, `decision ${short(d.decisionId, 13)} · ${d.txDigest ? `tx ${d.txDigest}` : d.dryRunOnly ? 'dry-run only' : 'nothing signed'}`),
  );
}

function renderRun(out) {
  const p = out.protected;
  const pp = $('pane-protected').querySelector('.body');
  pp.className = 'body';
  if (p.error) pp.replaceChildren(el('div', { class: 'err' }, p.error), el('div', { class: 'small muted' }, 'Is the agent daemon running? antibody up'));
  else {
    const recall = p.steps.find((s) => s.tool === 'recall_memories');
    const items = recall?.result?.items ?? [];
    const lbl = (l) => (l.startsWith('[USER') ? 'trusted' : l.startsWith('[AGENT') ? 'derived' : 'untrusted');
    pp.replaceChildren(
      el('div', { class: 'small muted' }, `model ${p.model}${p.simulatedModel ? ' (SIMULATED)' : ''} · readSet ${p.readSet.length}`),
      el('ul', { class: 'ctx' }, ...items.map((i) => el('li', {}, el('span', { class: `lbl ${lbl(i.label)}` }, i.label), ' ', i.text.split('\n')[0].slice(0, 140)))),
      ...(p.notes.length ? [el('div', { class: 'small' }, `wrote ${p.notes.length} note(s) with runtime parents ${p.notes.map((n) => n.parents.length).join(', ')}`)] : []),
      ...p.decisions.map(verdictBlock),
      ...(p.decisions.length === 0 ? [el('div', { class: 'muted' }, p.final ?? 'no payment proposed')] : []),
    );
  }
  const u = out.unprotected;
  const up = $('pane-unprotected').querySelector('.body');
  up.className = 'body';
  if (u.error) up.replaceChildren(el('div', { class: 'err' }, u.error));
  else if (u.wouldSend) {
    up.replaceChildren(
      el('div', { class: 'verdict would' }, `would have sent ${u.wouldSend.amount} ${u.wouldSend.symbol}`),
      el('div', {}, 'to ', el('code', {}, u.wouldSend.recipient)),
      el('div', { class: 'small muted' }, `dry-run ${u.wouldSend.dryRunOk ? 'succeeds' : `fails: ${u.wouldSend.dryRunError}`} · never signed`),
    );
  } else up.replaceChildren(el('div', { class: 'muted' }, u.final ?? 'proposed no payment'));
}

// ---- graph ----------------------------------------------------------------

const NODE_W = 212;

function layout(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map();
  const d = (id, stack = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (stack.has(id)) return 0;
    stack.add(id);
    const n = byId.get(id);
    const ps = (n?.parents ?? []).filter((p) => byId.has(p));
    const v = ps.length ? 1 + Math.max(...ps.map((p) => d(p, stack))) : n?.lane === 'wallet-objects' ? 1 : 1;
    depth.set(id, v);
    return v;
  };
  nodes.forEach((n) => d(n.id));
  // Source objects (from observations) sit in column 0.
  const sources = [];
  for (const n of nodes) {
    if (n.lane !== 'wallet-objects') continue;
    const o = n.src.find((s) => s.t === 'sui-object');
    if (o && !sources.some((s) => s.id === o.id)) sources.push({ id: o.id, type: o.type, obs: [] });
    if (o) sources.find((s) => s.id === o.id).obs.push(n.id);
  }
  const cols = new Map();
  for (const n of nodes) {
    const c = depth.get(n.id);
    if (!cols.has(c)) cols.set(c, []);
    cols.get(c).push(n);
  }
  const W = 250, H = 56, PADX = 24, PADY = 16;
  const pos = new Map();
  sources.forEach((s, i) => pos.set(`src:${s.id}`, { x: PADX, y: PADY + i * H }));
  for (const [c, list] of [...cols.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => (a.lane + a.ckpt).localeCompare(b.lane + b.ckpt));
    list.forEach((n, i) => pos.set(n.id, { x: PADX + c * W, y: PADY + i * H }));
  }
  const maxCol = Math.max(1, ...cols.keys());
  const maxRows = Math.max(sources.length, ...[...cols.values()].map((l) => l.length), 1);
  return { pos, sources, width: PADX * 2 + (maxCol + 1) * W, height: PADY * 2 + maxRows * H };
}

function renderGraph() {
  const g = $('graph');
  const nodes = state.nodes;
  const { pos, sources, width, height } = layout(nodes);
  g.setAttribute('viewBox', `0 0 ${width} ${height}`);
  g.setAttribute('width', width);
  g.setAttribute('height', height);
  g.replaceChildren();
  const hot = new Set(highlightSeq === null ? [] : nodes.filter((n) => n.seedHits.includes(highlightSeq)).map((n) => n.id));
  const hotSrc = new Set();
  if (highlightSeq !== null) {
    const q = state.ledger.quarantines?.find((x) => x.seq === highlightSeq);
    if (q?.seed.type === 'source') hotSrc.add(`src:${q.seed.value}`);
  }
  const edge = (a, b, isHot) => {
    const p = pos.get(a), q = pos.get(b);
    if (!p || !q) return;
    const x1 = p.x + NODE_W, y1 = p.y + 18, x2 = q.x, y2 = q.y + 18;
    const mx = (x1 + x2) / 2;
    g.append(svg('path', { d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, class: `edge${isHot ? ' hot' : ''}` }));
  };
  for (const s of sources) for (const o of s.obs) edge(`src:${s.id}`, o, hotSrc.has(`src:${s.id}`) && hot.has(o));
  for (const n of nodes) for (const p of n.parents) edge(p, n.id, hot.has(p) && hot.has(n.id));

  const color = (c) => getComputedStyle(document.documentElement).getPropertyValue(`--${c}`).trim();
  for (const s of sources) {
    const p = pos.get(`src:${s.id}`);
    const grp = svg('g', { class: `node${highlightSeq !== null && !hotSrc.has(`src:${s.id}`) ? ' dim' : ''}`, transform: `translate(${p.x},${p.y})` });
    grp.append(svg('rect', { width: NODE_W, height: 36, rx: 18, fill: 'transparent', stroke: color('muted'), 'stroke-dasharray': '3 3' }));
    const t = svg('text', { x: 12, y: 15 });
    t.textContent = `◆ object ${short(s.id, 12)}`;
    const t2 = svg('text', { x: 12, y: 29, class: 'sub' });
    t2.textContent = short(s.type?.split('::').slice(-1)[0] ?? '', 24);
    grp.append(t, t2);
    g.append(grp);
  }
  for (const n of nodes) {
    const p = pos.get(n.id);
    const isSel = selected === n.id;
    const dim = highlightSeq !== null && !hot.has(n.id);
    const grp = svg('g', { class: `node${dim ? ' dim' : ''}${isSel ? ' sel' : ''}`, transform: `translate(${p.x},${p.y})` });
    const stroke = n.quarantined ? color('q') : color(n.cls);
    const fill = `color-mix(in srgb, ${color(n.cls)} 16%, transparent)`;
    if (n.kind === 'decision') {
      grp.append(svg('polygon', { points: `0,18 14,0 ${NODE_W - 14},0 ${NODE_W},18 ${NODE_W - 14},36 14,36`, fill, stroke, ...(n.quarantined ? { 'stroke-dasharray': '5 3' } : {}) }));
    } else {
      grp.append(svg('rect', { width: NODE_W, height: 36, rx: 6, fill, stroke, ...(n.quarantined ? { 'stroke-dasharray': '5 3' } : {}) }));
    }
    const verdict = n.kind === 'decision' ? (/Payment decision: (\w+)( \w+)?/.exec(n.text)?.slice(1).join('') ?? '') : '';
    const t = svg('text', { x: 10, y: 15 });
    t.textContent = short(`${n.kind}${verdict ? ' · ' + verdict.trim() : ''}`, 30);
    const t2 = svg('text', { x: 10, y: 29, class: 'sub' });
    t2.textContent = `${n.lane} · ${n.cls}${n.quarantined ? ' · excluded' : n.unresolved ? ' · unresolved' : ''}`;
    grp.append(t, t2);
    grp.addEventListener('click', () => {
      selected = n.id;
      renderDetail(n);
      renderGraph();
    });
    g.append(grp);
  }
}

function renderDetail(n) {
  const d = $('node-detail');
  d.className = 'detail';
  d.replaceChildren(
    el('div', {}, el('strong', {}, `${n.kind} `), `${n.lane} lane · class `, el('span', { class: `lbl ${n.cls}` }, n.cls), n.quarantined ? el('span', { class: 'err' }, ` · quarantined by ledger #${n.seedHits.join(', #')}`) : ''),
    el('div', { class: 'muted' }, 'envelope ', el('code', {}, n.id), ' · blob ', el('code', {}, n.blobIds[0] ?? '')),
    el('div', { class: 'muted' }, `parents (runtime-assigned): ${n.parents.length ? n.parents.map((p) => short(p, 13)).join(', ') : '∅'} · checkpoint ${n.ckpt}`),
    ...(n.notes.length ? [el('div', { class: 'muted' }, n.notes.join(' · '))] : []),
    el('pre', {}, n.text),
    ...(n.lane === 'wallet-objects' || n.kind !== 'decision'
      ? [el('button', { class: 'ghost', onclick: () => quarantine('memory', n.id) }, 'Quarantine this memory')]
      : []),
  );
}

// ---- side panels ------------------------------------------------------------

function renderIncidents() {
  const list = state.incidents;
  $('incidents').replaceChildren(
    ...(list.length === 0 ? [el('div', { class: 'muted small' }, 'No incidents. Run antibody ingest scan.')] : []),
    ...list.map((i) =>
      el(
        'div',
        { class: 'inc' },
        el('span', { class: `st ${i.status}` }, i.status),
        ` score ${i.score} · object `,
        el('code', {}, short(i.objectId, 14)),
        el('div', { class: 'muted' }, i.rules.join(' · ')),
        ...(i.lessonMatches.length ? [el('div', {}, `learned: matches lesson ${[...new Set(i.lessonMatches.map((m) => '#' + m.lessonSeq))].join(', ')} (${i.lessonMatches.map((m) => m.indicator).join(', ')})`)] : []),
        i.status === 'open' ? el('button', { onclick: () => quarantine('source', i.objectId) }, 'Quarantine source') : el('span', { class: 'small' }, i.quarantineSeq !== undefined ? ` → ledger #${i.quarantineSeq}` : ''),
        i.report ? el('div', { class: 'small' }, 'report ', el('a', { href: i.report.url, target: '_blank', rel: 'noopener' }, short(i.report.blobId, 16))) : '',
      ),
    ),
  );
}

function renderLedger() {
  const l = state.ledger;
  if (!l.ok) {
    $('ledger').replaceChildren(el('div', { class: 'err' }, `${l.code}: ${l.detail}`), el('div', {}, 'Fail closed: every payment is blocked.'));
    return;
  }
  const rows = l.records.map((r) => {
    const p = r.payload;
    const what =
      r.type === 'payee.add' ? `${p.label} → ${short(p.address, 12)}` :
      r.type === 'quarantine' ? `${p.seed.type} ${short(p.seed.value, 12)}${p.auto ? ' (auto)' : ''}` :
      r.type === 'lesson' ? `from #${p.fromSeq}` :
      r.type === 'quarantine.release' ? `releases #${p.quarantineSeq}` :
      r.type.startsWith('lane.') ? `${p.label}` : r.type === 'payee.remove' ? p.payeeId : '';
    return el('tr', {}, el('td', {}, `#${r.seq}`), el('td', {}, r.type), el('td', { class: 'muted' }, r.lane), el('td', {}, what), el('td', {}, ...(r.type === 'quarantine' ? [el('button', { class: 'ghost', onclick: () => report(r.seq) }, 'report')] : [])));
  });
  $('ledger').replaceChildren(
    el('div', { class: 'small muted' }, `head #${l.head.seq} `, el('code', {}, short(l.head.hash, 16)), l.firstSync ? ' · first sync' : ''),
    el('table', {}, el('tr', {}, el('th', {}, 'seq'), el('th', {}, 'type'), el('th', {}, 'signer'), el('th', {}, ''), el('th', {}, '')), ...rows),
  );
  const sel = $('seed-select');
  const cur = sel.value;
  sel.replaceChildren(el('option', { value: '' }, 'highlight: none'), ...l.quarantines.filter((q) => !q.released).map((q) => el('option', { value: String(q.seq) }, `quarantine #${q.seq} (${q.seed.type})`)));
  sel.value = cur;
}

function renderLearning() {
  const l = state.ledger;
  if (!l.ok) return;
  $('lessons').replaceChildren(
    ...(l.lessons.length === 0 ? [el('div', { class: 'muted small' }, 'Nothing yet. Confirm a quarantine and the sentinel learns from it.')] : []),
    ...l.lessons.map((x) =>
      el(
        'div',
        { class: 'inc' },
        el('strong', {}, `lesson #${x.seq}`),
        ` from quarantine #${x.fromSeq} `,
        el('span', { class: x.active ? 'status active' : 'status revoked' }, x.active ? 'active' : 'retired'),
        el('div', { class: 'muted' }, `senders ${x.indicators.senders.map((s) => short(s, 10)).join(', ') || '—'} · packages ${x.indicators.packages.length} · keywords ${x.indicators.keywords.slice(0, 8).join(' ')}`),
      ),
    ),
  );
  $('payees').replaceChildren(
    el('table', {}, el('tr', {}, el('th', {}, 'payee'), el('th', {}, 'address'), el('th', {}, 'cap (base)')), ...l.payees.map((p) => el('tr', {}, el('td', {}, p.label), el('td', {}, el('code', {}, short(p.address, 14))), el('td', {}, p.capPerTx)))),
  );
}

function renderForensic() {
  const ex = state.nodes.filter((n) => !n.eligible);
  $('forensic').replaceChildren(
    ...(ex.length === 0 && state.failed.length === 0 ? [el('div', { class: 'muted small' }, 'Nothing excluded.')] : []),
    ...ex.map((n) => el('div', { class: 'inc' }, el('span', { class: 'st quarantined' }, n.quarantined ? `quarantined #${n.seedHits.join(',#')}` : n.unresolved ? 'unresolved' : n.cls), ` ${n.lane}/${n.kind} `, el('code', {}, short(n.id, 13)), el('div', { class: 'muted' }, n.text.split('\n').join(' ⏎ ').slice(0, 300)))),
    ...state.failed.map((f) => el('div', { class: 'inc' }, el('span', { class: 'st quarantined' }, f.code), ` blob `, el('code', {}, short(f.blobId, 14)), el('div', { class: 'muted' }, f.reason))),
  );
}

// ---- actions ----------------------------------------------------------------

async function quarantine(type, value) {
  try {
    const pv = await api('/api/preview', { type, value });
    if (!confirm(`Quarantine ${type} ${value}?\n\n${pv.memories - pv.decisions} memories and ${pv.decisions} decisions leave Steward's context. They stay on Walrus as evidence.`)) return;
    const r = await api('/api/quarantine', { type, value, reason: 'quarantined from the web view' });
    highlightSeq = r.seq;
    await refresh();
    $('seed-select').value = String(r.seq);
  } catch (e) {
    alert(e.message);
  }
}

async function report(seq) {
  try {
    const r = await api('/api/report', { seq });
    alert(`Incident report ${r.simulated ? '(SIMULATED, local) ' : ''}published\nblob ${r.blobId}\n${r.url}`);
    await refresh();
  } catch (e) {
    alert(e.message);
  }
}

async function refresh() {
  state = await api('/api/state');
  renderBanners();
  renderDigests();
  renderLanes();
  renderLedger();
  renderGraph();
  renderIncidents();
  renderLearning();
  renderForensic();
  $('footer').textContent = `backend ${state.backend} · chain ${state.chain} · ${state.nodes.length} memories · coverage ${state.coverage.retrieved}/${state.coverage.inventory}`;
}

$('run-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const b = $('btn-run');
  b.disabled = true;
  b.textContent = 'Running…';
  try {
    renderRun(await api('/api/run', { instruction: $('instruction').value, execute: $('execute').checked }));
    await refresh();
  } catch (err) {
    alert(err.message);
  } finally {
    b.disabled = false;
    b.textContent = 'Run';
  }
});

$('btn-rebuild').addEventListener('click', async () => {
  const b = $('btn-rebuild');
  b.disabled = true;
  b.textContent = 'Rebuilding…';
  try {
    const r = await api('/api/rebuild', {});
    rebuildDigest = r.digest ?? null;
    if (!r.digest) alert(r.error ?? 'rebuild failed');
    renderDigests();
  } catch (e) {
    alert(e.message);
  } finally {
    b.disabled = false;
    b.textContent = 'Rebuild --fresh';
  }
});

$('q-form').addEventListener('submit', (e) => {
  e.preventDefault();
  quarantine($('q-type').value, $('q-value').value.trim());
});

$('seed-select').addEventListener('change', (e) => {
  highlightSeq = e.target.value === '' ? null : Number(e.target.value);
  renderGraph();
});

$('btn-revoke').addEventListener('click', () => $('revoke-help').classList.toggle('hidden'));

refresh().catch((e) => {
  document.body.prepend(el('div', { class: 'err' }, `Cannot load state: ${e.message}`));
});
setInterval(() => refresh().catch(() => {}), 15000);
