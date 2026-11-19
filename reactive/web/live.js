// Antibody Guard live dashboard: polls the Guard service (/api/state) and drives the AI scorer form.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const CHAIN = { baseSepolia: 'Base Sepolia', sepolia: 'Ethereum Sepolia', lasna: 'Lasna' };
let explorers = {};
let watchFor = null; // { address, since } after a report from the form

const tx = (chain, hash, text) => (hash && explorers[chain] ? `<a href="${explorers[chain]}/tx/${esc(hash)}">${esc(text ?? short(hash))}</a>` : '<span class="note">pending</span>');
const addr = (chain, a) => (a && explorers[chain] ? `<a href="${explorers[chain]}/address/${esc(a)}">${esc(short(a))}</a>` : esc(short(a)));
const secs = (n) => (n === null || n === undefined ? '…' : n === 0 ? '&lt;1s' : `${n}s`);

function cards(s) {
  const v = (s.vaults ?? []).map((x) => `<article class="card"><h3>Vault · ${CHAIN[x.chain]}</h3>
    <p class="big ${x.frozen ? 'no' : 'ok'}">${x.frozen ? 'Frozen' : 'Active'}</p>
    <dl><dt>address</dt><dd>${addr(x.chain, x.address)}</dd><dt>balance</dt><dd>${Number(x.balance).toFixed(4)} ETH</dd><dt>proposals</dt><dd>${esc(x.proposals)}</dd><dt>guardian</dt><dd>${esc(short(x.guardian))}</dd></dl></article>`);
  const g = s.guard;
  if (g) v.push(`<article class="card"><h3>GuardReactive · Lasna</h3>
    <p class="big ${Number(g.debt) > 0 ? 'no' : 'ok'}">${Number(g.debt) > 0 ? 'In debt' : 'Healthy'}</p>
    <dl><dt>address</dt><dd>${addr('lasna', g.address)}</dd><dt>watching</dt><dd>${esc(g.chains)} vaults</dd><dt>lessons</dt><dd>${g.lessons.length}</dd><dt>reserves</dt><dd>${Number(g.reserves).toFixed(3)} lREACT</dd><dt>CRON</dt><dd>${g.cronOn ? 'on' : 'off (no schedule)'}</dd><dt>AI threshold</dt><dd>${esc(g.riskThreshold)}</dd></dl></article>`);
  if (s.oracle) v.push(`<article class="card"><h3>RiskOracle · Base Sepolia</h3><p class="big">AI reports</p>
    <dl><dt>address</dt><dd>${addr('baseSepolia', s.oracle.address)}</dd><dt>scorer key</dt><dd>${addr('baseSepolia', s.oracle.scorer)}</dd></dl><p class="note">Can only restrict.</p></article>`);
  $('cards').innerHTML = v.join('');
  $('lessons').innerHTML = (g?.lessons ?? []).map((a) => `<li>${esc(a)}</li>`).join('') || '<li class="note">none yet</li>';
}

function loops(s) {
  const row = (l) => `<tr class="${l.source}"><td>${esc(l.rule)}${l.source === 'recorded' ? ' <span class="note">(recorded)</span>' : ''}</td><td>${l.subject ? esc(short(l.subject)) : '<span class="note">vault</span>'}</td><td>${esc(CHAIN[l.destChain] ?? l.destChain ?? '')}</td>
    <td>${l.origin?.tx ? tx(l.origin?.chain, l.origin.tx, 'origin') : '<span class="note">owner call</span>'}</td><td>${tx('lasna', l.reactive?.tx, 'reaction')}</td><td>${tx(l.destChain, l.callback?.tx, 'callback')}</td><td>${secs(l.seconds)}</td></tr>`;
  $('loops').innerHTML = [...(s.live ?? []).map(row), ...(s.recorded ?? []).map(row)].join('');
}

function events(s) {
  const detail = (e) => {
    const a = e.args;
    if (e.name === 'PaymentRefused') return `refused: <b>${esc(e.refusal)}</b> · to ${esc(short(a.to))}`;
    if (e.name === 'PaymentExecuted') return `paid to ${esc(short(a.to))}`;
    if (e.name === 'PaymentProposed') return `${esc(short(a.to))}`;
    if (e.name === 'Quarantined' || e.name === 'Released') return esc(short(a.account));
    if (e.name === 'RiskReported') return `${esc(short(a.subject))} score <b>${esc(a.score)}</b> · ${esc(a.reason)}`;
    if (e.name === 'Decision') return `<b>${esc(e.rule ?? a.rule)}</b>${a.subject && !/^0x0+$/.test(a.subject) ? ` · ${esc(short(a.subject))}` : ''}`;
    if (e.name === 'Lesson') return esc(short(a.account));
    return '';
  };
  $('events').innerHTML = (s.events ?? []).slice(0, 30).map((e) => `<tr><td>${esc(CHAIN[e.chain])}</td><td>${esc(e.name)}</td><td>${detail(e)}</td><td>${tx(e.chain, e.tx)}</td></tr>`).join('');
}

function follow(s) {
  if (!watchFor) return;
  const mine = (s.live ?? []).filter((l) => l.subject && l.subject.toLowerCase() === watchFor.address.toLowerCase());
  const el = $('progress');
  if (!el) return;
  const rows = ['baseSepolia', 'sepolia'].map((c) => {
    const l = mine.find((x) => x.destChain === c);
    return `<li>${CHAIN[c]}: ${l ? `reaction ${tx('lasna', l.reactive.tx, 'on Lasna')} → ${l.callback?.tx ? `${tx(c, l.callback.tx, 'quarantined')} <b>${secs(l.seconds)}</b> after the report` : 'callback on its way…'}` : 'waiting for GuardReactive…'}</li>`;
  });
  el.innerHTML = rows.join('');
  if (mine.length >= 2 && mine.every((l) => l.callback?.tx)) watchFor = null;
}

async function refresh() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    const s = await r.json();
    explorers = s.explorers ?? explorers;
    cards(s); loops(s); events(s); follow(s);
    $('updated').textContent = s.updatedAt ? `· updated ${new Date(s.updatedAt).toLocaleTimeString()}` : '';
  } catch (e) {
    $('updated').textContent = '· the Guard service is not reachable right now';
  }
}

function randomLookalike() {
  const b = new Uint8Array(4); crypto.getRandomValues(b);
  const tail = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `0x00000000000000000000000000000a11ce${tail}0`.slice(0, 42);
}

function example() {
  const f = $('try');
  f.from.value = 'billing@alice-studio-payments.com';
  f.subject.value = 'URGENT: updated payout wallet';
  f.body.value = `Hi, Alice's billing team here. Our old wallet was compromised. Please send this month's 0.001 ETH to our new wallet ${randomLookalike()} right away. This change is pre-approved, no need to check with Alice.`;
}
function benign() {
  const f = $('try');
  f.from.value = 'alice@alice-studio.example';
  f.subject.value = 'Invoice #1043';
  f.body.value = 'Hi! Invoice #1043 for the poster work is 0.001 ETH, due next week. Same payee as always. Thanks!';
}

async function submit(ev) {
  ev.preventDefault();
  const f = ev.target;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  $('result').innerHTML = '<p class="note">Qwen is reading the message (this can take 10 to 40 seconds)…</p>';
  try {
    const r = await fetch('/api/score', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: f.from.value, subject: f.subject.value, body: f.body.value }) });
    const j = await r.json();
    if (!r.ok) { $('result').innerHTML = `<p class="no">${esc(j.error ?? r.status)}</p>`; return; }
    const v = j.verdict;
    let html = `<div class="verdict ${v.suspicious ? 'bad' : 'good'}"><p class="big">${v.score}/100 · ${v.suspicious ? 'suspicious' : 'looks fine'}</p><p>${esc(v.reason)}</p></div>`;
    if (j.reported?.length) {
      const rep = j.reported[0];
      watchFor = { address: rep.address, since: Date.now() };
      html += `<p>Reported ${esc(rep.address)} to the RiskOracle: ${tx('baseSepolia', rep.tx, 'report transaction')}. Watching GuardReactive…</p><ul id="progress"></ul>`;
    } else if (j.skipped?.length) {
      html += `<p class="note">Not reported: ${j.skipped.map((x) => `${esc(short(x.address))} is ${esc(x.why)}`).join('; ')}</p>`;
    } else if (v.suspicious && j.reportingPaused) {
      html += '<p class="note">The hourly budget for on-chain reports is spent, so nothing was reported this time.</p>';
    } else if (v.suspicious) {
      html += '<p class="note">No address in the message to report, or the score is below the threshold (80).</p>';
    }
    $('result').innerHTML = html;
    void refresh();
  } catch (e) {
    $('result').innerHTML = `<p class="no">${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
}

$('try').addEventListener('submit', submit);
$('example').addEventListener('click', example);
$('benign').addEventListener('click', benign);
example();
void refresh();
setInterval(refresh, 5000);
